# Agent Note: 将实时语音重建为 DSH 宿主/客户端插件

Status: implemented

[English](2026-08-16-voice-plugin-rebuild.md) | 中文

## 问题

DSH 的实时语音交互最初是临时 Python 旁路加前端 DOM 扫描钩子。DSH 重启即失效，流式不可靠（早期尝试产生碎句或乱序文本），且没有信任边界：`/voice` 路由对任何来源开放，前端在 `localStorage` 里持有 API Key。重建必须保持为 DSH 插件、保留火山二进制帧协议、逐帧流式，且绝不重置或改写用户文件。

## 决策

插件（`@deepseek-ai/dsh-client-ui-voice-live`）为拆分包：

- **宿主侧**：在 DSH 宿主进程内注册 `/voice` WebSocket 升级。一个连接 = 一个 `VoiceSession`；会话把麦克风 PCM 送入火山流式 ASR，把助手回复文本送入火山流式 TTS。升级由 loopback-Host + 同源信任栅栏把关（`isTrustedVoiceRequest`，否则 403）。API Key 只来自 `process.env.VOLCENGINE_API_KEY`；浏览器不持有 Key。
- **客户端侧**：渲染输入框麦克风控件与语音设置区。每个会话独享的 `VoiceController` 状态机（`idle→acquiring→connecting→listening→…`）是全部资源的唯一所有者：`AudioCapture`（MediaStream/AudioContext/AudioWorklet）、`VoiceTransport`（WebSocket + 代次计数）、`PlaybackQueue`。迟到/旧消息按代次与线上 `voiceSessionId` 拒绝。

关键决策：

- **服务端句界**。断句由火山判定，而非客户端 VAD：ASR 请求跑在优化双向流式端点 `bigmodel_async` 且 `enable_nonstream: true`，在 `end_window_size` 静音窗口后输出 definite final。普通 `bigmodel` 只回 partial、不会自行结束（已实测）。低能量麦克风帧原样透传——环境底噪不再掩盖真实静音后服务端 VAD 才能听到静音；每个 definite final 清空当前 utterance，连续多轮可继续。
- **停止 vs 取消**。`stop()` 发送 `asr_end` 并等待最终结果（exactly-once 提交）；`cancel()` 发送 `asr_cancel` 直接丢弃。提交后连接进入*应答模式*保持打开：把助手回复流式逐句合成、只在每个 `tts_done` 完整事件后播放，回合结束且播放空闲（或空闲超时）后关闭。
- **打断（barge-in）**。回复朗读中再次说话：停止播放 → 取消 TTS → 通过 DSH agents 服务取消在途 agent 回合（`ctx.agents.get(SessionId(sessionId)).cancel({ kind: 'user' })`，浏览器在 `config` 帧上报其 DSH 会话 id）→ 使旧代次失效 → 开始新一轮识别。
- **半双工回声姿态**。Chrome AEC3 只消 WebRTC 轨音频，不消 `new Audio()` 播放（Chromium bug 687574），服务端 AEC3（Rust/WebRTC C++）在 macOS 上放弃。循环保持半双工：TTS 播放期间门控麦克风帧（`ttsActive` 硬门控），打断先停播放再开始新识别。`VoiceController.getMicAec()` 报告浏览器实际采纳的 AEC，供受控回声测试（扬声器 vs 耳机、AEC 开关）使用。
- **先响应后思考**。开启时（默认），语音提交后立即回应"好的，我去查一下。"，正式回复在同一串行播放通道排队。
- **韧性**。收听中连接断开自动重连（单重连器、指数退避、最多 5 次）；stop/cancel 不触发重连。"说完不自动发送"的根因就是缺 `bigmodel_async` + `enable_nonstream`——没有它永远不会有 definite final。"回复没有语音朗读"来自 stage 1 重写时丢弃了 DOM 扫描回复读取器；现改为会话 `partial` 输出驱动（只取 text block，跳过 reasoning/工具块），带增量朗读水位。

## 备选方案

- **豆包 RealtimeAPI / 火山实时对话式 AI** — 拒绝（用户决策 B）：它们驱动裸模型，丢失 DSH agent 工具能力；保留 DeepSeek agent 大脑，周围加火山 ASR/TTS。
- **服务端 AEC3**（`webrtc-audio-processing`）— 拒绝：Rust crate 需要 WebRTC C++ 编译，macOS 上放弃。
- **回声语义兜底**与 **VAD 阈值/额外布尔值补丁** — 任务书明确禁止；句界保持服务端所有。
- **DOM 扫描回复读取器** — 重写时弃用，改用会话快照的 `partial` 流。

## 验证

- 包内 130 个 vitest 测试、单文件覆盖率 100%（协议、信任栅栏、控制器状态机、ABA 资源核算、自动断句、重连、先响应后思考、唤醒词、实时字幕、AEC 探针、打断同步停播、错误/防御分支），外加仓库门禁：`test:gui`、全仓 typecheck、`verify-package-invariants`、staged lint、金锭回放（`DSH_SNAPSHOT=replay`）。
- 覆盖率加固暴露并修复了一个协议缺陷（有测试钉住）：TTS 合成失败时原先会在 `tts_error` 之后继续补发 `tts_done`；播放以 done 事件为键，失败现在只发 `tts_error`。`/* v8 ignore */` 注释均带原因，只用于真正不可达的防御代码（旧版 ws 的 RawData 联合、pump 的 shift 守卫、跨行箭头声明的计数问题）。
- 真实火山冒烟：`/voice` 上 TTS 合成；用 macOS `say` 人声 PCM 验证自动断句——不发 `asr_end` 也会在静音约 1.5 秒后收到 definite final。
- 已知限制：本包 `*.host.spec.ts` 测试被排除在仓库 host aggregate 的 typecheck 之外（host aggregate 排除 `packages/client/*/src/**` 触发 TS6307）；它们在 vitest 下运行，宿主半部经包级 `tsc -b` 构建。node 环境的唤醒词测试放在 `*.client.spec.ts` 后缀下，使其归入 client aggregate 类型检查。

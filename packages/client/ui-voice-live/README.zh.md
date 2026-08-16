# @deepseek-ai/dsh-client-ui-voice-live

[English](README.md) | 中文

DSH 的实时语音交互：按下输入框麦克风即可说话，助手用语音朗读回答。本包分两半：

- **宿主侧**：在 DSH 宿主进程内注册 `/voice` WebSocket 升级路由。一个连接承载一个会话：麦克风 PCM 送入火山流式 ASR（bigmodel_async + 服务端 VAD 断句），助手回复文本送入火山流式 TTS（seed-tts-2.0）。升级由 loopback-Host + 同源信任栅栏把关；每个异步操作有唯一生命周期所有者，音频走有界队列，TTS 为单一串行 worker。
- **客户端侧**：渲染输入框麦克风控件（`conversation.input.left`）与语音设置区（`settings.section`）。每个会话独享的 `VoiceController` 状态机拥有全部资源——`AudioCapture`（MediaStream/AudioContext/AudioWorklet）、`VoiceTransport`（WebSocket）、`PlaybackQueue`（播放）——并按代次拒绝迟到/旧消息。

API Key 由宿主的 `process.env.VOLCENGINE_API_KEY` 提供；浏览器不持有、不传输任何 Key。

## 交互模型

- 点麦克风开始。激活时按钮显示科技感圆球与扩散波纹；识别文本增量进入输入框草稿。
- 句界由服务端判定：静音约 1.5 秒后自动产出 definite final 并提交，**无需按停止**。`stop()` 仍是"发送结束并等待最终结果"，`cancel()` 直接丢弃。
- 提交后连接进入*应答模式*保持打开：助手流式回复逐句合成，只在收到其 `tts_done` 完整事件后播放。开启**先响应后思考**（默认开）时，语音会先回一句"好的，我去查一下。"，再排队朗读正式回复。
- 回复朗读中再次说话会**打断**：停止播放 → 取消 TTS → 通过 DSH agents 服务取消在途 agent 回合 → 使旧消息 ID 失效 → 开始新一轮识别。
- 收听中连接断开自动重连（单重连器、指数退避、最多 5 次）。

## 设置

语音设置区可挑选音色（30 个实测可用的火山音色）、试听、切换"先响应后思考"。试听走同一 `/voice` 路由，由完成事件驱动（无固定 sleep）。

## 协议（浏览器 ↔ 宿主，单 WebSocket）

- 浏览器 → 宿主：二进制 = 16kHz Int16 单声道麦克风 PCM；控制帧 `config`（provider/voice/dshSessionId）、`asr_start`、`asr_end`、`asr_cancel`、`tts_push`、`tts_flush`、`tts_cancel`。
- 宿主 → 浏览器：`ready`、`asr_partial`/`asr_final`（带 voiceSessionId、utteranceId、sequence）、`tts_start` + 二进制音频 + `tts_done`、`tts_error`、`tts_idle`、`error`。
- 携带 `voiceSessionId` 的控制帧必须属于本会话；超大帧与畸形 JSON 直接丢弃；伪造 Host 返回 403。

## Model Experience

### Voice path

#### What the model sees

无：麦克风流送往火山 ASR、助手回复文本送往火山 TTS（经宿主 `/voice` 路由），两类请求都不组装、追加或改写任何 LLM 提示词（助手回合是 DSH 普通 agent 循环）。

#### Token effect

无：本包不组装也不发送任何模型请求，故不计 token；任何计量完全属于服务该提示词的 agent 循环。

#### KV Cache effect

无；本包既不组装也不发送任何 provider 请求。

## Known Limitations and Deferred Work

- **唤醒词**以 Web Speech API 实现（Chrome/Safari、zh-CN、识别文本包含唤醒词即触发），默认关闭（持续占用麦克风）。两个约束如实记录、不遮掩：
  - Chrome 的 Web Speech 识别走 Google 云端识别服务，国内网络不可达——设置里的「检测唤醒可用性」探针会显示具体 `onerror` 原因（如 `network`），不再静默失败；macOS 上可用浏览器是 Safari（Apple 服务）。
  - 首选本地离线引擎 sherpa-onnx WASM 关键词检测被上游阻断：`sherpa-onnx-wasm` npm 包已删除（npm/jsdelivr/unpkg/npmmirror 均 404），当前 GitHub release 资产均为专用构建、wasm 内无 KWS 内核（已核实无 `sherpa_onnx_*_kws` 符号）。vosk-browser 作为备选评估过，但其固定中文词表无法约束「小戴」这类自定义词。`WakeWordDetector` 接口保留未来本地 WASM 引擎的接入缝（待有可用分发）。
- **回声消除**依赖浏览器对 WebRTC 麦克风轨的 AEC（Chrome AEC3）。`VoiceController.getMicAec()` 可读取浏览器实际采纳值。`new Audio()` 播放不在 Chrome AEC 覆盖内（Chromium bug 687574），因此循环保持半双工：TTS 播放期间门控麦克风帧，打断先停播放再开始新识别。受控回声测试（扬声器 vs 耳机、AEC 开关）步骤见交付说明；运行时决策为半双工 + 打断。
- **实时字幕**以输入框增量草稿呈现（asr_partial）；暂无悬浮字幕层。
- 服务端断句依赖火山优化双向流式端点（`bigmodel_async` + `enable_nonstream`）；普通 `bigmodel` 流只回 partial、不会自行结束。
- 本包 `*.host.spec.ts` 测试被排除在仓库 host aggregate 的 typecheck 之外（host aggregate 排除 `packages/client/*/src/**` 触发 TS6307）；它们在 vitest 下运行，宿主半部经包级 `tsc -b` 构建。

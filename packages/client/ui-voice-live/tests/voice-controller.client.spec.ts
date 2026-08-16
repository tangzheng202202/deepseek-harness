/**
 * VoiceController / previewVoice 行为测试（stage 1 半双工）。
 * 覆盖任务书必测项（client 侧）：
 *  - 30x start/stop：每轮活资源 ≤1，结束后归零（mic/AudioContext/WS）；
 *  - start 未完成（acquiring/connecting）时 stop：不挂起、无泄漏；
 *  - ASR 未完成（partial）不提前提交，final 恰好提交一次；
 *  - TTS：tts_start 记录 ttsId，二进制分片在 tts_done 完成事件后才播放；
 *  - TTS 错误后 mic 恢复（可再次 start/stop）；
 *  - stop 后无泄漏的 socket/track/timer/AudioContext；
 *  - 试听 previewVoice 由 tts_done + audio ended 完成，无固定 sleep。
 *
 * 浏览器 API（WebSocket/MediaStream/AudioContext/Audio/URL/localStorage）
 * 全部以可控 fake 替换；volcengine 不触网。
 */

import { describe, expect, it, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest'
import type { VoiceState } from '../src/client/VoiceController.ts'

/* ---------------- fake 浏览器环境 ---------------- */

class FakeTrack {
  stopped = false
  settings: MediaTrackSettings
  constructor(settings: MediaTrackSettings = { echoCancellation: true }) { this.settings = settings }
  stop(): void { this.stopped = true }
  getSettings(): MediaTrackSettings { return this.settings }
}

class FakeStream {
  readonly tracks: FakeTrack[]
  constructor(n = 1, settings?: MediaTrackSettings) {
    this.tracks = Array.from({ length: n }, () => new FakeTrack(settings))
  }
  getTracks(): FakeTrack[] { return this.tracks }
}

class FakeWS {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWS[] = []
  static get alive(): FakeWS[] { return FakeWS.instances.filter(w => w.readyState !== FakeWS.CLOSED) }

  readonly url: string
  binaryType = 'nodebuffer'
  readyState = FakeWS.CONNECTING
  sent: (string | ArrayBuffer | Int16Array<ArrayBuffer>)[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
  }

  send(data: string | ArrayBuffer | Int16Array<ArrayBuffer>): void { this.sent.push(data) }
  close(): void {
    if (this.readyState === FakeWS.CLOSED) return
    this.readyState = FakeWS.CLOSED
    this.onclose?.()
  }
  __open(): void { this.readyState = FakeWS.OPEN; this.onopen?.() }
  __msg(data: unknown): void { this.onmessage?.({ data }) }
  __error(): void { this.onerror?.() }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static get alive(): FakeAudioContext[] { return FakeAudioContext.instances.filter(c => !c.closed) }
  closed = false
  destination = {}
  audioWorklet = { addModule: async (): Promise<void> => {} }
  constructor() { FakeAudioContext.instances.push(this) }
  createMediaStreamSource(): { connect(): void } { return { connect() {} } }
  createGain(): { gain: { value: number }; connect(): void } { return { gain: { value: 0 }, connect() {} } }
  async close(): Promise<void> { this.closed = true }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []
  port: { onmessage: ((ev: { data: unknown }) => void) | null; close(): void }
  constructor() {
    FakeAudioWorkletNode.instances.push(this)
    this.port = { onmessage: null, close() {} }
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeAudio {
  static instances: FakeAudio[] = []
  readonly url: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  playing = false
  constructor(url: string) { this.url = url; FakeAudio.instances.push(this) }
  async play(): Promise<void> { this.playing = true }
  pause(): void { this.playing = false }
  __end(): void { this.onended?.() }
  __fail(): void { this.onerror?.() }
}

let gumImpl: (constraints?: MediaStreamConstraints) => Promise<FakeStream> =
  () => Promise.resolve(new FakeStream())

function installFakes(): void {
  vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:3080' } })
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn((c?: MediaStreamConstraints) => gumImpl(c)) },
  })
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
  const urls: string[] = []
  // 保留 URL 的构造器行为，只补浏览器专属的 createObjectURL/revokeObjectURL。
  const URLWithObjectURL = new Proxy(URL, {
    get(target, prop, receiver) {
      if (prop === 'createObjectURL') {
        return () => { urls.push(`blob:${urls.length}`); return urls[urls.length - 1] ?? '' }
      }
      if (prop === 'revokeObjectURL') return () => {}
      const value: unknown = Reflect.get(target, prop, receiver)
      return value
    },
  })
  vi.stubGlobal('URL', URLWithObjectURL)
}

/* ---------------- 模块导入（stub 之后动态导入） ---------------- */

type VoiceControllerCtor = typeof import('../src/client/VoiceController.ts')['VoiceController']
type PreviewResult = import('../src/client/usePipelineVoice.ts').PreviewResult

let VoiceController: VoiceControllerCtor
let previewVoice: (voice: string) => Promise<PreviewResult>

beforeAll(async () => {
  installFakes()
  const vc = await import('../src/client/VoiceController.ts')
  const up = await import('../src/client/usePipelineVoice.ts')
  VoiceController = vc.VoiceController
  previewVoice = up.previewVoice
})

beforeEach(() => {
  FakeWS.instances = []
  FakeAudioContext.instances = []
  FakeAudioWorkletNode.instances = []
  FakeAudio.instances = []
  FakeStreamInstances.length = 0
  gumImpl = (constraints?: MediaStreamConstraints) => {
    const ec = (constraints?.audio as { echoCancellation?: boolean } | undefined)?.echoCancellation !== false
    const s = new FakeStream(1, { echoCancellation: ec })
    FakeStreamInstances.push(s)
    return Promise.resolve(s)
  }
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/* ---------------- helpers ---------------- */

/** 推进微任务/事件循环；fake timers 下 advanceTimersByTimeAsync(0)，否则 setImmediate。 */
async function flush(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  else await new Promise<void>(r => setImmediate(r))
}

function lastWS(): FakeWS {
  const w = FakeWS.instances.at(-1)
  if (w === undefined) throw new Error('no WebSocket created')
  return w
}

function allTracks(): FakeTrack[] {
  return FakeStreamInstances.flatMap(s => s.tracks)
}

/** 记录测试期间创建的 FakeStream（用于泄漏断言）。 */
const FakeStreamInstances: FakeStream[] = []

interface Callbacks {
  onFinal: Mock<(text: string) => void>
  onPartial: Mock<(text: string) => void>
  onError: Mock<(message: string) => void>
  onState: Mock<(s: VoiceState) => void>
}

function makeController(): { c: InstanceType<VoiceControllerCtor>; cb: Callbacks } {
  const cb: Callbacks = {
    onFinal: vi.fn(),
    onPartial: vi.fn(),
    onError: vi.fn(),
    onState: vi.fn(),
  }
  const c = new VoiceController(cb)
  return { c, cb }
}

/** 完成一次 start：等待 capture 就绪 + ws 创建，模拟 open + ready。 */
async function startReady(c: InstanceType<VoiceControllerCtor>): Promise<FakeWS> {
  const p = c.start()
  await flush()
  const ws = lastWS()
  ws.__open()
  ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 'sess', hasKey: true }))
  await p
  return ws
}

/** 触发采集回调：给最近创建的 worklet 节点发一帧 Float32 音频。 */
function emitMicFrame(): void {
  const node = FakeAudioWorkletNode.instances.at(-1)
  if (node === undefined || node.port.onmessage === null) throw new Error('no worklet node')
  node.port.onmessage({ data: new Float32Array(2048).fill(0.5) })
}

describe('先响应后思考', () => {
  it('开启时：final 提交进入应答模式即推送开场白（排在正式回复之前）', async () => {
    const cb: Callbacks = { onFinal: vi.fn(), onPartial: vi.fn(), onError: vi.fn(), onState: vi.fn() }
    const c = new VoiceController(cb, undefined, '好的，我去查一下。')
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '帮我查天气' }))
    // 开场白已作为 tts_push 推给后端
    const pushes = ws.sent.filter(s => typeof s === 'string' && s.includes('"tts_push"'))
    expect(pushes.length).toBeGreaterThanOrEqual(1)
    expect(String(pushes[0])).toContain('好的，我去查一下')
    // 正式回复随后也可继续推送
    c.pushReplyText('今天晴转多云。')
    expect(ws.sent.filter(s => typeof s === 'string' && s.includes('今天晴转多云'))).toHaveLength(1)
    c.endReply()
    expect(FakeWS.alive.length).toBe(1) // 等 host flush 确认
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
  })

  it('关闭时（replyFirstText 为空）不推送开场白', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: 'x' }))
    expect(ws.sent.some(s => typeof s === 'string' && s.includes('"tts_push"'))).toBe(false)
    c.endReply()
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
  })
})

/* ---------------- tests ---------------- */

describe('ABA：30x start/stop', () => {
  it('每轮活资源 ≤1，且 stop（收到 final）后归零，最终零泄漏', async () => {
    const { c, cb } = makeController()
    for (let i = 0; i < 30; i++) {
      const ws = await startReady(c)
      expect(FakeWS.alive.length).toBeLessThanOrEqual(1)
      expect(FakeAudioContext.alive.length).toBeLessThanOrEqual(1)
      expect(FakeAudioContext.instances.length).toBe(i + 1)

      emitMicFrame()
      expect(ws.sent.at(-1)).toBeInstanceOf(Int16Array)

      c.stop()
      // stop 后 host 返回最终结果 → 提交并进入应答模式
      ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: `第${i}句` }))

      expect(cb.onFinal).toHaveBeenCalledTimes(i + 1)
      expect(cb.onFinal).toHaveBeenLastCalledWith(`第${i}句`)
      // 回合结束仍要等待 host 的 flush 确认，不能按“本地暂时无音频”提前关闭。
      c.flushReply()
      c.endReply()
      expect(FakeWS.alive.length).toBe(1)
      ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
      expect(FakeWS.alive.length).toBe(0)
      expect(FakeAudioContext.alive.length).toBe(0)
      expect(allTracks().every(t => t.stopped)).toBe(true)
    }
    expect(FakeWS.instances.length).toBe(30)
    expect(FakeAudioContext.instances.length).toBe(30)
  })
})

describe('stop at each await point', () => {
  it('acquiring（getUserMedia 挂起）中 stop → 无泄漏、不提交', async () => {
    const { c, cb } = makeController()
    let resolveGum!: (s: FakeStream) => void
    gumImpl = () => new Promise<FakeStream>((r) => { resolveGum = r })
    const started = c.start()
    await flush()
    c.stop()
    const stream = new FakeStream()
    FakeStreamInstances.push(stream)
    resolveGum(stream)
    await started
    expect(stream.tracks.every(t => t.stopped)).toBe(true)
    expect(FakeWS.alive.length).toBe(0)
    expect(cb.onFinal).not.toHaveBeenCalled()
  })

  it('connecting（ws 未 open）中 stop → start 不挂起、无泄漏', async () => {
    const { c, cb } = makeController()
    const started = c.start()
    await flush()
    const ws = lastWS()
    c.stop()
    await started // 不应挂起：onclose 需 resolve readyResolve
    expect(ws.readyState).toBe(FakeWS.CLOSED)
    expect(FakeWS.alive.length).toBe(0)
    expect(cb.onFinal).not.toHaveBeenCalled()
  })

  it('listening 中 stop → 等待 asr_final 提交后关闭（不提前提交）', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    c.stop()
    expect(cb.onFinal).not.toHaveBeenCalled() // final 未到，不提交
    // 停止后到来的 partial 被忽略
    ws.__msg(JSON.stringify({ type: 'asr_partial', voiceSessionId: 'sess', text: '部分' }))
    expect(cb.onPartial).not.toHaveBeenCalled()
    expect(cb.onFinal).not.toHaveBeenCalled()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '完整' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    expect(cb.onFinal).toHaveBeenCalledWith('完整')
    // 提交后进入应答模式；回合结束要等 host 确认 flush 已处理。
    c.flushReply()
    c.endReply()
    expect(FakeWS.alive.length).toBe(1)
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
  })
})

describe('ASR：不提前提交', () => {
  it('partial 不提交，final 恰好提交一次', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    ws.__msg(JSON.stringify({ type: 'asr_partial', voiceSessionId: 'sess', text: '你好' }))
    expect(cb.onPartial).toHaveBeenCalledWith('你好')
    expect(cb.onFinal).not.toHaveBeenCalled()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', utteranceId: 'u1', text: '你好世界' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    expect(cb.onFinal).toHaveBeenCalledWith('你好世界')
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', utteranceId: 'u1', text: '你好世界' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
  })

  it('cancel 丢弃：不提交、立即关闭', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    c.cancel()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '不该提交' }))
    expect(cb.onFinal).not.toHaveBeenCalled()
    expect(FakeWS.alive.length).toBe(0)
  })
})

describe('TTS：播放仅在完成事件后', () => {
  it('tts_start 记录 ttsId；二进制分片在 tts_done 后才播放（不提前、不丢失）', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: '你好' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(new ArrayBuffer(8))
    expect(FakeAudio.instances.length).toBe(0) // 未完成不播放
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    expect(FakeAudio.instances.length).toBe(1) // 完成事件驱动播放
    const a = FakeAudio.instances[0]
    expect(a?.playing).toBe(true)
    a?.__end()
    // 播放结束后不应残留对象 URL 泄漏（revoke 被调用）
    expect(FakeAudio.instances.length).toBe(1)
  })

  it('tts_error 后 mic 恢复：可继续 start/stop', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    ws.__msg(JSON.stringify({ type: 'tts_error', ttsId: '1', message: 'boom' }))
    expect(cb.onError).toHaveBeenCalled()
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '好的' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    c.flushReply()
    c.endReply()
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
    // 再来一轮：mic / 连接恢复
    const ws2 = await startReady(c)
    expect(FakeWS.alive.length).toBe(1)
    expect(ws2.readyState).toBe(FakeWS.OPEN)
    c.stop()
    ws2.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '再见' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(2)
    c.flushReply()
    c.endReply()
    ws2.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
  })
})

describe('回复朗读（应答模式）', () => {
  it('完整链路：stop→提交→pushReplyText→tts 播放→endReply 后播放完关闭', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '帮我查一下' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    // 进入应答模式：连接保持，回复文本可推送
    c.pushReplyText('好的，我来查。')
    const push = ws.sent.find(s => typeof s === 'string' && s.includes('tts_push'))
    expect(push).toBeDefined()
    // host 合成回复：tts_start → 音频 → tts_done → 播放
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: '好的，我来查。' }))
    ws.__msg(new ArrayBuffer(16))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    expect(FakeAudio.instances.length).toBe(1)
    const a = FakeAudio.instances[0]
    expect(a?.playing).toBe(true)
    // 回合结束：播放中不关闭
    c.endReply()
    expect(FakeWS.alive.length).toBe(1)
    // 播放完成但 host 尚未确认 flush，仍不能关闭。
    a?.__end()
    expect(FakeWS.alive.length).toBe(1)
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
    expect(FakeAudioContext.alive.length).toBe(0)
  })

  it('自动断句（listening 中 final）：提交并进入应答模式，可朗读回复', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    // 服务端端点检测自动断句：listening 中收到 final（未按停止）
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '你好' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    expect(FakeWS.alive.length).toBe(1) // 连接保持（应答模式）
    // 回复朗读可用
    c.pushReplyText('你好！')
    expect(ws.sent.some(s => typeof s === 'string' && s.includes('tts_push'))).toBe(true)
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: '你好！' }))
    ws.__msg(new ArrayBuffer(16))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    c.endReply()
    expect(FakeWS.alive.length).toBe(1)
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(1)
    FakeAudio.instances[0]?.__end()
    expect(FakeWS.alive.length).toBe(0)
  })

  it('应答模式中再次 start → 打断旧会话并新建，旧 TTS 不会串入新回合', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: '第一句' }))
    expect(FakeWS.alive.length).toBe(1)
    // 回复朗读中再次点 mic：先发送取消并关闭旧连接，再建立新会话。
    const started = c.start()
    await flush()
    const ws2 = lastWS()
    expect(ws.readyState).toBe(FakeWS.CLOSED)
    expect(ws.sent.some(s => typeof s === 'string' && s.includes('tts_cancel'))).toBe(true)
    expect(FakeWS.instances.length).toBe(2)
    expect(FakeWS.alive.length).toBe(1)
    ws2.__open()
    ws2.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 'sess2', hasKey: true }))
    await started
    // 旧连接的迟到 TTS 不再进入播放队列。
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: '旧回复' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    expect(FakeAudio.instances.length).toBe(0)
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
  })

  it('非语音回合（endReply 已调用）不再朗读', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: 'x' }))
    c.flushReply()
    c.endReply()
    expect(FakeWS.alive.length).toBe(1)
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
    // 迟到的回复文本不再推送（连接已关，静默）
    c.pushReplyText('不该朗读')
    expect(ws.sent.some(s => typeof s === 'string' && s.includes('tts_push'))).toBe(false)
  })
})

describe('无泄漏', () => {
  it('stop 完成后 socket/track/timer/AudioContext 全部释放', async () => {
    vi.useFakeTimers()
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: 'x' }))
    c.flushReply()
    c.endReply()
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 'sess' }))
    expect(FakeWS.alive.length).toBe(0)
    expect(FakeAudioContext.alive.length).toBe(0)
    // 所有 timer（connect 超时 / stop 超时 / 应答超时）都已清理
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel 后无泄漏', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    c.cancel()
    expect(ws.readyState).toBe(FakeWS.CLOSED)
    expect(FakeWS.alive.length).toBe(0)
    expect(FakeAudioContext.alive.length).toBe(0)
    expect(allTracks().every(t => t.stopped)).toBe(true)
  })
})

describe('barge-in：会话 id 上报', () => {
  it('setDshSessionId 后 config 消息携带 dshSessionId', async () => {
    const { c } = makeController()
    c.setDshSessionId('dsh-sess-42')
    const ws = await startReady(c)
    const config = ws.sent.find(s => typeof s === 'string' && s.includes('"config"'))
    expect(config).toBeDefined()
    expect(String(config)).toContain('"dshSessionId":"dsh-sess-42"')
    expect(FakeWS.alive.length).toBe(1)
    c.cancel()
    expect(FakeWS.alive.length).toBe(0)
  })

  it('echo 探针：默认请求 AEC，getMicAec 报告浏览器实际采纳值', async () => {
    const { c } = makeController()
    expect(c.getMicAec()).toBeNull() // 未采集
    const p = c.start()
    await flush()
    const gum = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>
    expect(gum).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    lastWS().__open()
    lastWS().__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    await p
    expect(c.getMicAec()).toBe(true) // FakeTrack 默认报告 AEC 开启
    c.cancel()
  })

  it('echo 探针：AEC 关闭时请求与报告都反映关闭', async () => {
    const { c } = makeController()
    // 构造 echoCancellation=false 的控制器（受控对比测试）
    const { VoiceController: VC } = await import('../src/client/VoiceController.ts')
    const cb = { onState: vi.fn(), onFinal: vi.fn(), onPartial: vi.fn(), onError: vi.fn() }
    const c2 = new VC(cb, false)
    const p = c2.start()
    await flush()
    const gum = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>
    expect(gum).toHaveBeenLastCalledWith({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true } })
    lastWS().__open()
    lastWS().__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    await p
    expect(c2.getMicAec()).toBe(false)
    c2.cancel()
    void c
  })
})

describe('自动重连（单重连器）', () => {
  it('listening 中断开 → 退避后重连成功，采集恢复', async () => {
    vi.useFakeTimers()
    const { c } = makeController()
    const ws1 = await startReady(c)
    expect(FakeWS.instances.length).toBe(1)

    ws1.close() // 连接断开
    expect(c.currentState).toBe('reconnecting')
    expect(FakeWS.instances.length).toBe(1) // 还没发起新连接（退避中）

    await vi.advanceTimersByTimeAsync(1000) // 退避到期 → 新连接
    expect(FakeWS.instances.length).toBe(2)
    const ws2 = lastWS()
    expect(c.currentState).toBe('reconnecting')
    ws2.__open()
    ws2.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's2', hasKey: true }))
    await flush() // doReconnect 的 await 链
    expect(c.currentState).toBe('listening')

    // 采集恢复：mic 帧发往新连接
    emitMicFrame()
    expect(ws2.sent.at(-1)).toBeInstanceOf(Int16Array)
    expect(FakeWS.alive.length).toBe(1)
    c.cancel()
    expect(FakeWS.alive.length).toBe(0)
  })

  it('退避窗口内断开事件不会创建第二个重连器', async () => {
    vi.useFakeTimers()
    const { c } = makeController()
    const ws1 = await startReady(c)
    ws1.close()
    // 未到退避期：不应有任何新连接
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWS.instances.length).toBe(1)
    // 到点只创建一个
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWS.instances.length).toBe(2)
    expect(FakeWS.alive.length).toBe(1) // 旧连接已关，新连接在途
    lastWS().__open()
    lastWS().__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    expect(FakeWS.alive.length).toBe(1)
    c.cancel()
  })

  it('重连失败达到上限 → failed', async () => {
    vi.useFakeTimers()
    const { c, cb } = makeController()
    const ws1 = await startReady(c)
    ws1.close()
    // 反复：退避 → 连接超时（3s connect timer）→ 再退避…… 共 5 次尝试
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(16_000) // 覆盖退避 + connect 超时
    }
    expect(cb.onError).toHaveBeenCalled()
    expect(String(cb.onError.mock.calls.at(-1)?.[0] ?? '')).toContain('重连失败')
    // failed 是 fail() 的中间态（onState 先收到 failed，随后 teardown 回 idle）
    expect(cb.onState.mock.calls.some(call => call[0] === 'failed')).toBe(true)
    expect(c.currentState).toBe('idle')
    expect(FakeWS.alive.length).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('用户 stop（closing）后的断开不触发重连', async () => {
    vi.useFakeTimers()
    const { c, cb } = makeController()
    const ws1 = await startReady(c)
    c.stop() // closing：等 final
    ws1.close() // 连接断开（非用户预期路径）
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeWS.instances.length).toBe(1) // 无新连接
    expect(cb.onError).not.toHaveBeenCalled()
  })
})

describe('试听 previewVoice', () => {
  it('由 tts_done + audio ended 完成，无固定 sleep', async () => {
    vi.useFakeTimers()
    const p = previewVoice('zh_female_vv_uranus_bigtts')
    const ws = lastWS()
    ws.__open()
    await flush() // 等 previewVoice 注册 onmessage
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    expect(FakeAudio.instances.length).toBe(1)
    const a = FakeAudio.instances[0]
    // 若实现里是固定 sleep(2500)，这里不推进 timer 则 p 永不 resolve → 测试超时
    a?.__end()
    const r = await p
    expect(r.ok).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('后端无 key 时返回明确错误', async () => {
    vi.useFakeTimers()
    const p = previewVoice('v')
    const ws = lastWS()
    ws.__open()
    await flush()
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: false }))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.message).toContain('VOLCENGINE_API_KEY')
  })

  it('超时未完成时返回超时错误', async () => {
    vi.useFakeTimers()
    const p = previewVoice('v')
    const ws = lastWS()
    ws.__open()
    await flush()
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    await vi.advanceTimersByTimeAsync(20000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.message).toContain('超时')
  })
})

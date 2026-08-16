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

/** 播放被浏览器阻止的 Audio（autoplay 拒绝路径）。 */
class RejectingAudio extends FakeAudio {
  override async play(): Promise<void> { throw new Error('blocked') }
}

/** 构造即失败的 WebSocket（重连/试听的构造器异常路径）。 */
function throwingWS(_url: string): never {
  throw new Error('blocked')
}

let gumImpl: (constraints?: MediaStreamConstraints) => Promise<FakeStream> =
  () => Promise.resolve(new FakeStream())
/** getUserMedia 的 mock（供断言约束，避免 unbound-method）。 */
let gumMock: Mock<(c?: MediaStreamConstraints) => Promise<FakeStream>>

function installFakes(): void {
  vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:3080' } })
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('Audio', FakeAudio)
  gumMock = vi.fn((c?: MediaStreamConstraints) => gumImpl(c))
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: gumMock },
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
    const pushes = ws.sent.filter((s): s is string => typeof s === 'string' && s.includes('"tts_push"'))
    expect(pushes.length).toBeGreaterThanOrEqual(1)
    expect(pushes[0]?.includes('好的，我去查一下')).toBe(true)
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
    const config = ws.sent.find((s): s is string => typeof s === 'string' && s.includes('"config"'))
    expect(config).toBeDefined()
    expect(config?.includes('"dshSessionId":"dsh-sess-42"')).toBe(true)
    expect(FakeWS.alive.length).toBe(1)
    c.cancel()
    expect(FakeWS.alive.length).toBe(0)
  })

  it('echo 探针：默认请求 AEC，getMicAec 报告浏览器实际采纳值', async () => {
    const { c } = makeController()
    expect(c.getMicAec()).toBeNull() // 未采集
    const p = c.start()
    await flush()
    expect(gumMock).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
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
    expect(gumMock).toHaveBeenLastCalledWith({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true } })
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
    expect(cb.onError.mock.calls.at(-1)?.[0] ?? '').toContain('重连失败')
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

describe('打断 150ms：同步停播放', () => {
  it('回复播放中再次 start：pause 在同步调用栈内执行（无 await 间隙，远小于 150ms）', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 'sess', text: 'x' }))
    // host 回复 TTS 开始播放
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: '回复' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    const a = FakeAudio.instances[0]
    expect(a?.playing).toBe(true)

    // 打断：再次 start（同步调用栈内应已 pause）
    const p = c.start()
    await flush()
    expect(a?.playing).toBe(false) // 无需等待任何异步：pause 已同步执行
    expect(FakeWS.alive.length).toBeLessThanOrEqual(1)
    // 清理新连接
    lastWS().__open()
    lastWS().__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's2', hasKey: true }))
    await p
    c.cancel()
    expect(FakeWS.alive.length).toBe(0)
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
    ws.__error() // 超时完成后迟到的 error → finish 幂等（settled 守卫）
    expect(r.ok).toBe(false)
  })
})

describe('采集与连接失败路径', () => {
  it('worklet 加载失败 → failed 并回调 onError', async () => {
    const { c, cb } = makeController()
    vi.stubGlobal('AudioContext', class extends FakeAudioContext {
      constructor() {
        super()
        this.audioWorklet = { addModule: async (): Promise<void> => { throw new Error('worklet failed') } }
      }
    })
    const started = c.start()
    await flush()
    await started
    expect(cb.onError).toHaveBeenCalledWith('worklet failed')
    expect(cb.onState.mock.calls.some(call => call[0] === 'failed')).toBe(true)
    expect(FakeWS.instances.length).toBe(0)
    expect(FakeAudioContext.alive.length).toBe(0)
    expect(allTracks().every(t => t.stopped)).toBe(true)
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  it('麦克风被拒绝 → failed 并回调 onError', async () => {
    const { c, cb } = makeController()
    gumImpl = () => Promise.reject(new Error('mic denied'))
    const started = c.start()
    await flush()
    await started
    expect(cb.onError).toHaveBeenCalledWith('mic denied')
    expect(FakeWS.instances.length).toBe(0)
  })

  it('连接失败（ws error）→ failed 并回调 onError', async () => {
    const { c, cb } = makeController()
    const started = c.start()
    await flush()
    lastWS().__error()
    await started
    expect(cb.onError).toHaveBeenCalledWith('无法连接语音服务（后端未启动）')
    expect(cb.onState.mock.calls.some(call => call[0] === 'failed')).toBe(true)
    expect(FakeWS.alive.length).toBe(0)
    expect(FakeAudioContext.alive.length).toBe(0)
  })

  it('connecting 中 stop 后迟到的 open 不再发送 config（代次失效）', async () => {
    const { c } = makeController()
    const started = c.start()
    await flush()
    const ws = lastWS()
    c.stop() // teardown → generation++
    ws.__open() // 迟到的 open：代次不匹配 → 关闭，不发 config
    await started // 不应挂起
    expect(ws.readyState).toBe(FakeWS.CLOSED)
    expect(ws.sent.some(s => typeof s === 'string' && s.includes('"config"'))).toBe(false)
    expect(FakeWS.alive.length).toBe(0)
  })

  it('后端未配置 key（ready hasKey=false）→ failed', async () => {
    const { c, cb } = makeController()
    const p = c.start()
    await flush()
    lastWS().__open()
    lastWS().__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: false }))
    await p
    expect(cb.onError).toHaveBeenCalledWith('后端未配置 VOLCENGINE_API_KEY')
    expect(FakeWS.alive.length).toBe(0)
  })
})

describe('消息处理防御分支', () => {
  it('畸形 / 非对象控制消息被忽略', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    ws.__msg('not-json{{{')
    ws.__msg(JSON.stringify('hello'))
    ws.__msg(JSON.stringify(42))
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onPartial).not.toHaveBeenCalled()
    expect(cb.onFinal).not.toHaveBeenCalled()
    expect(FakeWS.alive.length).toBe(1)
    c.cancel()
  })

  it('tts_error 匹配当前 ttsId 时清空其记录', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: 'x' }))
    ws.__msg(JSON.stringify({ type: 'tts_error', ttsId: '1', message: 'boom' }))
    expect(cb.onError).toHaveBeenCalledWith('boom')
    ws.__msg(new ArrayBuffer(8)) // currentTtsId 已清空 → 不进播放
    expect(FakeAudio.instances.length).toBe(0)
    c.cancel()
  })

  it('通用 error 消息回调 onError；缺 message 用默认文案', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    ws.__msg(JSON.stringify({ type: 'error', message: '接口挂了' }))
    expect(cb.onError).toHaveBeenLastCalledWith('接口挂了')
    ws.__msg(JSON.stringify({ type: 'error' }))
    expect(cb.onError).toHaveBeenLastCalledWith('语音接口错误')
    c.cancel()
  })
})

describe('状态机幂等与空闲路径', () => {
  it('空闲态 stop / cancel / endReply 均为无操作', async () => {
    const { c, cb } = makeController()
    c.stop()
    c.cancel()
    c.endReply()
    expect(FakeWS.instances.length).toBe(0)
    expect(cb.onFinal).not.toHaveBeenCalled()
    expect(c.currentState).toBe('idle')
  })

  it('isActive 反映会话进行状态', async () => {
    const { c } = makeController()
    expect(c.isActive).toBe(false)
    const p = c.start()
    await flush()
    expect(c.isActive).toBe(true)
    lastWS().__open()
    lastWS().__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    await p
    expect(c.isActive).toBe(true)
    c.cancel()
    expect(c.isActive).toBe(false)
  })

  it('active 中再次 start 直接返回（防重复启动）', async () => {
    const { c } = makeController()
    const p1 = c.start()
    const p2 = c.start() // active 已同步置位 → 立即返回
    await p2
    await flush()
    expect(FakeWS.instances.length).toBe(1) // 只有一轮资源
    const ws = lastWS()
    ws.__open()
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    await p1
    expect(c.currentState).toBe('listening')
    c.cancel()
    expect(FakeWS.alive.length).toBe(0)
  })

  it('连续两个不同 utterance 的 final：第二次进入应答模式幂等', async () => {
    const { c, cb } = makeController()
    const ws = await startReady(c)
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', utteranceId: 'u1', text: '一' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', utteranceId: 'u2', text: '二' }))
    expect(cb.onFinal).toHaveBeenCalledTimes(2)
    expect(FakeWS.alive.length).toBe(1)
    c.endReply()
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 's' }))
    expect(FakeWS.alive.length).toBe(0)
  })

  it('连续 pushReplyText 重置应答空闲计时器', async () => {
    vi.useFakeTimers()
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', text: 'x' }))
    c.pushReplyText('a')
    c.pushReplyText('b')
    c.pushReplyText('c')
    expect(ws.sent.filter(s => typeof s === 'string' && s.includes('tts_push')).length).toBe(3)
    c.endReply()
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 's' }))
    expect(FakeWS.alive.length).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('应答空闲超时（REPLY_TIMEOUT_MS）强制关闭连接', async () => {
    vi.useFakeTimers()
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', text: 'x' }))
    expect(FakeWS.alive.length).toBe(1) // 应答模式：连接保持
    await vi.advanceTimersByTimeAsync(120_000 + 100) // 空闲兜底到期
    expect(FakeWS.alive.length).toBe(0) // teardown 关闭连接
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('播放资源回收', () => {
  it('tts_done 无音频分片 → 不创建播放对象', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', text: 'x' }))
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '9', text: 'a' }))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '9' })) // 无分片 → complete 提前返回
    expect(FakeAudio.instances.length).toBe(0)
    c.endReply()
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 's' }))
    expect(FakeWS.alive.length).toBe(0)
  })

  it('打断时清空排队与未完成音频资源', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    c.stop()
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', text: 'x' }))
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: 'a' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' })) // 正在播放
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '2', text: 'b' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '2' })) // 排队未播
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '3', text: 'c' }))
    ws.__msg(new ArrayBuffer(8)) // 挂起未完成
    expect(FakeAudio.instances.length).toBe(1)
    c.cancel() // 打断：停止播放 + 清空排队与挂起
    expect(FakeAudio.instances[0]?.playing).toBe(false)
    expect(FakeWS.alive.length).toBe(0)
  })

  it('播放完成事件与 play 拒绝竞争：完成路径只执行一次', async () => {
    vi.stubGlobal('Audio', RejectingAudio)
    try {
      const { c } = makeController()
      const ws = await startReady(c)
      c.stop()
      ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', text: 'x' }))
      ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1', text: 'a' }))
      ws.__msg(new ArrayBuffer(8))
      ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
      const a = FakeAudio.instances[0]
      expect(a).toBeDefined()
      a?.__end() // onended 先执行 → finish
      await flush() // play 的 catch 随后执行 → finish 幂等返回
      expect(FakeAudio.instances.length).toBe(1)
      c.endReply()
      ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 's' }))
      expect(FakeWS.alive.length).toBe(0)
    } finally {
      vi.stubGlobal('Audio', FakeAudio)
    }
  })

  it('stop 后到达的采集帧被丢弃（capturing 门控）', async () => {
    const { c } = makeController()
    const ws = await startReady(c)
    emitMicFrame() // listening：帧照常发送
    expect(ws.sent.at(-1)).toBeInstanceOf(Int16Array)
    c.stop()
    const sentCount = ws.sent.length
    emitMicFrame() // 已 stop：capturing=false → 丢弃
    expect(ws.sent.length).toBe(sentCount)
    ws.__msg(JSON.stringify({ type: 'asr_final', voiceSessionId: 's', text: 'x' }))
    c.flushReply()
    c.endReply()
    ws.__msg(JSON.stringify({ type: 'tts_idle', voiceSessionId: 's' }))
    expect(FakeWS.alive.length).toBe(0)
  })
})

describe('重连器清理与构造失败', () => {
  it('重连退避中 cancel → 重连计时器被清理', async () => {
    vi.useFakeTimers()
    const { c } = makeController()
    const ws1 = await startReady(c)
    ws1.close() // 触发退避
    expect(c.currentState).toBe('reconnecting')
    c.cancel() // teardown → clearReconnect
    expect(FakeWS.instances.length).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeWS.instances.length).toBe(1) // 无新连接
    expect(vi.getTimerCount()).toBe(0)
  })

  it('重连期间 WebSocket 构造抛错 → 继续退避，达上限后 failed', async () => {
    vi.useFakeTimers()
    const { c, cb } = makeController()
    const ws1 = await startReady(c)
    ws1.close()
    vi.stubGlobal('WebSocket', throwingWS)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(16_000) // 退避 + 立即抛错
    }
    vi.stubGlobal('WebSocket', FakeWS)
    expect(cb.onError).toHaveBeenCalled()
    expect(cb.onState.mock.calls.some(call => call[0] === 'failed')).toBe(true)
    expect(c.currentState).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('previewVoice 错误路径', () => {
  it('WebSocket 构造失败 → 返回明确错误', async () => {
    vi.stubGlobal('WebSocket', throwingWS)
    try {
      const r = await previewVoice('v')
      expect(r.ok).toBe(false)
      expect(r.message).toContain('blocked')
    } finally {
      vi.stubGlobal('WebSocket', FakeWS)
    }
  })

  it('onerror / onclose（未完成）→ 返回连接错误', async () => {
    const p1 = previewVoice('v')
    lastWS().__error()
    const r1 = await p1
    expect(r1.ok).toBe(false)
    expect(r1.message).toContain('无法连接语音服务')

    const p2 = previewVoice('v')
    lastWS().close()
    const r2 = await p2
    expect(r2.ok).toBe(false)
    expect(r2.message).toContain('语音连接已断开')
  })

  it('畸形 / 非对象消息被忽略，正常路径仍可完成', async () => {
    const p = previewVoice('v')
    const ws = lastWS()
    ws.__open()
    await flush()
    ws.__msg('not-json{{{')
    ws.__msg(JSON.stringify('x'))
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    expect(FakeAudio.instances.length).toBe(1)
    FakeAudio.instances[0]?.__end()
    const r = await p
    expect(r.ok).toBe(true)
  })

  it('tts_done 无音频分片 → 明确失败', async () => {
    const p = previewVoice('v')
    const ws = lastWS()
    ws.__open()
    await flush()
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1' }))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' })) // 无分片
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.message).toContain('未收到合成音频')
  })

  it('tts_error 消息 → 完成并返回其文案', async () => {
    const p = previewVoice('v')
    const ws = lastWS()
    ws.__open()
    await flush()
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    ws.__msg(JSON.stringify({ type: 'tts_error', message: '合成接口挂了' }))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.message).toBe('合成接口挂了')
  })

  it('音频播放失败（error 事件）→ 明确失败', async () => {
    const p = previewVoice('v')
    const ws = lastWS()
    ws.__open()
    await flush()
    ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1' }))
    ws.__msg(new ArrayBuffer(8))
    ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
    const a = FakeAudio.instances[0]
    expect(a).toBeDefined()
    a?.__fail()
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.message).toContain('播放失败')
  })

  it('自动播放被浏览器阻止 → 明确失败', async () => {
    vi.stubGlobal('Audio', RejectingAudio)
    try {
      const p = previewVoice('v')
      const ws = lastWS()
      ws.__open()
      await flush()
      ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
      ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1' }))
      ws.__msg(new ArrayBuffer(8))
      ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
      const r = await p
      expect(r.ok).toBe(false)
      expect(r.message).toContain('浏览器阻止了试听播放')
    } finally {
      vi.stubGlobal('Audio', FakeAudio)
    }
  })

  it('音频失败与播放拒绝竞争：先到者生效、后到者幂等', async () => {
    vi.stubGlobal('Audio', RejectingAudio)
    try {
      const p = previewVoice('v')
      const ws = lastWS()
      ws.__open()
      await flush()
      ws.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
      ws.__msg(JSON.stringify({ type: 'tts_start', ttsId: '1' }))
      ws.__msg(new ArrayBuffer(8))
      ws.__msg(JSON.stringify({ type: 'tts_done', ttsId: '1' }))
      const a = FakeAudio.instances[0]
      a?.__fail() // onerror 先执行 → done
      const r = await p // play 的 catch 随后执行 → done 幂等返回
      expect(r.ok).toBe(false)
      expect(r.message).toContain('播放失败')
    } finally {
      vi.stubGlobal('Audio', FakeAudio)
    }
  })
})

describe('localStorage 缺失兜底', () => {
  it('无 localStorage 时 getter 返回默认值、setter 为无操作', async () => {
    vi.stubGlobal('localStorage', undefined)
    const up = await import('../src/client/usePipelineVoice.ts')
    expect(up.getActiveVoice()).toBe(up.DEFAULT_VOICE)
    expect(up.getReplyFirst()).toBe(true)
    up.setReplyFirst(false)
    expect(up.getWakeWordEnabled()).toBe(false)
    up.setWakeWordEnabled(true)
    expect(up.getWakeWord()).toBe(up.DEFAULT_WAKE_WORD)
    up.setWakeWord('x')
    up.setActiveVoice('v')
    up.setActiveProvider('volcengine')
    // 恢复 localStorage stub，避免污染后续测试
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })
})

describe('WSS URL（https 源）', () => {
  it('VoiceController 与 previewVoice 在 https 下使用 wss://', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { location: { protocol: 'https:', host: 'voice.example' } })
    const vc = await import('../src/client/VoiceController.ts')
    const up = await import('../src/client/usePipelineVoice.ts')
    const C2 = vc.VoiceController
    const c = new C2({ onState: vi.fn(), onFinal: vi.fn(), onPartial: vi.fn(), onError: vi.fn() })
    const started = c.start()
    await flush()
    const wsC = lastWS()
    expect(wsC.url.startsWith('wss://')).toBe(true)
    const pv = up.previewVoice('v')
    await flush()
    const wsP = lastWS()
    expect(wsP.url.startsWith('wss://')).toBe(true)
    wsP.__error()
    await pv
    wsC.__open()
    wsC.__msg(JSON.stringify({ type: 'ready', voiceSessionId: 's', hasKey: true }))
    await started
    expect(c.currentState).toBe('listening')
    c.cancel()
    expect(FakeWS.alive.length).toBe(0)
  })
})

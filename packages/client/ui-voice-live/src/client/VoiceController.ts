/**
 * 语音控制器：每个会话独享、React 外部的状态机与资源所有权编排。
 *
 * 状态机：idle → acquiring → connecting → listening → recognizing →
 *         thinking → synthesizing → playing
 *         + interrupting / reconnecting / closing / failed
 *
 * 生命周期（半双工 + 回复朗读）：
 * - start()：acquire mic + 连接 /voice；若上一轮仍在朗读，先打断并新建会话。
 * - stop()：停止采集，发 asr_end 并等待 final；final 提交后进入应答模式
 *   （replyMode）：WebSocket 保持打开，agent 回复文本经 pushReplyText 推给
 *   后端合成、播放；回合结束（endReply）且播放空闲后关闭，超时兜底。
 * - cancel()：丢弃，立即关闭。
 *
 * 资源所有权：
 * - AudioCapture  唯一持有 MediaStream / AudioContext / AudioWorklet。
 * - VoiceTransport 唯一持有 WebSocket、协议序号与（阶段3）重连。
 * - PlaybackQueue 唯一持有音频播放与取消。
 * - VoiceController 持有启动代次，拒绝迟到消息/旧代次。
 */

export type VoiceState =
  | 'idle'
  | 'acquiring'
  | 'connecting'
  | 'listening'
  | 'recognizing'
  | 'thinking'
  | 'synthesizing'
  | 'playing'
  | 'interrupting'
  | 'reconnecting'
  | 'closing'
  | 'failed'

const WS_URL = `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${window.location.host}/voice`

/** AudioWorklet 采集器：每累计 2048 帧（@16k ≈ 128ms）把 Float32 帧发回主线程。 */
const PCM_WORKLET = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(0);
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0]) {
      const chunk = input[0];
      const merged = new Float32Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      if (merged.length >= 2048) {
        this.port.postMessage(merged.slice(0, 2048));
        this.buf = merged.slice(2048);
      } else {
        this.buf = merged;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`

/** 唯一拥有 MediaStream / AudioContext / AudioWorklet。 */
class AudioCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null

  constructor(
    private readonly onAudio: (i16: Int16Array<ArrayBuffer>) => void,
    private readonly echoCancellation = true,
  ) {}

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: this.echoCancellation,
        noiseSuppression: true,
      },
    })
    const ctx = new AudioContext({ sampleRate: 16000 })
    this.stream = stream
    this.ctx = ctx
    let blobUrl: string | null = null
    try {
      const src = ctx.createMediaStreamSource(stream)
      const mute = ctx.createGain()
      mute.gain.value = 0
      mute.connect(ctx.destination)
      blobUrl = URL.createObjectURL(new Blob([PCM_WORKLET], { type: 'application/javascript' }))
      await ctx.audioWorklet.addModule(blobUrl)
      const node = new AudioWorkletNode(ctx, 'pcm-processor')
      node.port.onmessage = (ev) => {
        this.onAudio(toInt16(ev.data as Float32Array))
      }
      src.connect(node)
      node.connect(mute)
      this.node = node
    } catch (error) {
      this.stop()
      throw error
    } finally {
      if (blobUrl !== null) URL.revokeObjectURL(blobUrl)
    }
  }

  /** 回声消除实测探针：读取浏览器实际应用的约束（Chrome AEC3 是否生效）。 */
  getMicSettings(): MediaTrackSettings | null {
    return this.stream?.getTracks()[0]?.getSettings() ?? null
  }

  /** AEC 是否被浏览器实际采纳（getUserMedia 请求了、约束报告也确认了）。 */
  get hasActiveAec(): boolean {
    const s = this.getMicSettings()
    return s?.echoCancellation === true
  }

  stop(): void {
    try { this.node?.port.close() } catch { /* already closed */ }
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((track) => { track.stop() })
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}

function toInt16(f32: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    out[i] = Math.max(-1, Math.min(1, f32[i] ?? 0)) * 0x7fff | 0
  }
  return out
}

/** 唯一拥有音频播放与取消；按 ttsId 成组，收到完整结束事件才播放。 */
class PlaybackQueue {
  private pending = new Map<string, Uint8Array[]>()
  private current: HTMLAudioElement | null = null
  private queue: { url: string }[] = []
  /** 播放队列变空（无正在播放、无排队）时通知；用于应答模式的关闭时机。 */
  onIdle: (() => void) | null = null

  /** 累积一个 ttsId 的音频分片。 */
  pushAudio(ttsId: string, chunk: Uint8Array): void {
    const list = this.pending.get(ttsId) ?? []
    list.push(chunk)
    this.pending.set(ttsId, list)
  }

  /** 收到该 ttsId 的完整结束事件，封装成 blob 入播放队列。 */
  complete(ttsId: string): void {
    const chunks = this.pending.get(ttsId)
    if (chunks === undefined || chunks.length === 0) return
    this.pending.delete(ttsId)
    const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
    this.queue.push({ url: URL.createObjectURL(blob) })
    this.pump()
  }

  /** 丢弃一个失败/取消的合成任务，避免残留分片占用内存。 */
  discard(ttsId: string): void {
    this.pending.delete(ttsId)
  }

  private pump(): void {
    if (this.current !== null || this.queue.length === 0) return
    const item = this.queue.shift()
    /* v8 ignore next -- length>0 时 shift 必有值，此守卫仅防未来类型变更 */
    if (item === undefined) return
    const audio = new Audio(item.url)
    this.current = audio
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(item.url)
      if (this.current === audio) this.current = null
      this.pump()
      this.maybeIdle()
    }
    audio.onended = finish
    audio.onerror = finish
    void audio.play().catch(finish)
  }

  private maybeIdle(): void {
    if (this.current === null && this.queue.length === 0) this.onIdle?.()
  }

  /** 立即停止播放并清空（打断）。 */
  stop(): void {
    if (this.current !== null) {
      this.current.pause()
      this.current.onended = null
      this.current.onerror = null
      this.current = null
    }
    for (const item of this.queue) URL.revokeObjectURL(item.url)
    this.queue = []
    for (const chunks of this.pending.values()) chunks.length = 0
    this.pending.clear()
  }

  get isPlaying(): boolean {
    return this.current !== null || this.queue.length > 0
  }
}

export interface VoiceCallbacks {
  onState: (s: VoiceState) => void
  onFinal: (text: string) => void
  onPartial: (text: string) => void
  onError: (message: string) => void
}

/** 统一控制器：状态机 + 资源编排 + 代次防串扰 + 回复朗读。 */
export class VoiceController {
  private state: VoiceState = 'idle'
  private generation = 0
  private active = false
  private ws: WebSocket | null = null
  private capture: AudioCapture | null = null
  private readonly playback = new PlaybackQueue()
  private voiceSessionId = ''
  private capturing = false
  private currentTtsId = ''
  /** stop 后等待 asr_final 的超时兜底（正常路径收到 final 即提交）。 */
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private readyResolve: ((ok: boolean) => void) | null = null
  /** 应答模式：语音提交后保持连接，用于朗读 agent 回复。 */
  private replyMode = false
  /** 回合结束标记：endReply 后播放空闲即关闭连接。 */
  private replyDone = false
  /** host 已处理完 tts_flush；必须等该确认，不能因本地暂时无音频而提前关连接。 */
  private replyServerIdle = false
  private replyTimer: ReturnType<typeof setTimeout> | null = null
  /** 同一语音会话已经提交的 utterance，抵御重复 final。 */
  private readonly submittedUtterances = new Set<string>()
  /** 当前 DSH 会话 id（随 config 上报，host 端打断时用它取消 agent 回合）。 */
  private dshSessionId = ''
  /** 自动重连（单重连器）：任意时刻至多一个在途尝试/一个退避定时器。 */
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectInFlight = false

  private static readonly STOP_TIMEOUT_MS = 3000
  /** 应答模式空闲兜底：超过该时长无合成活动强制关闭。 */
  private static readonly REPLY_TIMEOUT_MS = 120_000
  /** 重连退避起点（ms），每次失败翻倍直至上限。 */
  private static readonly RECONNECT_BASE_MS = 1000
  /** 单次重连失败上限；超过后进入 failed。 */
  private static readonly MAX_RECONNECT_ATTEMPTS = 5

  constructor(
    private readonly callbacks: VoiceCallbacks,
    private readonly echoCancellation = true,
    /** 「先响应后思考」开场白；非空时每次语音提交后先朗读它，再排 agent 正式回复。 */
    private readonly replyFirstText = '',
  ) {
    this.playback.onIdle = () => { this.maybeFinishReply() }
  }

  get currentState(): VoiceState {
    return this.state
  }

  get isActive(): boolean {
    return this.active
  }

  /** 同步当前 DSH 会话 id（随 config 上报，供 host 端打断时取消 agent）。 */
  setDshSessionId(id: string): void {
    this.dshSessionId = id
  }

  /** 回声消除实测探针：true/false = 浏览器约束报告 AEC 开/关；null = 未采集。 */
  getMicAec(): boolean | null {
    return this.capture?.hasActiveAec ?? null
  }

  private setState(s: VoiceState): void {
    if (this.state !== s) {
      this.state = s
      this.callbacks.onState(s)
    }
  }

  /** 开始语音会话（acquiring → connecting → listening）。朗读中再次开始即打断上一轮。 */
  async start(): Promise<void> {
    if (this.active) return // 防重复 start（ABA 竞态防护由代次处理）
    if (this.replyMode || this.ws !== null) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'tts_cancel', voiceSessionId: this.voiceSessionId }))
      }
      this.teardown()
    }
    const gen = ++this.generation
    this.active = true

    this.setState('acquiring')
    try {
      const capture = new AudioCapture((i16) => {
        // 不绑定启动代次：重连会递增 generation，而采集器应跟随
        // 当前会话（capturing/active 状态已隔离 ABA 竞态）。
        if (!this.capturing || !this.active) return
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(i16)
      }, this.echoCancellation)
      await capture.start()
      if (gen !== this.generation) { capture.stop(); return }
      this.capture = capture
      this.setState('connecting')
      const ok = await this.connect(gen)
      // stop/cancel 已发生（active=false）时静默退出，不报错
      if (!ok) {
        if (gen === this.generation) this.fail('无法连接语音服务（后端未启动）')
        return
      }
      this.setState('listening')
      this.capturing = true
    } catch (e) {
      if (gen === this.generation) this.fail((e as Error).message)
    }
  }

  private connect(gen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS_URL)
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => { ws.close(); resolve(false) }, 3000)
      ws.onopen = () => {
        clearTimeout(timer)
        if (gen !== this.generation) { ws.close(); return } // 已 stop/cancel
        ws.send(JSON.stringify({
          type: 'config',
          provider: 'volcengine',
          voice: localStorage.getItem('dsh-voice') ?? 'zh_female_vv_uranus_bigtts',
          ...(this.dshSessionId !== '' ? { dshSessionId: this.dshSessionId } : {}),
        }))
      }
      ws.onmessage = (event) => { this.onMessage(gen, event) }
      ws.onclose = () => {
        clearTimeout(timer)
        // 连接未完成即关闭：必须 resolve，否则 start 挂起
        this.readyResolve?.(false)
        this.readyResolve = null
        if (gen === this.generation) {
          this.capturing = false
          // 用户 stop/cancel 或正在应答时由 teardown 负责关闭；其余情况自动重连
          if (this.active && this.state !== 'closing') this.scheduleReconnect()
        }
      }
      ws.onerror = () => { clearTimeout(timer); resolve(false) }
      // ready 到来即视为连接成功
      this.ws = ws
      this.readyResolve = resolve
    })
  }

  /* ---- 自动重连（单重连器） ---- */

  private scheduleReconnect(): void {
    if (this.reconnectInFlight || this.reconnectTimer !== null) return // 单重连器
    this.reconnectAttempts++
    const delay = Math.min(
      VoiceController.RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      10_000,
    )
    this.setState('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectInFlight = true
      void this.doReconnect()
    }, delay)
  }

  private async doReconnect(): Promise<void> {
    try {
      const gen = ++this.generation // 旧代次消息失效
      const ok = await this.connect(gen)
      this.reconnectInFlight = false
      if (!ok) {
        if (this.reconnectAttempts >= VoiceController.MAX_RECONNECT_ATTEMPTS) {
          this.fail('语音连接已断开，重连失败')
          return
        }
        this.scheduleReconnect() // 继续退避
        return
      }
      // 重连成功：恢复采集
      this.reconnectAttempts = 0
      this.capturing = true
      this.setState('listening')
    } catch {
      this.reconnectInFlight = false
      if (this.reconnectAttempts >= VoiceController.MAX_RECONNECT_ATTEMPTS) {
        this.fail('语音连接已断开，重连失败')
      } else {
        this.scheduleReconnect()
      }
    }
  }

  private onMessage(gen: number, e: MessageEvent): void {
    if (gen !== this.generation) return // 旧代次消息拒绝
    if (typeof e.data === 'string') {
      let msg: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(e.data)
        if (typeof parsed !== 'object' || parsed === null) return
        msg = parsed as Record<string, unknown>
      } catch {
        return
      }
      if (msg.type === 'ready') {
        this.voiceSessionId = typeof msg.voiceSessionId === 'string' ? msg.voiceSessionId : ''
        if (msg.hasKey === false) {
          this.readyResolve?.(false)
          this.readyResolve = null
          this.fail('后端未配置 VOLCENGINE_API_KEY')
          return
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'asr_start', voiceSessionId: this.voiceSessionId }))
        }
        this.readyResolve?.(true)
        this.readyResolve = null
        return
      }
      // 识别最终结果：无论手动停止还是服务端断句，提交后进入应答模式
      if (msg.type === 'asr_final' && typeof msg.text === 'string') {
        const utteranceId = typeof msg.utteranceId === 'string' ? msg.utteranceId : ''
        if (utteranceId !== '' && this.submittedUtterances.has(utteranceId)) return
        if (utteranceId !== '') this.submittedUtterances.add(utteranceId)
        const text = msg.text
        this.active = false
        this.stopCapture()
        this.clearStopTimer()
        this.setState('thinking')
        this.callbacks.onFinal(text)
        this.enterReplyMode() // 保持连接，等待 agent 回复朗读
        return
      }
      if (this.state === 'closing' || this.state === 'failed') return // 停止后忽略其余消息
      if (msg.type === 'asr_partial' && typeof msg.text === 'string') {
        this.callbacks.onPartial(msg.text)
      } else if (msg.type === 'tts_start') {
        this.currentTtsId = typeof msg.ttsId === 'string' ? msg.ttsId : ''
        this.setState('synthesizing')
      } else if (msg.type === 'tts_done') {
        const ttsId = typeof msg.ttsId === 'string' ? msg.ttsId : ''
        this.playback.complete(ttsId)
        if (this.currentTtsId === ttsId) this.currentTtsId = ''
        this.setState(this.capturing ? 'listening' : 'playing')
      } else if (msg.type === 'tts_error') {
        const ttsId = typeof msg.ttsId === 'string' ? msg.ttsId : ''
        this.playback.discard(ttsId)
        if (this.currentTtsId === ttsId) this.currentTtsId = ''
        this.callbacks.onError(typeof msg.message === 'string' ? msg.message : 'TTS 失败')
      } else if (msg.type === 'tts_idle') {
        this.replyServerIdle = true
        this.maybeFinishReply()
      } else if (msg.type === 'error') {
        this.callbacks.onError(typeof msg.message === 'string' ? msg.message : '语音接口错误')
      }
    } else if (e.data instanceof ArrayBuffer && this.currentTtsId !== '') {
      // 二进制 = TTS 音频分片，按当前 ttsId 累积
      this.playback.pushAudio(this.currentTtsId, new Uint8Array(e.data))
    }
  }

  /** 正常停止：发送音频结束并等待最终结果（stop=await final），提交后进入应答模式。 */
  stop(): void {
    if (!this.active) return
    this.active = false
    this.stopCapture()
    this.setState('closing')
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'asr_end', voiceSessionId: this.voiceSessionId }))
      // 等待 asr_final（提交后进入应答模式）；超时兜底关闭
      this.stopTimer = setTimeout(() => { this.teardown() }, VoiceController.STOP_TIMEOUT_MS)
    } else {
      this.teardown()
    }
  }

  /** 取消：直接丢弃，立即关闭。 */
  cancel(): void {
    if (!this.active && !this.replyMode && this.ws === null && this.capture === null) return
    this.active = false
    this.stopCapture()
    this.setState('closing')
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'asr_cancel', voiceSessionId: this.voiceSessionId }))
      this.ws.send(JSON.stringify({ type: 'tts_cancel', voiceSessionId: this.voiceSessionId }))
    }
    this.teardown() // teardown 内 ++generation，使在途 asr_final 失效（丢弃）
  }

  /* ---- 回复朗读（应答模式） ---- */

  /** 把 agent 回复文本增量推给后端合成（host 端按标点切句、串行合成）。 */
  pushReplyText(text: string): void {
    if (!this.replyMode) return
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.replyServerIdle = false
      this.ws.send(JSON.stringify({ type: 'tts_push', voiceSessionId: this.voiceSessionId, text }))
      this.armReplyTimer()
    }
  }

  /** 回合结束：flush 未合完的尾巴。 */
  flushReply(): void {
    if (this.replyMode && this.ws?.readyState === WebSocket.OPEN) {
      this.replyServerIdle = false
      this.ws.send(JSON.stringify({ type: 'tts_flush', voiceSessionId: this.voiceSessionId }))
    }
  }

  /**
   * 回合结束（组件在 running=false 时调用）：回复已全部推送，
   * 等 host 确认 flush 已处理且本地播放空闲后关闭连接。
   */
  endReply(): void {
    if (!this.replyMode) return
    this.replyDone = true
    this.maybeFinishReply()
  }

  private enterReplyMode(): void {
    if (this.replyMode) return
    this.replyMode = true
    this.replyDone = false
    this.replyServerIdle = false
    this.armReplyTimer()
    // 先响应后思考：先朗读开场白，agent 正式回复随后排队（同一声道串行播放）。
    if (this.replyFirstText !== '') this.pushReplyText(this.replyFirstText)
  }

  private maybeFinishReply(): void {
    if (this.replyMode && this.replyDone && this.replyServerIdle && !this.playback.isPlaying) {
      this.teardown()
    }
  }

  private stopCapture(): void {
    this.capturing = false
    this.capture?.stop()
    this.capture = null
  }

  private armReplyTimer(): void {
    if (this.replyTimer !== null) clearTimeout(this.replyTimer)
    this.replyTimer = setTimeout(() => { this.teardown() }, VoiceController.REPLY_TIMEOUT_MS)
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== null) {
      clearTimeout(this.replyTimer)
      this.replyTimer = null
    }
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
  }

  private teardown(): void {
    this.generation++ // 使所有在途消息失效
    this.clearStopTimer()
    this.clearReplyTimer()
    this.clearReconnect()
    this.replyMode = false
    this.replyDone = false
    this.replyServerIdle = false
    this.active = false
    this.stopCapture()
    this.ws?.close()
    this.ws = null
    this.voiceSessionId = ''
    this.currentTtsId = ''
    this.submittedUtterances.clear()
    this.playback.stop()
    this.setState('idle')
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectInFlight = false
    this.reconnectAttempts = 0
  }

  private fail(message: string): void {
    this.active = false
    this.stopCapture()
    this.setState('failed')
    this.callbacks.onError(message)
    this.teardown()
  }
}

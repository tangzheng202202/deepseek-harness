/**
 * Host-side WebSocket voice endpoint: browser mic PCM -> Volcengine streaming
 * ASR (server-side endpointing), browser reply text -> Volcengine TTS.
 *
 * Protocol (browser <-> this endpoint, one WebSocket):
 *   browser -> host:  binary = 16kHz Int16 mono mic PCM
 *                     {"type":"config","provider","voice"}
 *                     {"type":"asr_end","voiceSessionId"}   normal stop, await final
 *                     {"type":"asr_cancel","voiceSessionId"} discard
 *                     {"type":"tts_push","text"} / {"type":"tts_flush"}
 *   host -> browser:  {"type":"ready","voiceSessionId",...}
 *                     {"type":"asr_partial","voiceSessionId","utteranceId","text","sequence"}
 *                     {"type":"asr_final","voiceSessionId","utteranceId","text","sequence"}
 *                     {"type":"tts_start","ttsId","text"} + binary audio + {"type":"tts_done","ttsId"}
 *                     {"type":"error","message"}
 *
 * Every async operation has a single lifecycle owner; all accept AbortSignal
 * where applicable; ASR audio flows through a bounded queue (no unbounded
 * Buffer.concat); TTS is a single serial worker (at most one output stream).
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { ttsStream } from './volcengine.ts'
import { isTrustedVoiceRequest, rejectWebSocketUpgrade } from './voice-trust.ts'
import { AsrUtterance } from './asr-utterance.ts'

const SENT_RE = /^([^。！？!?.\n]+[。！？!?.\n]+)([\s\S]*)$/

/** 单帧二进制（mic PCM）上限，防异常大帧耗尽内存。 */
const MAX_FRAME_BYTES = 1024 * 1024
/** tts_push 单条文本上限（字符）。 */
const MAX_TEXT_LEN = 10000
/** 同端最大并发语音连接数。 */
const MAX_CONNECTIONS = 8
/** 单连接最长存活时长（ms），到时强制断开。 */
const MAX_SESSION_MS = 60 * 60 * 1000
/** 能量提示阈值（仅用于“检测到声音才启动识别”，不决定句界）。 */
const VOICE_RMS_THRESHOLD = 300

function popSentence(text: string): [string | null, string] {
  const m = text.trimStart().match(SENT_RE)
  if (m) return [(m[1] ?? '').trim(), m[2] ?? '']
  return [null, text]
}

/** 简单 RMS 能量提示：检测到人声能量才启动新一轮识别。 */
function hasVoiceEnergy(pcm: Buffer, threshold = VOICE_RMS_THRESHOLD): boolean {
  const n = Math.floor(pcm.length / 2)
  if (n === 0) return false
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / n) > threshold
}

class VoiceSession {
  readonly voiceSessionId = randomUUID()
  private ttsBuf = ''
  private apiKey: string
  private voice: string
  /** 朗读期硬门控：true 时丢弃麦克风帧，避免外放朗读声被录进去当新指令。 */
  private ttsActive = false
  private currentUt: AsrUtterance | null = null
  private utSeq = 0
  private ttsSeq = 0
  private msgSeq = 0

  constructor(
    private readonly ws: WebSocket,
    defaultApiKey: string,
    defaultVoice: string,
  ) {
    this.apiKey = defaultApiKey
    this.voice = defaultVoice
  }

  applyConfig(data: Record<string, unknown>): void {
    // API key 只由后端环境变量提供，前端不传、后端不读。
    if (typeof data.voice === 'string' && data.voice) this.voice = data.voice
  }

  feedAudio(pcm: Buffer): void {
    if (this.ttsActive) return // 朗读期硬门控
    if (this.currentUt === null) {
      if (!hasVoiceEnergy(pcm)) return // 静音不启动，能量仅作提示
      this.startUtterance()
    }
    this.currentUt?.push(pcm)
  }

  private startUtterance(): void {
    const id = String(++this.utSeq)
    const session = this.voiceSessionId
    const ut = new AsrUtterance(
      this.apiKey,
      id,
      text => this.send({ type: 'asr_final', voiceSessionId: session, utteranceId: id, text, sequence: ++this.msgSeq }),
      text => this.send({ type: 'asr_partial', voiceSessionId: session, utteranceId: id, text, sequence: ++this.msgSeq }),
      (err) => {
        if (this.currentUt === ut) this.currentUt = null
        this.send({ type: 'error', voiceSessionId: session, message: `asr: ${err.message}`, sequence: ++this.msgSeq })
      },
    )
    this.currentUt = ut
    ut.start()
  }

  /** 正常停止：发送音频结束并等待最终结果（exactly-once）。 */
  asrEnd(): void {
    this.currentUt?.end()
    this.currentUt = null
  }

  /** 取消：直接丢弃，不提交结果。 */
  asrCancel(): void {
    this.currentUt?.cancel()
    this.currentUt = null
  }

  /** 单一串行 TTS worker：所有合成请求排队执行，天然保证顺序与并发=1。 */
  private ttsChain: Promise<void> = Promise.resolve()

  pushTts(text: string, voice?: string): void {
    this.ttsBuf += text
    void this.enqueueTts(async () => {
      for (;;) {
        const [sentence, rest] = popSentence(this.ttsBuf)
        if (sentence === null) break
        this.ttsBuf = rest
        await this.speak(sentence, voice || this.voice)
      }
    })
  }

  flushTts(voice?: string): Promise<void> {
    // 读残留也必须排在串行链尾：等前面所有 push 的句子合成完，
    // 再把没被切句的尾巴当一句收尾（否则会与前一个 worker 抢 ttsBuf）。
    return this.enqueueTts(async () => {
      const tail = this.ttsBuf.trim()
      this.ttsBuf = ''
      if (tail) await this.speak(tail, voice || this.voice)
    })
  }

  /** 把一次合成任务挂到串行链尾（前一个失败不阻断后一个）。 */
  private enqueueTts(job: () => Promise<void>): Promise<void> {
    const next = this.ttsChain.then(job, job)
    this.ttsChain = next
    return next
  }

  private async speak(text: string, voice: string): Promise<void> {
    const ttsId = String(++this.ttsSeq)
    this.ttsActive = true
    try {
      this.send({ type: 'tts_start', ttsId, text, sequence: ++this.msgSeq })
      try {
        await ttsStream(text, voice, this.apiKey, (chunk) => {
          if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk)
        })
      } catch (e) {
        this.send({ type: 'tts_error', ttsId, message: `tts: ${(e as Error).message}`, sequence: ++this.msgSeq })
      }
      this.send({ type: 'tts_done', ttsId, sequence: ++this.msgSeq })
    } finally {
      this.ttsActive = false
    }
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }
}

/**
 * Bind a WebSocketServer to the webserver upgrade route and wire one session
 * per connection. Returns the upgrade handler plus its disposer.
 */
export function createVoiceUpgrade(
  defaultApiKey: string,
  defaultVoice: string,
): { handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => void; close: () => void } {
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws) => {
    if (wss.clients.size > MAX_CONNECTIONS) {
      ws.close(1008, 'too many connections')
      return
    }
    const lifetime = setTimeout(() => ws.terminate(), MAX_SESSION_MS)
    ws.on('close', () => clearTimeout(lifetime))
    const session = new VoiceSession(ws, defaultApiKey, defaultVoice)
    ws.send(JSON.stringify({
      type: 'ready',
      voiceSessionId: session.voiceSessionId,
      asr: 'volcano',
      tts: 'volcano',
      voice: defaultVoice,
      hasKey: defaultApiKey.length > 0,
    }))

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // ws v8 delivers BOTH text and binary frames as a Buffer; only the
      // `isBinary` flag distinguishes them. Text frames carry our JSON control
      // messages, binary frames carry mic PCM16.
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer)
      if (isBinary) {
        if (buf.length > MAX_FRAME_BYTES) return // 异常大帧拒绝
        session.feedAudio(buf)
        return
      }
      if (buf.length > 64 * 1024) return // 控制帧超大拒绝
      try {
        const msg = JSON.parse(buf.toString('utf8')) as Record<string, unknown>
        // 迟到/乱序消息拒绝：带 voiceSessionId 的控制消息必须属于本会话。
        // （不带 id 的消息向后兼容放行；config 在 ready 前发出，不校验。）
        const isMySession = (m: Record<string, unknown>): boolean =>
          typeof m.voiceSessionId !== 'string' || m.voiceSessionId === session.voiceSessionId
        switch (msg.type) {
          case 'config': if (isMySession(msg)) session.applyConfig(msg); break
          case 'asr_end': if (isMySession(msg)) session.asrEnd(); break
          case 'asr_cancel': if (isMySession(msg)) session.asrCancel(); break
          case 'tts_push': {
            if (!isMySession(msg)) break
            const text = String(msg.text ?? '')
            if (text.length > MAX_TEXT_LEN) return
            session.pushTts(text, msg.voice as string | undefined)
            break
          }
          case 'tts_flush': if (isMySession(msg)) void session.flushTts(msg.voice as string | undefined); break
          default: break
        }
      } catch {
        /* ignore malformed control frames */
      }
    })
  })

  return {
    handle: (req, socket, head) => {
      if (!isTrustedVoiceRequest(req)) {
        rejectWebSocketUpgrade(socket)
        return
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    },
    close: () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}

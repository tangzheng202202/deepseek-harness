/**
 * Host-side WebSocket voice endpoint: browser mic PCM -> Volcengine ASR, and
 * browser reply text -> Volcengine TTS. Mirrors the Python `voice_server.py`
 * session protocol so the client side needs no protocol change.
 *
 * Wire protocol (browser <-> this endpoint, one WebSocket):
 *   browser -> host:  binary = 16kHz Int16 mono mic PCM
 *                     {"type":"config","provider","voice"}
 *                     {"type":"tts_push","text"}  /  {"type":"tts_flush"}
 *                     {"type":"asr_end"}
 *   host -> browser:  {"type":"ready",...} / {"type":"asr_final","text"}
 *                     {"type":"tts_start","text"} + binary mp3 + {"type":"tts_done"}
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { asrStream, ttsStream } from './volcengine.ts'
import { isTrustedVoiceRequest, rejectWebSocketUpgrade } from './voice-trust.ts'

const SENT_RE = /^([^。！？!?.\n]+[。！？!?.\n]+)([\s\S]*)$/

/** 单段 ASR 音频上限（PCM16 16kHz mono：32000 B/s）。超过则强制断句，防 VAD 永不 end。 */
const MAX_ASR_BYTES = 12 * 32000
/** 单帧二进制（mic PCM）上限，防异常大帧耗尽内存。 */
const MAX_FRAME_BYTES = 1024 * 1024
/** tts_push 单条文本上限（字符）。 */
const MAX_TEXT_LEN = 10000
/** 同端最大并发语音连接数。 */
const MAX_CONNECTIONS = 8
/** 单连接最长存活时长（ms），到时强制断开。 */
const MAX_SESSION_MS = 60 * 60 * 1000

function popSentence(text: string): [string | null, string] {
  const m = text.trimStart().match(SENT_RE)
  if (m) return [(m[1] ?? '').trim(), m[2] ?? '']
  return [null, text]
}

/** Trim leading/trailing near-silence from PCM16 (single-sample abs threshold). */
function trimSilence(pcm: Buffer, threshold = 300): Buffer {
  const n = Math.floor(pcm.length / 2)
  let start = 0
  let end = n
  while (start < end && Math.abs(pcm.readInt16LE(start * 2)) < threshold) start += 1
  while (end > start && Math.abs(pcm.readInt16LE((end - 1) * 2)) < threshold) end -= 1
  return pcm.subarray(start * 2, end * 2)
}

/** RMS-energy endpoint detection (mirrors Python EnergyVAD). */
class EnergyVAD {
  private lastVoice = 0
  private started = false
  constructor(
    private readonly threshold = 300,
    private readonly maxSilence = 1.0,
  ) {}

  feed(pcm: Buffer, now = Date.now() / 1000): string {
    const n = Math.floor(pcm.length / 2)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const s = pcm.readInt16LE(i * 2)
      sum += s * s
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0
    if (rms > this.threshold) {
      this.lastVoice = now
      if (!this.started) {
        this.started = true
        return 'start'
      }
      return 'continue'
    }
    if (this.started && now - this.lastVoice > this.maxSilence) {
      this.started = false
      return 'end'
    }
    return 'silence'
  }
}

class VoiceSession {
  private asrBuf = Buffer.alloc(0)
  private ttsBuf = ''
  private vad = new EnergyVAD()
  private apiKey: string
  private voice: string
  /** 朗读期硬门控：true 时丢弃麦克风帧，避免外放朗读声被录进去当新指令。 */
  private ttsActive = false
  /** 识别串行化：一次只跑一段 ASR，防并发导致结果乱序。 */
  private asrBusy = false
  private asrQueued = false

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
    if (this.ttsActive) return // 朗读期硬门控：丢弃外放回声
    this.asrBuf = Buffer.concat([this.asrBuf, pcm])
    if (this.asrBuf.length >= MAX_ASR_BYTES) {
      this.scheduleAsr() // maxDuration 强制断句
      return
    }
    const evt = this.vad.feed(pcm)
    if (evt === 'end') this.scheduleAsr()
  }

  /** 串行化入口：busy 时排队，保证识别结果按说话顺序返回。 */
  private scheduleAsr(): void {
    if (this.asrBusy) {
      this.asrQueued = true
      return
    }
    void this.finalizeAsr()
  }

  async finalizeAsr(): Promise<void> {
    this.asrBusy = true
    try {
      if (!this.asrBuf.length) return
      const raw = this.asrBuf
      this.asrBuf = Buffer.alloc(0)
      const pcm = trimSilence(raw)
      // eslint-disable-next-line no-console
      console.error(`[voice] asr input: raw=${raw.length}B trimmed=${pcm.length}B (~${(pcm.length / 32000).toFixed(2)}s)`)
      if (pcm.length < 3200) return
      try {
        await asrStream(pcm, this.apiKey, (r) => {
          if (r.is_final && r.text.trim()) {
            // eslint-disable-next-line no-console
            console.error('[voice] asr final:', r.text)
            this.send({ type: 'asr_final', text: r.text.trim() })
          }
        })
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[voice] asr error:', (e as Error).message)
        this.send({ type: 'error', message: `asr: ${(e as Error).message}` })
      }
    } finally {
      this.asrBusy = false
      // 排队中的音频或识别期间新到的音频，继续按顺序处理。
      if (this.asrQueued || this.asrBuf.length > 0) {
        this.asrQueued = false
        void this.finalizeAsr()
      }
    }
  }

  pushTts(text: string, voice?: string): void {
    this.ttsBuf += text
    void this.drainTts(voice)
  }

  private async drainTts(voice?: string): Promise<void> {
    const v = voice || this.voice
    for (;;) {
      const [sentence, rest] = popSentence(this.ttsBuf)
      if (sentence === null) break
      this.ttsBuf = rest
      await this.speak(sentence, v)
    }
  }

  async flushTts(voice?: string): Promise<void> {
    const tail = this.ttsBuf.trim()
    this.ttsBuf = ''
    if (tail) await this.speak(tail, voice || this.voice)
  }

  private async speak(text: string, voice: string): Promise<void> {
    this.ttsActive = true
    try {
      this.send({ type: 'tts_start', text })
      try {
        await ttsStream(text, voice, this.apiKey, (chunk) => {
          if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk)
        })
      } catch (e) {
        this.send({ type: 'error', message: `tts: ${(e as Error).message}` })
      }
      this.send({ type: 'tts_done' })
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
        switch (msg.type) {
          case 'config': session.applyConfig(msg); break
          case 'tts_push': {
            const text = String(msg.text ?? '')
            if (text.length > MAX_TEXT_LEN) return
            session.pushTts(text, msg.voice as string | undefined)
            break
          }
          case 'tts_flush': void session.flushTts(msg.voice as string | undefined); break
          case 'asr_end': void session.finalizeAsr(); break
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

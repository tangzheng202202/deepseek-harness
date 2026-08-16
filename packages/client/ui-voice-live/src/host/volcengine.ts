/**
 * Volcengine (Doubao) streaming TTS + ASR client for Node.js.
 *
 * A faithful port of the binary WebSocket protocol from the Python
 * `doubao_speech._ws_client` reference implementation:
 *
 *   voice-pipeline/.venv/lib/python3.14/site-packages/doubao_speech/_ws_client.py
 *
 * Only two differences from the Python client:
 *   1. Auth uses the single `X-Api-Key` header form (new API key) instead of
 *      the multi `X-Api-App-Id` / `X-Api-Access-Key` form.
 *   2. The ASR entrypoint accepts raw PCM16 (Buffer / file path / async
 *      iterable) directly rather than decoding wav/mp3 internally; use ffmpeg
 *      to produce PCM16 before calling `asrStream`.
 *
 * The wire framing (4-byte header + optional event/session/sequence fields +
 * payload) is byte-for-byte identical to the Python `Message` marshal/unmarshal.
 */

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
const TTS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
// 优化双向流式端点：支持 enable_nonstream 二遍识别 + VAD 分段（definite 输出），
// 是流式自动断句（end_window_size）生效的前提（plain bigmodel 只返回 partial）。
const ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class VolcengineVoiceError extends Error {
  code: number | undefined
  payload: unknown

  constructor(message: string, code?: number, payload?: unknown) {
    super(code !== undefined ? `[${code}] ${message}` : message)
    this.name = 'VolcengineVoiceError'
    this.code = code
    this.payload = payload
  }
}

// ---------------------------------------------------------------------------
// Protocol enums
// ---------------------------------------------------------------------------
export enum MsgType {
  Invalid = 0,
  FullClientRequest = 0b0001,
  AudioOnlyClient = 0b0010,
  FullServerResponse = 0b1001,
  AudioOnlyServer = 0b1011,
  FrontEndResultServer = 0b1100,
  Error = 0b1111,
}

export enum Flags {
  NoSeq = 0b0000,
  PositiveSeq = 0b0001,
  LastNoSeq = 0b0010,
  NegativeSeq = 0b0011,
  WithEvent = 0b0100,
}

export enum Serialization {
  Raw = 0,
  JSON = 0b0001,
}

export enum Compression {
  None = 0,
  Gzip = 0b0001,
}

export enum Event {
  None = 0,
  // Upstream connection
  StartConnection = 1,
  FinishConnection = 2,
  // Downstream connection
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,
  // Upstream session
  StartSession = 100,
  CancelSession = 101,
  FinishSession = 102,
  // Downstream session
  SessionStarted = 150,
  SessionCanceled = 151,
  SessionFinished = 152,
  SessionFailed = 153,
  // Upstream generic
  TaskRequest = 200,
  UpdateConfig = 201,
  // Downstream TTS
  TTSSentenceStart = 350,
  TTSSentenceEnd = 351,
  TTSResponse = 352,
  TTSEnded = 359,
  // Downstream ASR
  ASRInfo = 450,
  ASRResponse = 451,
  ASREnded = 459,
}

const CONNECTION_EVENTS = new Set<number>([
  Event.StartConnection,
  Event.FinishConnection,
  Event.ConnectionStarted,
  Event.ConnectionFailed,
  Event.ConnectionFinished,
])

const SEQUENCED_TYPES = new Set<number>([
  MsgType.FullClientRequest,
  MsgType.FullServerResponse,
  MsgType.FrontEndResultServer,
  MsgType.AudioOnlyClient,
  MsgType.AudioOnlyServer,
])

// ---------------------------------------------------------------------------
// Message: unified binary frame codec (marshal/unmarshal)
// ---------------------------------------------------------------------------
export class Message {
  type: MsgType = MsgType.Invalid
  flag: Flags = Flags.NoSeq
  serialization: Serialization = Serialization.JSON
  compression: Compression = Compression.None

  event: Event = Event.None
  session_id = ''
  connect_id = ''
  sequence = 0
  error_code = 0

  payload: Buffer = Buffer.alloc(0)

  constructor(init?: Partial<Message>) {
    if (init) Object.assign(this, init)
  }

  marshal(): Buffer {
    const parts: Buffer[] = []
    parts.push(
      Buffer.from([
        0x11, // version=1, header_size=1 (=> 4-byte header)
        (this.type << 4) | this.flag,
        (this.serialization << 4) | this.compression,
        0x00,
      ]),
    )

    // Optional fields. Order matters on the wire.
    if (this.flag === Flags.WithEvent) {
      const ev = Buffer.alloc(4)
      ev.writeInt32BE(this.event, 0)
      parts.push(ev)
      if (!CONNECTION_EVENTS.has(this.event)) {
        const sid = Buffer.from(this.session_id, 'utf-8')
        const lenBuf = Buffer.alloc(4)
        lenBuf.writeUInt32BE(sid.length, 0)
        parts.push(lenBuf)
        if (sid.length) parts.push(sid)
      }
    }

    if (this.type === MsgType.Error) {
      const ec = Buffer.alloc(4)
      ec.writeUInt32BE(this.error_code >>> 0, 0)
      parts.push(ec)
    } else if (
      (this.flag === Flags.PositiveSeq || this.flag === Flags.NegativeSeq) &&
      SEQUENCED_TYPES.has(this.type)
    ) {
      const seq = Buffer.alloc(4)
      seq.writeInt32BE(this.sequence, 0)
      parts.push(seq)
    }

    const size = Buffer.alloc(4)
    size.writeUInt32BE(this.payload.length, 0)
    parts.push(size)
    if (this.payload.length) parts.push(this.payload)

    return Buffer.concat(parts)
  }

  static unmarshal(data: Buffer): Message {
    if (data.length < 4) {
      throw new Error(`frame too short: ${data.length} bytes`)
    }
    const headerSize = ((data[0] ?? 0) & 0x0f) * 4
    if (headerSize < 4) {
      throw new Error(`invalid header_size ${headerSize}`)
    }

    const msg = new Message()
    msg.type = (data[1] ?? 0) >> 4
    msg.flag = (data[1] ?? 0) & 0x0f
    msg.serialization = (data[2] ?? 0) >> 4
    msg.compression = (data[2] ?? 0) & 0x0f

    let off = headerSize
    const readI32 = (): number => {
      const v = data.readInt32BE(off)
      off += 4
      return v
    }
    const readU32 = (): number => {
      const v = data.readUInt32BE(off)
      off += 4
      return v
    }

    // Flags-specific header extensions come BEFORE seq/err, matching servers.
    if (msg.flag === Flags.WithEvent) {
      msg.event = readI32()
      if (!CONNECTION_EVENTS.has(msg.event)) {
        const sidSize = readU32()
        if (sidSize) {
          msg.session_id = data.toString('utf-8', off, off + sidSize)
          off += sidSize
        }
      } else if (msg.type === MsgType.FullServerResponse) {
        // Server connection events carry connect_id (size+bytes).
        if (off + 4 <= data.length) {
          const cidSize = readU32()
          if (cidSize) {
            msg.connect_id = data.toString('utf-8', off, off + cidSize)
            off += cidSize
          }
        }
      }
    }

    if (msg.type === MsgType.Error) {
      msg.error_code = readU32()
    } else if (
      (msg.flag === Flags.PositiveSeq || msg.flag === Flags.NegativeSeq) &&
      SEQUENCED_TYPES.has(msg.type)
    ) {
      msg.sequence = readI32()
    } else if (msg.flag === Flags.LastNoSeq) {
      // No sequence field; nothing to read.
    }

    if (off + 4 <= data.length) {
      const size = readU32()
      if (size) {
        msg.payload = data.subarray(off, off + size)
      }
    }
    return msg
  }

  jsonPayload(): Record<string, unknown> | null {
    if (!this.payload.length) return null
    let raw = this.payload
    try {
      if (this.compression === Compression.Gzip) {
        raw = gunzipSync(raw)
      }
      const parsed: unknown = JSON.parse(raw.toString('utf-8'))
      return typeof parsed === 'object' && parsed !== null
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Headers (single X-Api-Key form)
// ---------------------------------------------------------------------------
function buildHeaders(
  apiKey: string,
  resourceId: string,
  requestId?: string,
): Record<string, string> {
  return {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': randomUUID(),
    'X-Api-Request-Id': requestId ?? randomUUID(),
  }
}

// ---------------------------------------------------------------------------
// Low-level WebSocket helpers
// ---------------------------------------------------------------------------

/** A persistent FIFO of incoming server frames so no frame is ever dropped. */
class MessageStream {
  private items: Array<Message | Error> = []
  private waiters: Array<{ resolve: (m: Message) => void; reject: (e: Error) => void }> = []
  private done = false

  push(item: Message | Error): void {
    if (this.done) return
    const w = this.waiters.shift()
    if (w) {
      if (item instanceof Error) w.reject(item)
      else w.resolve(item)
    } else {
      this.items.push(item)
    }
  }

  next(): Promise<Message> {
    const item = this.items.shift()
    if (item !== undefined) {
      return item instanceof Error ? Promise.reject(item) : Promise.resolve(item)
    }
    if (this.done) {
      return Promise.reject(new VolcengineVoiceError('connection closed'))
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  close(err?: Error): void {
    this.done = true
    const e = err ?? new VolcengineVoiceError('connection closed')
    let waiter: { resolve: (m: Message) => void; reject: (err: Error) => void } | undefined
    while ((waiter = this.waiters.shift()) !== undefined) waiter.reject(e)
    this.items.length = 0
  }
}

async function openWS(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ws: WebSocket; stream: MessageStream }> {
  if (signal?.aborted === true) throw new VolcengineVoiceError('operation aborted')
  const ws = new WebSocket(url, { headers, maxPayload: 16 * 1024 * 1024 })
  const stream = new MessageStream()
  const abort = (): void => { ws.terminate() }
  signal?.addEventListener('abort', abort, { once: true })
  ws.once('close', () => { signal?.removeEventListener('abort', abort) })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new VolcengineVoiceError(`connect timed out (${timeoutMs}ms)`))
    }, timeoutMs)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      const s = err.message
      if (/401|403|auth/i.test(s)) {
        reject(new VolcengineVoiceError(`handshake rejected: ${s}`))
      } else {
        reject(new VolcengineVoiceError(`handshake failed: ${s}`))
      }
    })
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new VolcengineVoiceError('operation aborted'))
    }, { once: true })
  })

  ws.on('message', (data: WebSocket.RawData) => {
    const raw = data as WebSocket.RawData | string
    if (typeof raw === 'string') {
      stream.push(new VolcengineVoiceError(`unexpected text frame: ${raw.slice(0, 200)}`))
      return
    }
    const buf: Buffer = Array.isArray(raw)
      ? Buffer.concat(raw)
      : raw instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(raw))
        : raw
    if (!buf.length) {
      stream.push(new VolcengineVoiceError('empty server frame'))
      return
    }
    try {
      stream.push(Message.unmarshal(buf))
    } catch (e) {
      stream.push(new VolcengineVoiceError(`malformed server frame: ${(e as Error).message}`))
    }
  })
  ws.on('close', () => { stream.close(new VolcengineVoiceError('connection closed')) })
  ws.on('error', (err) => {
    stream.close(new VolcengineVoiceError(`connection error: ${err.message}`))
  })

  return { ws, stream }
}

async function recv(stream: MessageStream, timeoutMs: number): Promise<Message> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => { reject(new VolcengineVoiceError(`timed out waiting for server frame (${timeoutMs}ms)`)) },
      timeoutMs,
    )
  })
  try {
    return await Promise.race([stream.next(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function send(ws: WebSocket, msg: Message): void {
  ws.send(msg.marshal())
}

function assertNoServerError(msg: Message): void {
  if (msg.type === MsgType.Error) {
    const body = msg.payload.toString('utf-8')
    throw new VolcengineVoiceError(`server error: ${body}`, msg.error_code, body)
  }
  if (msg.event === Event.ConnectionFailed || msg.event === Event.SessionFailed) {
    const body = msg.jsonPayload() ?? msg.payload.toString('utf-8')
    throw new VolcengineVoiceError(
      `${Event[msg.event]}: ${JSON.stringify(body)}`,
      msg.error_code || undefined,
      body,
    )
  }
}

// ---------------------------------------------------------------------------
// TTS bidirectional streaming (seed-tts-2.0)
// ---------------------------------------------------------------------------
export interface TtsStreamOptions {
  /** Output audio container. Default "mp3". */
  audioFormat?: 'mp3' | 'pcm' | 'ogg_opus'
  /** Sample rate in Hz. Default 24000. */
  sampleRate?: number
  /** Speed multiplier (1.0 = normal). Default 1.0. */
  speedRatio?: number
  /** X-Api-Resource-Id. Default "seed-tts-2.0". */
  resourceId?: string
  /** Optional X-Api-Request-Id (also used as user uid). */
  requestId?: string
  /** Per-phase receive timeout in ms. Default 30000. */
  timeoutMs?: number
  /** Cancels the cloud session and releases its WebSocket immediately. */
  signal?: AbortSignal
}

export async function ttsStream(
  text: string,
  voice: string,
  apiKey: string,
  onAudio: (chunk: Buffer) => void,
  options: TtsStreamOptions = {},
): Promise<void> {
  const {
    audioFormat = 'mp3',
    sampleRate = 24000,
    speedRatio = 1.0,
    resourceId = 'seed-tts-2.0',
    requestId,
    timeoutMs = 30000,
    signal,
  } = options

  const headers = buildHeaders(apiKey, resourceId, requestId)
  const uid = headers['X-Api-Request-Id']

  const speechRate = Math.max(-50, Math.min(100, Math.round((speedRatio - 1) * 100)))

  const reqParams: Record<string, unknown> = {
    speaker: voice,
    audio_params: {
      format: audioFormat,
      sample_rate: sampleRate,
      speech_rate: speechRate,
    },
  }
  const basePayload = {
    user: { uid },
    namespace: 'BidirectionalTTS',
    req_params: reqParams,
  }

  const sessionId = randomUUID()
  const { ws, stream } = await openWS(TTS_URL, headers, timeoutMs, signal)

  try {
    // 1. StartConnection -> ConnectionStarted
    send(
      ws,
      new Message({
        type: MsgType.FullClientRequest,
        flag: Flags.WithEvent,
        event: Event.StartConnection,
        payload: Buffer.from('{}'),
      }),
    )
    let msg = await recv(stream, timeoutMs)
    assertNoServerError(msg)
    if (msg.event !== Event.ConnectionStarted) {
      throw new VolcengineVoiceError(
        `expected ConnectionStarted, got ${Event[msg.event]}`,
      )
    }

    // 2. StartSession -> SessionStarted
    send(
      ws,
      new Message({
        type: MsgType.FullClientRequest,
        flag: Flags.WithEvent,
        event: Event.StartSession,
        session_id: sessionId,
        payload: Buffer.from(
          JSON.stringify({ ...basePayload, event: Event.StartSession }),
          'utf-8',
        ),
      }),
    )
    msg = await recv(stream, timeoutMs)
    assertNoServerError(msg)
    if (msg.event !== Event.SessionStarted) {
      throw new VolcengineVoiceError(
        `expected SessionStarted, got ${Event[msg.event]}`,
      )
    }

    // 3. TaskRequest (carries the text)
    send(
      ws,
      new Message({
        type: MsgType.FullClientRequest,
        flag: Flags.WithEvent,
        event: Event.TaskRequest,
        session_id: sessionId,
        payload: Buffer.from(
          JSON.stringify({
            ...basePayload,
            event: Event.TaskRequest,
            req_params: { ...reqParams, text },
          }),
          'utf-8',
        ),
      }),
    )

    // 3b. Signal FinishSession immediately so the server finalizes the stream.
    send(
      ws,
      new Message({
        type: MsgType.FullClientRequest,
        flag: Flags.WithEvent,
        event: Event.FinishSession,
        session_id: sessionId,
        payload: Buffer.from('{}'),
      }),
    )

    // 4. Receive loop: audio chunks until TTSEnded / SessionFinished.
    let sessionDone = false
    while (true) {
      msg = await recv(stream, timeoutMs)
      assertNoServerError(msg)
      if (msg.type === MsgType.AudioOnlyServer) {
        if (msg.payload.length) onAudio(msg.payload)
      } else if (msg.type === MsgType.FullServerResponse) {
        if (msg.event === Event.TTSEnded || msg.event === Event.SessionFinished) {
          if (msg.event === Event.SessionFinished) sessionDone = true
          break
        }
        // TTSResponse / TTSSentenceStart / TTSSentenceEnd are progress frames.
        continue
      }
      // Unexpected frame type: keep waiting for terminal frame.
    }

    // 5. FinishSession (skip if server already sent SessionFinished) + FinishConnection.
    if (!sessionDone) {
      send(
        ws,
        new Message({
          type: MsgType.FullClientRequest,
          flag: Flags.WithEvent,
          event: Event.FinishSession,
          session_id: sessionId,
          payload: Buffer.from('{}'),
        }),
      )
      try {
        await recv(stream, timeoutMs)
      } catch {
        /* SessionFinished optional; ignore timeout */
      }
    }

    send(
      ws,
      new Message({
        type: MsgType.FullClientRequest,
        flag: Flags.WithEvent,
        event: Event.FinishConnection,
        payload: Buffer.from('{}'),
      }),
    )
    try {
      await recv(stream, timeoutMs)
    } catch {
      /* ConnectionFinished optional; ignore timeout */
    }
  } finally {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// ASR streaming (bigmodel, bidirectional)
// ---------------------------------------------------------------------------
export interface AsrResult {
  text: string
  is_final: boolean
  utterances: unknown[]
  raw: Record<string, unknown>
}

export interface AsrStreamOptions {
  /** Sample rate in Hz. Default 16000. */
  sampleRate?: number
  /** Bit depth. Default 16. */
  bits?: number
  /** Channel count. Default 1. */
  channel?: number
  /** Model name. Default "bigmodel". */
  modelName?: string
  enableItn?: boolean
  enablePunc?: boolean
  enableDdc?: boolean
  showUtterances?: boolean
  /** Audio segment duration per frame in ms. Default 200. */
  segmentDurationMs?: number
  /** 服务端端点检测（静音断句）窗口 ms（end_window_size）。设置后走真流式：持续发音频，服务端在静音超时后返回 definite final。 */
  endpointingMs?: number
  /** 端点检测前的最短语音时长 ms（force_to_speech_time），防误断。需与 endpointingMs 同用。 */
  minSpeechMs?: number
  /** X-Api-Resource-Id. Default "volc.bigasr.sauc.duration". */
  resourceId?: string
  requestId?: string
  timeoutMs?: number
  /** Cancels the cloud session without requesting a final transcript. */
  signal?: AbortSignal
}

/** 火山双向流式的句末在最后一个 utterance.definite，而非稳定存在的顶层 is_final。 */
export function isDefiniteAsrResult(result: Record<string, unknown>): boolean {
  if (result.is_final === true) return true
  const utterances: unknown[] = result.utterances as unknown[]
  if (!Array.isArray(utterances) || utterances.length === 0) return false
  const last: unknown = utterances[utterances.length - 1]
  return typeof last === 'object' && last !== null
    && (last as Record<string, unknown>).definite === true
}

/** Split raw PCM16 into fixed-size segments, matching the Python chunker. */
async function* chunkSource(
  source: AsyncIterable<Buffer> | Buffer | string,
  segmentBytes: number,
): AsyncGenerator<Buffer> {
  if (typeof source === 'string') {
    source = await readFile(source)
  }
  if (Buffer.isBuffer(source)) {
    for (let i = 0; i < source.length; i += segmentBytes) {
      yield source.subarray(i, i + segmentBytes)
    }
    return
  }
  // Async iterable
  let buf = Buffer.alloc(0)
  for await (const chunk of source) {
    if (chunk.length === 0) continue
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= segmentBytes) {
      yield buf.subarray(0, segmentBytes)
      buf = buf.subarray(segmentBytes)
    }
  }
  if (buf.length) yield buf
}

export async function asrStream(
  pcmSource: AsyncIterable<Buffer> | Buffer | string,
  apiKey: string,
  onText: (result: AsrResult) => void,
  options: AsrStreamOptions = {},
): Promise<void> {
  const {
    sampleRate = 16000,
    bits = 16,
    channel = 1,
    modelName = 'bigmodel',
    enableItn = true,
    enablePunc = true,
    enableDdc = true,
    showUtterances = true,
    segmentDurationMs = 200,
    endpointingMs,
    minSpeechMs,
    resourceId = 'volc.bigasr.sauc.duration',
    requestId,
    timeoutMs = 30000,
    signal,
  } = options

  const headers = buildHeaders(apiKey, resourceId, requestId)
  const uid = headers['X-Api-Request-Id']

  const segmentBytes = Math.max(
    1,
    Math.floor((sampleRate * (bits / 8) * channel * segmentDurationMs) / 1000),
  )

  const initPayload = {
    user: { uid },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: sampleRate,
      bits,
      channel,
    },
    request: {
      model_name: modelName,
      enable_itn: enableItn,
      enable_punc: enablePunc,
      enable_ddc: enableDdc,
      show_utterances: showUtterances,
      // 二遍识别 + VAD 分段：只有 enable_nonstream=true 时服务端才输出
      // definite final（配合 end_window_size 实现流式自动断句）。
      enable_nonstream: true,
      // 服务端端点检测：静音超时自动断句（输出 definite），客户端能量 VAD 不再决定句界。
      ...(endpointingMs !== undefined ? { end_window_size: endpointingMs } : {}),
      ...(minSpeechMs !== undefined ? { force_to_speech_time: minSpeechMs } : {}),
    },
  }

  const { ws, stream } = await openWS(ASR_URL, headers, timeoutMs, signal)

  let seq = 1
  const initMsg = new Message({
    type: MsgType.FullClientRequest,
    flag: Flags.PositiveSeq,
    serialization: Serialization.JSON,
    compression: Compression.Gzip,
    sequence: seq,
    payload: gzipSync(Buffer.from(JSON.stringify(initPayload), 'utf-8')),
  })

  // 并发 sender/receiver 的共享状态放在对象内，避免任一闭包持有过期快照。
  const state: { recvError: Error | null; finished: boolean } = {
    recvError: null,
    finished: false,
  }

  // Receiver: runs concurrently with the sender, emits results to onText.
  const receiver = (async () => {
    try {
      while (true) {
        const msg = await recv(stream, timeoutMs)
        if (msg.type === MsgType.Error) {
          assertNoServerError(msg)
          continue
        }
        const payload = msg.jsonPayload()
        if (msg.type === MsgType.FullServerResponse && payload) {
          const result = payload.result
          if (result && typeof result === 'object') {
            const r = result as Record<string, unknown>
            const isFinal = isDefiniteAsrResult(r) || Boolean(msg.flag & Flags.LastNoSeq)
            const out: AsrResult = {
              text: typeof r.text === 'string' ? r.text : '',
              is_final: isFinal,
              utterances: Array.isArray(r.utterances) ? r.utterances : [],
              raw: payload,
            }
            onText(out)
            if (isFinal || (msg.flag & Flags.LastNoSeq)) {
              state.finished = true
              // 服务端端点检测已断句：中断持续音频流，让 sender 尽快退出。
              const q = pcmSource as { abort?: () => void } | null
              q?.abort?.()
              return
            }
          } else if (msg.flag & Flags.LastNoSeq) {
            return
          }
        }
      }
    } catch (e) {
      if (signal?.aborted !== true) state.recvError = e as Error
    }
  })()

  // Sender: init frame, then audio chunks; final NegativeSeq only when the
  // server has not yet endpointed (i.e. the source ended first).
  try {
    send(ws, initMsg)
    seq += 1

    let prev: Buffer | null = null
    for await (const chunk of chunkSource(pcmSource, segmentBytes)) {
      if (state.finished) break
      if (prev !== null) {
        send(
          ws,
          new Message({
            type: MsgType.AudioOnlyClient,
            flag: Flags.PositiveSeq,
            serialization: Serialization.JSON,
            compression: Compression.Gzip,
            sequence: seq,
            payload: gzipSync(prev),
          }),
        )
        seq += 1
      }
      prev = chunk
    }

    if (!state.finished && signal?.aborted !== true) {
      const finalBytes = prev ?? Buffer.alloc(0)
      send(
        ws,
        new Message({
          type: MsgType.AudioOnlyClient,
          flag: Flags.NegativeSeq,
          serialization: Serialization.JSON,
          compression: Compression.Gzip,
          sequence: -seq,
          payload: gzipSync(finalBytes),
        }),
      )
    }
  } catch (e) {
    if (signal?.aborted !== true && state.recvError === null) state.recvError = e as Error
    ws.terminate()
  }

  try {
    if (signal?.aborted === true) ws.terminate()
    await receiver
    if (state.recvError !== null) throw state.recvError
  } finally {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Real-time voice for the composer, backend-first with browser fallback.
 *
 * Preferred path: a local `voice-pipeline` WebSocket server (streaming
 * faster-whisper ASR + edge-tts TTS). The browser streams mic PCM16 to it,
 * receives final transcripts, forwards the streaming reply text back for
 * synthesis, and plays the returned MP3. If the server is unreachable, it
 * falls back to the browser-native SpeechRecognition + speechSynthesis stack.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const WS_PORT = 3081

/** 可选音色（30 个，均经 seed-tts-2.0 实测通过）。 */
export const VOICE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'zh_female_vv_uranus_bigtts', label: '温暖女声' },
  { id: 'zh_female_xiaohe_uranus_bigtts', label: '温柔女声' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '清纯甜美女声' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', label: '软甜女声' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快女声' },
  { id: 'zh_female_peiqi_uranus_bigtts', label: '童声' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩' },
  { id: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声' },
  { id: 'zh_female_xiaoxue_uranus_bigtts', label: '清澈童声' },
  { id: 'zh_female_mizai_uranus_bigtts', label: '俏皮女声' },
  { id: 'zh_female_jitangnv_uranus_bigtts', label: '治愈女声' },
  { id: 'zh_female_meilinvyou_uranus_bigtts', label: '温柔女友声' },
  { id: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声' },
  { id: 'zh_female_yingyujiaoxue_uranus_bigtts', label: '教学女声' },
  { id: 'zh_female_cancan_uranus_bigtts', label: '知性女声' },
  { id: 'zh_male_m191_uranus_bigtts', label: '沉稳男声' },
  { id: 'zh_male_taocheng_uranus_bigtts', label: '活力青年男声' },
  { id: 'zh_male_liufei_uranus_bigtts', label: '活力男声' },
  { id: 'zh_male_sophie_uranus_bigtts', label: '温柔男声' },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年音' },
  { id: 'zh_male_sunwukong_uranus_bigtts', label: '猴哥（活泼男声）' },
  { id: 'zh_male_dayi_uranus_bigtts', label: '浑厚男声' },
  { id: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅男声' },
  { id: 'saturn_zh_female_keainvsheng_tob', label: '可爱女生' },
  { id: 'saturn_zh_female_tiaopigongzhu_tob', label: '调皮公主' },
  { id: 'saturn_zh_male_shuanglangshaonian_tob', label: '爽朗少年' },
  { id: 'saturn_zh_male_tiancaitongzhuo_tob', label: '天才同桌' },
  { id: 'saturn_zh_female_cancan_tob', label: '知性灿灿' },
]
export const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts'

let activeVoice = (typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-voice') : null) ?? DEFAULT_VOICE

/** 切换朗读音色（持久化到 localStorage）。 */
export function setActiveVoice(voice: string): void {
  activeVoice = voice
  if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-voice', voice)
}

export function getActiveVoice(): string {
  return activeVoice
}

/** 支持的服务商。 */
export const PROVIDERS: readonly { id: string; label: string }[] = [
  { id: 'volcengine', label: '火山引擎（豆包）' },
  { id: 'local', label: '本地免费（无需 Key）' },
]

let activeProvider = (typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-voice-provider') : null) ?? 'volcengine'
let activeApiKey = (typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-voice-api-key') : null) ?? ''

export function getActiveProvider(): string {
  return activeProvider
}

export function setActiveProvider(provider: string): void {
  activeProvider = provider
  if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-voice-provider', provider)
}

export function getActiveApiKey(): string {
  return activeApiKey
}

export function setActiveApiKey(key: string): void {
  activeApiKey = key
  if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-voice-api-key', key)
}

/** Minimal typed surface over the non-standard SpeechRecognition API (fallback). */
interface SpeechRecognitionAlternative { transcript: string }
interface SpeechRecognitionResult extends ArrayLike<SpeechRecognitionAlternative> { isFinal: boolean }
interface SpeechRecognitionEventLike { readonly resultIndex: number; readonly results: ArrayLike<SpeechRecognitionResult> }
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}
interface SpeechRecognitionCtor { new (): SpeechRecognitionLike }

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export interface RealtimeVoiceOptions {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
}

export interface RealtimeVoiceHandle {
  supported: boolean
  active: boolean
  listening: boolean
  /** 后端模式：volcano（火山）| fallback（浏览器本地）| idle。 */
  mode: 'idle' | 'volcano' | 'fallback'
  start(): void
  stop(): void
  setRunning(running: boolean): void
  cancelSpeech(): void
}

/** Linear-resample Float32 to `outRate` and quantize to Int16. */
function resampleToInt16(f32: Float32Array, inRate: number, outRate: number): Int16Array<ArrayBuffer> {
  if (inRate === outRate) {
    const out = new Int16Array(f32.length)
    for (let i = 0; i < f32.length; i++) out[i] = Math.max(-1, Math.min(1, f32[i] ?? 0)) * 0x7fff | 0
    return out
  }
  const ratio = inRate / outRate
  const len = Math.floor(f32.length / ratio)
  const out = new Int16Array(len)
  for (let i = 0; i < len; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, f32.length - 1)
    const t = pos - i0
    out[i] = Math.max(-1, Math.min(1, (f32[i0] ?? 0) * (1 - t) + (f32[i1] ?? 0) * t)) * 0x7fff | 0
  }
  return out
}

/** The last assistant answer row (or null). */
function lastAssistantRow(): HTMLElement | null {
  const rows = document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="assistant-step"]')
  return rows[rows.length - 1] ?? null
}

/** Stable key of a chat row (used to skip the previous turn's answer). */
function rowKeyOf(el: HTMLElement): string | null {
  return el.getAttribute('data-chat-anchor-key')
}

/** Text of an assistant row, excluding the reasoning disclosure. */
function answerTextOf(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-variant="think"]').forEach(child => child.remove())
  return (clone.textContent ?? '').trim()
}

/** Best-effort read of the last assistant answer's text (reasoning excluded). */
export function readLastChatRowText(): string {
  const el = lastAssistantRow()
  return el === null ? '' : answerTextOf(el)
}

/** Strip markdown/symbols so the narrator reads natural prose. */
function plainTextOfMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/`([^`]*)`/g, '$1')              // 行内代码
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')     // 图片
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')   // 链接
    .replace(/https?:\/\/\S+/g, '')           // 裸链接
    .replace(/^\s*\|.*$/gm, '')               // 表格行
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')       // 标题
    .replace(/^\s*[-*+]\s+/gm, '')            // 无序列表
    .replace(/^\s*\d+[.)]\s+/gm, '')          // 有序列表
    .replace(/^\s*>\s?/gm, '')                // 引用
    .replace(/[*_~]{1,3}/g, '')               // 粗体/斜体/删除线
    .replace(/\$\$?[^$]*\$\$?/g, '')          // 数学公式
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // emoji
    .replace(/\s+/g, ' ')
    .trim()
}

/** Sequential MP3 player: queues sentences so they never overlap. */
let currentAudio: HTMLAudioElement | null = null
let pendingBlobs: { blob: Blob; url: string }[] = []

function pumpAudioQueue(): void {
  if (currentAudio !== null || pendingBlobs.length === 0) return
  const item = pendingBlobs.shift()
  if (item === undefined) return
  const audio = new Audio(item.url)
  currentAudio = audio
  audio.onended = () => { URL.revokeObjectURL(item.url); currentAudio = null; pumpAudioQueue() }
  audio.onerror = () => { URL.revokeObjectURL(item.url); currentAudio = null; pumpAudioQueue() }
  void audio.play()
}

/** Enqueue one sentence's MP3 chunks for sequential playback. */
function playMp3Blob(chunks: Uint8Array[]): void {
  if (chunks.length === 0) return
  const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
  pendingBlobs.push({ blob, url: URL.createObjectURL(blob) })
  pumpAudioQueue()
}

/** Stop any playing/queued audio (barge-in / stop / cleanup). */
function stopAudio(): void {
  if (currentAudio !== null) {
    currentAudio.pause()
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio = null
  }
  for (const item of pendingBlobs) URL.revokeObjectURL(item.url)
  pendingBlobs = []
}

/** Speak one sentence via the pipeline only — no browser voice fallback. */
function speakReply(text: string, pipeline: boolean, ws: WebSocket | null): void {
  if (text.trim() === '') return
  if (pipeline && ws !== null && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'tts_push', text, voice: activeVoice }))
  }
}

/** 试听：一次性连接后端合成一句示例，播放后关闭。 */
export async function previewVoice(voice: string, apiKey: string): Promise<void> {
  try {
    const ws = new WebSocket(`ws://${window.location.hostname || '127.0.0.1'}:${WS_PORT}/ws`)
    ws.binaryType = 'arraybuffer'
    const chunks: Uint8Array[] = []
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      ws.onopen = () => { clearTimeout(timer); resolve(true) }
      ws.onerror = () => { clearTimeout(timer); resolve(false) }
    })
    if (!opened) { ws.close(); return }
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data) as { type: string }
        if (msg.type === 'tts_done') playMp3Blob(chunks.splice(0))
      } else if (e.data instanceof ArrayBuffer) {
        chunks.push(new Uint8Array(e.data))
      }
    }
    ws.send(JSON.stringify({ type: 'config', provider: 'volcengine', api_key: apiKey, voice }))
    ws.send(JSON.stringify({ type: 'tts_push', text: '你好，这是你选择的音色，听起来还满意吗？' }))
    ws.send(JSON.stringify({ type: 'tts_flush' }))
    setTimeout(() => { ws.close() }, 5000)
  } catch { /* 试听失败静默忽略 */ }
}

export function useRealtimeVoice(options: RealtimeVoiceOptions): RealtimeVoiceHandle {
  const [supported] = useState(() => recognitionCtor() !== undefined
    || ('mediaDevices' in navigator && 'WebSocket' in window))
  const [active, setActive] = useState(false)
  const [listening, setListening] = useState(false)
  const [mode, setMode] = useState<'idle' | 'volcano' | 'fallback'>('idle')

  const wsRef = useRef<WebSocket | null>(null)
  const pipelineRef = useRef(false)
  const activeRef = useRef(false)
  const runningRef = useRef(false)
  const spokenLenRef = useRef(0)
  const mp3ChunksRef = useRef<Uint8Array[]>([])
  const recognizerRef = useRef<SpeechRecognitionLike | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  // 只有语音输入发起的回合才朗读回复（键盘输入不朗读）。
  const voicePendingRef = useRef(false)
  const speakThisTurnRef = useRef(false)
  // 上一轮回答行的 key（用于跳过"上一轮回答还在被读"）。
  const baselineRowKeyRef = useRef<string | null>(null)
  const currentRowKeyRef = useRef<string | null>(null)

  const cancelSpeech = useCallback((): void => {
    stopAudio()
    mp3ChunksRef.current = []
  }, [])

  const cleanupPipeline = useCallback((): void => {
    wsRef.current?.close()
    wsRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }, [])

  // ---- fallback (browser-native) STT ----
  const runFallbackRecognition = useCallback((): void => {
    const Ctor = recognitionCtor()
    if (Ctor === undefined) return
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (event) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        if (r === undefined) continue
        const alt = r[0]?.transcript ?? ''
        if (r.isFinal) final += alt
        else interim += alt
      }
      if (final.trim() !== '') {
        voicePendingRef.current = true
        stopAudio()
        mp3ChunksRef.current = []
        optionsRef.current.onFinal(final.trim())
      } else if (interim.trim() !== '') {
        optionsRef.current.onInterim(interim.trim())
      }
    }
    rec.onend = () => {
      setListening(false)
      recognizerRef.current = null
      if (activeRef.current) setTimeout(() => { if (activeRef.current) runFallbackRecognition() }, 250)
    }
    rec.onerror = () => { setListening(false); recognizerRef.current = null }
    recognizerRef.current = rec
    setListening(true)
    rec.start()
  }, [])

  // ---- pipeline (backend) mic capture ----
  const startPipeline = useCallback(async (): Promise<boolean> => {
    if (!('mediaDevices' in navigator)) return false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      const ctx = new AudioContext()
      const url = `ws://${window.location.hostname || '127.0.0.1'}:${WS_PORT}/ws`
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'

      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2000)
        ws.onopen = () => { clearTimeout(timer); resolve(true) }
        ws.onerror = () => { clearTimeout(timer); resolve(false) }
      })
      if (!opened) {
        ws.close()
        stream.getTracks().forEach(t => t.stop())
        await ctx.close()
        setMode('fallback')
        return false
      }

      pipelineRef.current = true
      audioCtxRef.current = ctx
      streamRef.current = stream
      wsRef.current = ws
      setMode('volcano')

      // 下发运行时配置（服务商 / API Key / 音色）。
      ws.send(JSON.stringify({
        type: 'config',
        provider: activeProvider,
        api_key: activeApiKey,
        voice: activeVoice,
      }))

      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data) as { type: string; text?: string }
          if (msg.type === 'asr_final' && msg.text !== undefined) {
            voicePendingRef.current = true
            stopAudio()
            mp3ChunksRef.current = []
            optionsRef.current.onFinal(msg.text)
          } else if (msg.type === 'tts_done') {
            playMp3Blob(mp3ChunksRef.current)
            mp3ChunksRef.current = []
          }
        } else if (e.data instanceof ArrayBuffer) {
          mp3ChunksRef.current.push(new Uint8Array(e.data))
        }
      }
      ws.onclose = () => {
        pipelineRef.current = false
        wsRef.current = null
        if (activeRef.current) runFallbackRecognition()
      }

      // mic -> PCM16 16k -> ws
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(2048, 1, 1)
      const mute = ctx.createGain()
      mute.gain.value = 0
      src.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
      proc.onaudioprocess = (ev) => {
        if (ws.readyState === WebSocket.OPEN) {
          const f32 = ev.inputBuffer.getChannelData(0)
          const i16 = resampleToInt16(f32, ctx.sampleRate, 16000)
          ws.send(i16)
        }
      }
      setListening(true)
      return true
    } catch {
      setMode('fallback')
      return false
    }
  }, [runFallbackRecognition])

  const start = useCallback((): void => {
    activeRef.current = true
    spokenLenRef.current = 0
    setActive(true)
    setMode('idle')
    void startPipeline().then((ok) => {
      if (!ok && activeRef.current) runFallbackRecognition()
    })
  }, [startPipeline, runFallbackRecognition])

  const stop = useCallback((): void => {
    activeRef.current = false
    setActive(false)
    setListening(false)
    cleanupPipeline()
    recognizerRef.current?.stop()
    stopAudio()
    mp3ChunksRef.current = []
  }, [cleanupPipeline])

  const setRunning = useCallback((running: boolean): void => {
    const previous = runningRef.current
    runningRef.current = running
    if (running && !previous) {
      // 回合开始：仅当本轮由语音发起时才朗读回复。
      speakThisTurnRef.current = voicePendingRef.current
      voicePendingRef.current = false
      spokenLenRef.current = 0
      const el = lastAssistantRow()
      baselineRowKeyRef.current = el === null ? null : rowKeyOf(el)
      currentRowKeyRef.current = baselineRowKeyRef.current
    } else if (!running && previous) {
      if (speakThisTurnRef.current) {
        const el = lastAssistantRow()
        const key = el === null ? null : rowKeyOf(el)
        // 仅当本轮产生了新的回答行时才 flush（跳过上一轮回答）。
        if (el !== null && key !== baselineRowKeyRef.current) {
          const plain = plainTextOfMarkdown(answerTextOf(el))
          const tail = plain.slice(spokenLenRef.current).trim()
          if (tail !== '') speakReply(tail, pipelineRef.current, wsRef.current)
          if (pipelineRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'tts_flush' }))
          }
          spokenLenRef.current = plain.length
        }
      }
      speakThisTurnRef.current = false
    }
  }, [])

  // Reply reader: while the agent runs, forward each newly completed sentence
  // to the pipeline TTS (only for voice-initiated turns, and only for the
  // current turn's answer row — never the previous turn's).
  useEffect(() => {
    if (!active) return
    const interval = setInterval(() => {
      if (!runningRef.current || !speakThisTurnRef.current) return
      const el = lastAssistantRow()
      if (el === null) return
      const key = rowKeyOf(el)
      // Still the previous turn's answer (new answer not rendered yet): skip.
      if (key !== null && key === baselineRowKeyRef.current) return
      // A new answer row appeared this turn: reset the watermark once.
      if (key !== null && key !== currentRowKeyRef.current) {
        currentRowKeyRef.current = key
        spokenLenRef.current = 0
      }
      const plain = plainTextOfMarkdown(answerTextOf(el))
      if (plain.length <= spokenLenRef.current) return
      const delta = plain.slice(spokenLenRef.current)
      let lastEnd = 0
      for (const m of delta.matchAll(/[^。！？!?.\n]+[。！？!?.\n]+/g)) {
        const sentence = m[0].trim()
        if (sentence !== '') speakReply(sentence, pipelineRef.current, wsRef.current)
        lastEnd = (m.index ?? 0) + m[0].length
      }
      if (lastEnd > 0) spokenLenRef.current += lastEnd
    }, 350)
    return () => clearInterval(interval)
  }, [active])

  // Unmount cleanup.
  useEffect(() => () => {
    cleanupPipeline()
    recognizerRef.current?.abort()
    stopAudio()
  }, [cleanupPipeline])

  return { supported, active, listening, mode, start, stop, setRunning, cancelSpeech }
}

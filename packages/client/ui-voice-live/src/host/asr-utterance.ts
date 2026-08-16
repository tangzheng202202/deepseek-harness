/**
 * 一轮流式 ASR（AsrTurn）：
 * - 有界 BoundedQueue 作为音频输入，逐帧转发给火山 bigmodel；
 * - 句界由服务端端点检测（end_window_size）决定，客户端不做能量断句；
 * - end() 正常停止（等最终结果）；cancel() 直接丢弃；
 * - 每个结果带 utteranceId，由上层排序提交。
 */
import { asrStream } from './volcengine.ts'
import { BoundedQueue } from './bounded-queue.ts'

/** 服务端端点检测窗口（静音超时断句），与火山文档默认一致。 */
const ENDPOINTING_MS = 800
/** 端点检测前最短语音时长，防误断。 */
const MIN_SPEECH_MS = 1000

export class AsrUtterance {
  readonly id: string
  private queue = new BoundedQueue()
  private cancelled = false
  private finished = false
  private readonly abortController = new AbortController()

  constructor(
    private readonly apiKey: string,
    id: string,
    private readonly onFinal: (text: string) => void,
    private readonly onPartial: (text: string) => void,
    private readonly onError: (err: Error) => void,
    private readonly onSettled: () => void = () => {},
  ) {
    this.id = id
  }

  /** 启动流式识别（并发 sender/receiver）。 */
  start(): void {
    void (async () => {
      try {
        await asrStream(this.queue, this.apiKey, (r) => {
          if (this.cancelled) return
          if (r.is_final) {
            const t = r.text.trim()
            if (t !== '') this.onFinal(t)
          } else {
            const t = r.text.trim()
            if (t !== '') this.onPartial(t)
          }
        }, {
          endpointingMs: ENDPOINTING_MS,
          minSpeechMs: MIN_SPEECH_MS,
          signal: this.abortController.signal,
        })
      } catch (e) {
        if (!this.cancelled) this.onError(e as Error)
      } finally {
        this.finished = true
        this.onSettled()
      }
    })()
  }

  /** 喂一帧音频；已结束/已取消时静默丢弃。 */
  push(pcm: Buffer): boolean {
    if (this.finished || this.cancelled) return false
    return this.queue.push(pcm)
  }

  /** 正常停止：结束音频流，等待服务端最终结果（exactly-once）。 */
  end(): void {
    if (this.finished || this.cancelled) return
    this.queue.end()
  }

  /** 取消：直接丢弃，不提交最终结果。 */
  cancel(): void {
    if (this.finished) return
    this.cancelled = true
    this.queue.abort()
    this.abortController.abort()
  }

  get isFinished(): boolean {
    return this.finished
  }
}

/**
 * 有界异步队列：真流式 ASR 的音频输入通道。
 * - 有界：超过 maxBytes 的帧被拒绝（返回 false），禁止无界 Buffer.concat。
 * - 支持正常结束（end：发完剩余后 close）与取消（abort：直接丢弃）。
 * - AsyncIterable：供 asrStream 的 sender 持续消费。
 */

export class BoundedQueue implements AsyncIterable<Buffer> {
  private buf: Buffer[] = []
  private waiters: Array<(r: IteratorResult<Buffer>) => void> = []
  private ended = false
  private aborted = false
  private bytes = 0

  constructor(private readonly maxBytes = 1024 * 1024) {}

  /** 入队一帧音频；超上限或已结束/取消时返回 false（帧被拒绝，不记入队列）。 */
  push(chunk: Buffer): boolean {
    if (this.ended || this.aborted || chunk.length === 0) return false
    if (chunk.length > this.maxBytes || this.bytes + chunk.length > this.maxBytes) return false
    const w = this.waiters.shift()
    if (w !== undefined) {
      w({ value: chunk, done: false })
    } else {
      this.buf.push(chunk)
      this.bytes += chunk.length
    }
    return true
  }

  /** 正常结束：剩余帧消费完后迭代器返回 done，调用方据此发 NegativeSeq 收尾等最终结果。 */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.drainWaiters()
  }

  /** 取消：清空队列并结束，调用方据此直接丢弃、不再等结果。 */
  abort(): void {
    if (this.aborted) return
    this.aborted = true
    this.ended = true
    this.buf = []
    this.bytes = 0
    this.drainWaiters()
  }

  get isEnded(): boolean {
    return this.ended
  }

  get isAborted(): boolean {
    return this.aborted
  }

  get size(): number {
    return this.bytes
  }

  private drainWaiters(): void {
    let w = this.waiters.shift()
    while (w !== undefined) {
      w({ value: undefined, done: true })
      w = this.waiters.shift()
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: (): Promise<IteratorResult<Buffer>> => {
        const item = this.buf.shift()
        if (item !== undefined) {
          this.bytes -= item.length
          return Promise.resolve({ value: item, done: false })
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

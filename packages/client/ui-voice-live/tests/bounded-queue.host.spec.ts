/** BoundedQueue：有界、可正常结束/取消的异步音频队列。 */

import { describe, expect, it } from 'vitest'
import { BoundedQueue } from '../src/host/bounded-queue.ts'

describe('BoundedQueue', () => {
  it('yields pushed frames in order', async () => {
    const q = new BoundedQueue()
    q.push(Buffer.from([1]))
    q.push(Buffer.from([2]))
    q.end()
    const got: number[] = []
    for await (const c of q) got.push(c[0] ?? -1)
    expect(got).toEqual([1, 2])
  })

  it('rejects frames beyond the byte bound and keeps consuming', async () => {
    const q = new BoundedQueue(10)
    expect(q.push(Buffer.alloc(10))).toBe(true)
    expect(q.push(Buffer.alloc(1))).toBe(false) // 10 + 1 > 10
    q.end()
    const total = await (async () => { let n = 0; for await (const c of q) n += c.length; return n })()
    expect(total).toBe(10)
  })

  it('push after end/abort is refused', () => {
    const q = new BoundedQueue()
    expect(q.isEnded).toBe(false)
    expect(q.isAborted).toBe(false)
    expect(q.size).toBe(0)
    q.end()
    q.end()
    expect(q.isEnded).toBe(true)
    expect(q.push(Buffer.from([1]))).toBe(false)
    const a = new BoundedQueue()
    a.abort()
    a.abort()
    expect(a.isAborted).toBe(true)
    expect(a.size).toBe(0)
    expect(a.push(Buffer.from([1]))).toBe(false)
  })

  it('abort clears pending frames and wakes waiters with done', async () => {
    const q = new BoundedQueue()
    q.push(Buffer.from([1]))
    const iter = q[Symbol.asyncIterator]()
    // 消费掉一个，第二个在等待中
    const first = await iter.next()
    expect(first.done).toBe(false)
    const pending = iter.next()
    q.abort()
    const second = await pending
    expect(second.done).toBe(true)
  })

  it('async iterator resolves a waiter once a frame arrives', async () => {
    const q = new BoundedQueue()
    const next = q[Symbol.asyncIterator]().next()
    q.push(Buffer.from([7]))
    const r = await next
    expect(r.done).toBe(false)
    expect((r.value as Buffer)[0]).toBe(7)
  })
})

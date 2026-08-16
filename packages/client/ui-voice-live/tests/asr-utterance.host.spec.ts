/** AsrUtterance owns exactly one bounded source, cancellation signal and callback lifecycle. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AsrResult, AsrStreamOptions } from '../src/host/volcengine.ts'
import type { BoundedQueue } from '../src/host/bounded-queue.ts'

const h = vi.hoisted(() => ({
  onText: null as ((result: AsrResult) => void) | null,
  source: null as BoundedQueue | null,
  options: null as AsrStreamOptions | null,
  resolve: null as (() => void) | null,
  reject: null as ((error: Error) => void) | null,
}))

vi.mock('../src/host/volcengine.ts', () => ({
  asrStream: (
    source: BoundedQueue,
    _key: string,
    onText: (result: AsrResult) => void,
    options: AsrStreamOptions,
  ) => {
    h.source = source
    h.onText = onText
    h.options = options
    return new Promise<void>((resolve, reject) => {
      h.resolve = resolve
      h.reject = reject
    })
  },
}))

import { AsrUtterance } from '../src/host/asr-utterance.ts'

beforeEach(() => {
  h.onText = null
  h.source = null
  h.options = null
  h.resolve = null
  h.reject = null
})

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(() => { resolve() }) })
}

describe('AsrUtterance', () => {
  it('trims/dispatches partial + final, ends normally and settles once', async () => {
    const onFinal = vi.fn()
    const onPartial = vi.fn()
    const onError = vi.fn()
    const onSettled = vi.fn()
    const turn = new AsrUtterance('key', 'u1', onFinal, onPartial, onError, onSettled)
    expect(turn.id).toBe('u1')
    expect(turn.isFinished).toBe(false)
    expect(turn.push(Buffer.from([1]))).toBe(true)
    turn.start()
    expect(h.options).toMatchObject({ endpointingMs: 800, minSpeechMs: 1000 })
    h.onText?.({ text: '  partial  ', is_final: false, utterances: [], raw: {} })
    h.onText?.({ text: '   ', is_final: false, utterances: [], raw: {} })
    h.onText?.({ text: '  final  ', is_final: true, utterances: [], raw: {} })
    h.onText?.({ text: '', is_final: true, utterances: [], raw: {} })
    expect(onPartial).toHaveBeenCalledOnce()
    expect(onPartial).toHaveBeenCalledWith('partial')
    expect(onFinal).toHaveBeenCalledOnce()
    expect(onFinal).toHaveBeenCalledWith('final')
    turn.end()
    turn.end()
    expect(h.source?.isEnded).toBe(true)
    h.resolve?.()
    await tick()
    expect(turn.isFinished).toBe(true)
    expect(onSettled).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(turn.push(Buffer.from([2]))).toBe(false)
    turn.cancel()
  })

  it('reports provider failure when live and suppresses it after cancellation', async () => {
    const onError = vi.fn()
    const failed = new AsrUtterance('key', 'u2', vi.fn(), vi.fn(), onError)
    failed.start()
    h.reject?.(new Error('provider down'))
    await tick()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'provider down' }))

    const cancelledError = vi.fn()
    const cancelled = new AsrUtterance('key', 'u3', vi.fn(), vi.fn(), cancelledError)
    cancelled.start()
    cancelled.cancel()
    cancelled.cancel()
    expect(h.source?.isAborted).toBe(true)
    expect(h.options?.signal?.aborted).toBe(true)
    h.onText?.({ text: 'late', is_final: true, utterances: [], raw: {} })
    h.reject?.(new Error('aborted'))
    await tick()
    expect(cancelledError).not.toHaveBeenCalled()
    expect(cancelled.push(Buffer.from([1]))).toBe(false)
  })

  it('end after cancel is a no-op (finished guard)', async () => {
    const onFinal = vi.fn()
    const onPartial = vi.fn()
    const onError = vi.fn()
    const ut = new AsrUtterance('key', '1', onFinal, onPartial, onError)
    ut.start()
    ut.push(Buffer.alloc(1280))
    ut.cancel()
    ut.end() // finished 后 end 不应 abort/抛错，也不应产生 final
    await new Promise(r => setTimeout(r, 20))
    expect(onFinal).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('rejects an individual frame larger than the bounded queue', () => {
    const turn = new AsrUtterance('key', 'u4', vi.fn(), vi.fn(), vi.fn())
    expect(turn.push(Buffer.alloc(1024 * 1024 + 1))).toBe(false)
  })
})

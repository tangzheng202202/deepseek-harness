/** Package invariant companion reserves the package and returns its disposer. */

import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('ui-voice-live invariant companion', () => {
  it('registers the no-op installer under the package name', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, install: (ctx: unknown, fail: unknown) => void) => {
      install({}, vi.fn())
      return dispose
    })
    const ctx = { invariants: { register } }
    expect(name).toBe('client-ui-voice-live-invariant')
    expect(inject).toEqual(['invariants'])
    expect(await apply(ctx as never)).toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-voice-live', expect.any(Function))
  })
})

/** Host composition owns one /voice upgrade registration and its disposer. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  close: vi.fn(),
  handle: vi.fn(),
  create: vi.fn(),
}))

vi.mock('../src/host/voice-server.ts', () => ({
  createVoiceUpgrade: (...args: unknown[]) => {
    h.create(...args)
    return { close: h.close, handle: h.handle }
  },
}))

import { apply, inject } from '../src/index.ts'

beforeEach(() => {
  h.close.mockClear()
  h.handle.mockClear()
  h.create.mockClear()
})

function context() {
  const effects: Array<() => void> = []
  const registerUpgrade = vi.fn(() => vi.fn())
  const cancel = vi.fn()
  const get = vi.fn(() => ({ cancel }))
  const ctx = {
    webServer: { registerUpgrade },
    agents: { get },
    effect(factory: () => (() => void), _label: string) {
      effects.push(factory())
    },
  }
  return { ctx, effects, registerUpgrade, get, cancel }
}

describe('ui-voice-live host apply', () => {
  it('registers /voice with the environment key and disposes the upgrade owner', () => {
    const previous = process.env.VOLCENGINE_API_KEY
    process.env.VOLCENGINE_API_KEY = 'configured-key'
    try {
      const b = context()
      apply(b.ctx as never)
      expect(inject).toEqual(['webServer', 'agents'])
      expect(h.create).toHaveBeenCalledWith('configured-key', 'zh_female_vv_uranus_bigtts', expect.any(Function))
      expect(b.registerUpgrade).toHaveBeenCalledWith({ path: '/voice', handler: h.handle })
      b.effects.forEach((dispose) => { dispose() })
      expect(h.close).toHaveBeenCalledOnce()
      // barge-in 取消回调：命中 agents 服务并取消对应会话（user 打断）
      const cancelAgent = h.create.mock.calls[0]?.[2] as (id: string) => void
      expect(cancelAgent).toBeTypeOf('function')
      cancelAgent('dsh-sess-9')
      expect(b.get).toHaveBeenCalledWith(expect.objectContaining({}))
      expect(b.cancel).toHaveBeenCalledWith({ kind: 'user' })
    } finally {
      if (previous === undefined) delete process.env.VOLCENGINE_API_KEY
      else process.env.VOLCENGINE_API_KEY = previous
    }
  })

  it('uses an empty backend key when the environment is absent', () => {
    const previous = process.env.VOLCENGINE_API_KEY
    delete process.env.VOLCENGINE_API_KEY
    try {
      apply(context().ctx as never)
      expect(h.create).toHaveBeenCalledWith('', 'zh_female_vv_uranus_bigtts', expect.any(Function))
    } finally {
      if (previous !== undefined) process.env.VOLCENGINE_API_KEY = previous
    }
  })

  it('空 dshSessionId 不触发 agent 取消（防御分支）', () => {
    const previous = process.env.VOLCENGINE_API_KEY
    process.env.VOLCENGINE_API_KEY = 'configured-key'
    try {
      const b = context()
      apply(b.ctx as never)
      const cancelAgent = h.create.mock.calls[0]?.[2] as (id: string) => void
      cancelAgent('')
      expect(b.get).not.toHaveBeenCalled()
      expect(b.cancel).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.VOLCENGINE_API_KEY
      else process.env.VOLCENGINE_API_KEY = previous
    }
  })
})

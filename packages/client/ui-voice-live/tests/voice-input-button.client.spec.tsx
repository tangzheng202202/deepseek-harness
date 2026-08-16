// @vitest-environment jsdom
/** Mic adapter: framework session data drives reply narration; no DOM transcript scan exists. */

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

interface FakeControllerInstance {
  active: boolean
  callbacks: Record<'onState' | 'onPartial' | 'onFinal' | 'onError', (value: string) => void>
  start: Mock<() => Promise<void>>
  stop: Mock<() => void>
  cancel: Mock<() => void>
  pushReplyText: Mock<(text: string) => void>
  flushReply: Mock<() => void>
  endReply: Mock<() => void>
}

const h = vi.hoisted(() => ({ instances: [] as FakeControllerInstance[] }))
vi.mock('../src/client/VoiceController.ts', () => ({
  VoiceController: class {
    active = false
    start = vi.fn(async () => { this.active = true })
    stop = vi.fn(() => { this.active = false })
    cancel = vi.fn(() => { this.active = false })
    pushReplyText = vi.fn()
    flushReply = vi.fn()
    endReply = vi.fn()
    constructor(readonly callbacks: FakeControllerInstance['callbacks']) {
      h.instances.push(this)
    }
    get isActive(): boolean { return this.active }
  },
}))

import { VoiceInputButton } from '../src/client/VoiceInputButton.tsx'

afterEach(cleanup)
beforeEach(() => { h.instances = [] })

const t = (key: string): string => ({
  'voice.mic': '开始语音',
  'voice.micActive': '停止语音',
}[key] ?? key)

describe('VoiceInputButton', () => {
  it('routes mic, transcript, authoritative reply deltas, rollback, error and unmount', async () => {
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    let snapshot: Record<string, unknown> = { running: false, partial: null }
    const useSession = vi.fn((selector: (value: Record<string, unknown>) => unknown) => selector(snapshot))
    const props = { inputActions, useSession, t } as unknown as Parameters<typeof VoiceInputButton>[0]
    const view = render(<VoiceInputButton {...props} />)
    const button = view.container.querySelector('button')!
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    const controller = h.instances[0]!
    expect(controller.start).toHaveBeenCalledOnce()
    await act(async () => { controller.callbacks.onState('listening') })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(controller.stop).toHaveBeenCalledOnce()

    await act(async () => { controller.callbacks.onPartial('部分') })
    expect(inputActions.setDraft).toHaveBeenCalledWith('部分')
    await act(async () => { controller.callbacks.onFinal('完整问题') })
    expect(inputActions.setDraft).toHaveBeenCalledWith('完整问题')
    expect(inputActions.submit).toHaveBeenCalledOnce()

    snapshot = {
      running: true,
      partial: {
        blocks: [
          { kind: 'reasoning', text: '不朗读思考' },
          { kind: 'text', text: '第一句。' },
          { kind: 'tool-call', text: '不朗读工具' },
        ],
      },
    }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.pushReplyText).toHaveBeenLastCalledWith('第一句。')

    snapshot = { running: true, partial: { blocks: [{ kind: 'text', text: '第一句。第二句。' }] } }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.pushReplyText).toHaveBeenLastCalledWith('第二句。')

    // 极少数流回退：水位归零，按当前权威正文重新开始。
    snapshot = { running: true, partial: { blocks: [{ kind: 'text', text: '改写。' }] } }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.pushReplyText).toHaveBeenLastCalledWith('改写。')

    snapshot = { running: false, partial: null }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.flushReply).toHaveBeenCalledOnce()
    expect(controller.endReply).toHaveBeenCalledOnce()

    await act(async () => { controller.callbacks.onError('麦克风失败') })
    expect(button.getAttribute('aria-label')).toBe('麦克风失败')
    view.unmount()
    expect(controller.cancel).toHaveBeenCalledOnce()
  })
})

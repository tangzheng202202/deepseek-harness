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

/** 唤醒检测器桩：组件挂载时注册，测试可触发 onWake 断言自动开始。 */
const wakeH = vi.hoisted(() => ({
  detector: null as null | {
    start: Mock<() => Promise<boolean>>
    stop: Mock<() => void>
    onWake: () => void
  },
}))
vi.mock('../src/client/wake-word.ts', () => ({
  createWakeWordDetector: (_keyword: string, onWake: () => void) => {
    const d = { start: vi.fn(async () => true), stop: vi.fn(), onWake }
    wakeH.detector = d
    return d
  },
}))

import { VoiceInputButton } from '../src/client/VoiceInputButton.tsx'

afterEach(cleanup)
beforeEach(() => {
  h.instances = []
  wakeH.detector = null
  localStorage.clear()
})

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

  it('handles null partial, non-voice turns and no-delta turns without narration', async () => {
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    let snapshot: Record<string, unknown> = { running: false, partial: null }
    const useSession = vi.fn((selector: (value: Record<string, unknown>) => unknown) => selector(snapshot))
    const props = { inputActions, useSession, t } as unknown as Parameters<typeof VoiceInputButton>[0]
    const view = render(<VoiceInputButton {...props} />)
    fireEvent.click(view.container.querySelector('button')!) // 创建 controller
    const controller = h.instances[0]!

    // 语音回合启动：先经 onFinal 置位 voiceTurn，再 running true
    await act(async () => { controller.callbacks.onFinal('问题') })
    snapshot = { running: true, partial: null }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.pushReplyText).not.toHaveBeenCalled()

    // 无增量：spokenLen 已等于正文长度 → 不重复推送
    snapshot = { running: true, partial: { blocks: [{ kind: 'text', text: '第一句。' }] } }
    view.rerender(<VoiceInputButton {...props} />)
    snapshot = { running: true, partial: { blocks: [{ kind: 'text', text: '第一句。' }] } }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.pushReplyText).toHaveBeenCalledTimes(1)

    // 语音回合结束：flush 尾巴并结束应答模式（正确行为）
    snapshot = { running: false, partial: null }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.flushReply).toHaveBeenCalledTimes(1)
    expect(controller.endReply).toHaveBeenCalledTimes(1)
  })

  it('开启唤醒时挂载常驻检测器，命中唤醒词自动开始语音会话', async () => {
    localStorage.setItem('dsh-voice-wake', '1')
    localStorage.setItem('dsh-voice-wakeword', '你好小戴')
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    const useSession = vi.fn((selector: (value: Record<string, unknown>) => unknown) => selector({ running: false, partial: null }))
    const props = { inputActions, useSession, t } as unknown as Parameters<typeof VoiceInputButton>[0]
    const view = render(<VoiceInputButton {...props} />)
    expect(wakeH.detector).not.toBeNull()
    expect(wakeH.detector?.start).toHaveBeenCalledOnce()

    // 识别到唤醒词 → 自动进入语音会话
    await act(async () => { wakeH.detector!.onWake() })
    expect(h.instances.length).toBe(1)
    expect(h.instances[0]!.start).toHaveBeenCalledOnce()

    // 卸载 → 检测器停止；停止后迟到的唤醒不再开始新会话（stopped 守卫）
    view.unmount()
    expect(wakeH.detector?.stop).toHaveBeenCalledOnce()
    await act(async () => { wakeH.detector!.onWake() })
    expect(h.instances.length).toBe(1) // 不再创建新 controller
  })

  it('非语音回合的 running 状态不推送回复文本', async () => {
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    let snapshot: Record<string, unknown> = { running: false, partial: null }
    const useSession = vi.fn((selector: (value: Record<string, unknown>) => unknown) => selector(snapshot))
    const props = { inputActions, useSession, t } as unknown as Parameters<typeof VoiceInputButton>[0]
    const view = render(<VoiceInputButton {...props} />)
    fireEvent.click(view.container.querySelector('button')!) // 创建 controller
    const controller = h.instances[0]!

    // running=true 但 voiceTurn 未置位（非语音发起回合）→ 不朗读
    snapshot = { running: true, partial: { blocks: [{ kind: 'text', text: '不该朗读' }] } }
    view.rerender(<VoiceInputButton {...props} />)
    expect(controller.pushReplyText).not.toHaveBeenCalled()
    expect(controller.flushReply).not.toHaveBeenCalled()
    expect(controller.endReply).not.toHaveBeenCalled()
  })
})

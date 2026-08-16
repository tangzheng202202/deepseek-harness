// @vitest-environment jsdom
/** Settings UI persists choices and renders event-driven preview outcomes. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('../src/client/usePipelineVoice.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/usePipelineVoice.ts')>(),
  previewVoice: h.preview,
}))

import { VoiceSettingsSection } from '../src/client/VoiceSettingsSection.tsx'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  h.preview.mockReset()
})

const t = (key: string): string => ({
  'voice.heading': '语音交互',
  'voice.provider': '服务商',
  'voice.voice': '音色',
  'voice.hint': '说明',
  'voice.backendKeyHint': '后端密钥说明',
  'voice.aecProbeAction': '检测',
  'voice.aecOn': '浏览器已对麦克风应用回声消除',
  'voice.aecUnavailable': '无法访问麦克风',
  'voice.wakeProbe': '检测唤醒',
  'voice.wakeProbeBusy': '检测中…',
  'voice.wakeUnsupported': '当前浏览器不支持 Web Speech 语音识别',
  'voice.wakeOk': '浏览器语音识别可用',
  'voice.wakeError': '语音识别出错',
  'voice.wakeUnavailable': '语音识别无法启动',
  'voice.wakeNetworkHint': 'Chrome 依赖 Google 语音服务',
}[key] ?? key)

describe('VoiceSettingsSection', () => {
  it('renders provider/voice choices and persists selection without module-global state', () => {
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const selects = view.container.querySelectorAll('select')
    expect(selects).toHaveLength(2)
    fireEvent.change(selects[0]!, { target: { value: 'volcengine' } })
    fireEvent.change(selects[1]!, { target: { value: 'zh_male_m191_uranus_bigtts' } })
    expect(localStorage.getItem('dsh-voice-provider')).toBe('volcengine')
    expect(localStorage.getItem('dsh-voice')).toBe('zh_male_m191_uranus_bigtts')
    expect(screen.getByText('后端密钥说明')).toBeTruthy()
  })

  it('disables preview while pending and renders both success and failure', async () => {
    let answer!: (value: { ok: boolean; message: string }) => void
    h.preview.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const button = view.container.querySelector('button')!
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('…')
    await act(async () => { answer({ ok: true, message: '试听成功' }) })
    expect(button.disabled).toBe(false)
    expect(screen.getByText('试听成功')).toBeTruthy()

    h.preview.mockResolvedValueOnce({ ok: false, message: '后端不可用' })
    fireEvent.click(button)
    await act(async () => {})
    expect(screen.getByText('后端不可用')).toBeTruthy()
  })
})

describe('VoiceSettingsSection reply-first toggle', () => {
  it('toggles the reply-first checkbox and persists the choice', () => {
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const checkbox = view.container.querySelector('input[type="checkbox"]')!
    expect((checkbox as HTMLInputElement).checked).toBe(true) // 默认开
    fireEvent.click(checkbox)
    expect(localStorage.getItem('dsh-voice-reply-first')).toBe('0')
    fireEvent.click(checkbox)
    expect(localStorage.getItem('dsh-voice-reply-first')).toBe('1')
  })
})

describe('VoiceSettingsSection 唤醒词', () => {
  it('开启唤醒后显示唤醒词输入并可持久化', () => {
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const checkboxes = view.container.querySelectorAll('input[type="checkbox"]')
    const wake = checkboxes[1]!
    fireEvent.click(wake) // 开启唤醒
    expect(localStorage.getItem('dsh-voice-wake')).toBe('1')
    const input = view.container.querySelector('input[type="text"]')!
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: '小戴小戴' } })
    expect(localStorage.getItem('dsh-voice-wakeword')).toBe('小戴小戴')
  })

  it('唤醒可用性探针：jsdom 无 SpeechRecognition → 提示浏览器不支持', async () => {
    const w = window as unknown as Record<string, unknown>
    delete w.SpeechRecognition
    delete w.webkitSpeechRecognition
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const checkboxes = view.container.querySelectorAll('input[type="checkbox"]')
    fireEvent.click(checkboxes[1]!) // 开启唤醒 → 显示探针
    const probe = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent === '检测唤醒')!
    expect(probe).toBeTruthy()
    fireEvent.click(probe)
    await act(async () => {})
    expect(view.container.textContent).toContain('当前浏览器不支持 Web Speech 语音识别')
  })

  it('唤醒可用性探针：构造器存在时短暂启动并报告可用', async () => {
    class FakeRecognition {
      onerror: ((e: { error: string }) => void) | null = null
      onresult: (() => void) | null = null
      start(): void {}
      abort(): void {}
    }
    const w = window as unknown as Record<string, unknown>
    w.SpeechRecognition = FakeRecognition
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const checkboxes = view.container.querySelectorAll('input[type="checkbox"]')
    fireEvent.click(checkboxes[1]!)
    const probe = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent === '检测唤醒')!
    fireEvent.click(probe)
    await act(async () => { await new Promise(r => setTimeout(r, 1600)) })
    expect(view.container.textContent).toContain('浏览器语音识别可用')
  })

  it('唤醒可用性探针：start 抛错（权限拒绝）→ 显示具体原因', async () => {
    class ThrowingRecognition {
      onerror: ((e: { error: string }) => void) | null = null
      onresult: (() => void) | null = null
      start(): void { throw new Error('not allowed') }
      abort(): void {}
    }
    const w = window as unknown as Record<string, unknown>
    w.SpeechRecognition = ThrowingRecognition
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const checkboxes = view.container.querySelectorAll('input[type="checkbox"]')
    fireEvent.click(checkboxes[1]!)
    const probe = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent === '检测唤醒')!
    fireEvent.click(probe)
    await act(async () => {})
    expect(view.container.textContent).toContain('not allowed')
  })

  it('唤醒可用性探针：识别联网失败（network）→ 显示错误原因', async () => {
    class NetworkFailRecognition {
      onerror: ((e: { error: string }) => void) | null = null
      onresult: (() => void) | null = null
      start(): void {
        // Chrome 国内网络：start 成功后立即报 network 错误
        this.onerror?.({ error: 'network' })
      }
      abort(): void {}
    }
    const w = window as unknown as Record<string, unknown>
    w.SpeechRecognition = NetworkFailRecognition
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const checkboxes = view.container.querySelectorAll('input[type="checkbox"]')
    fireEvent.click(checkboxes[1]!)
    const probe = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent === '检测唤醒')!
    fireEvent.click(probe)
    await act(async () => { await new Promise(r => setTimeout(r, 1600)) })
    expect(view.container.textContent).toContain('语音识别出错: network')
  })
})

describe('VoiceSettingsSection AEC probe', () => {
  it('reports whether the browser applied AEC to the mic track', async () => {
    const tracks = [{ getSettings: () => ({ echoCancellation: true }), stop: vi.fn() }]
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => tracks })) },
    })
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const buttons = view.container.querySelectorAll('button')
    const probe = Array.from(buttons).find(b => b.textContent === '检测')!
    fireEvent.click(probe)
    await act(async () => {})
    expect(tracks[0]!.stop).toHaveBeenCalled()
    expect(view.container.textContent).toContain('浏览器已对麦克风应用回声消除')
    vi.unstubAllGlobals()
  })

  it('reports an unavailable mic', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error('denied') }) },
    })
    const view = render(<VoiceSettingsSection {...({ t } as unknown as Parameters<typeof VoiceSettingsSection>[0])} />)
    const buttons = view.container.querySelectorAll('button')
    const probe = Array.from(buttons).find(b => b.textContent === '检测')!
    fireEvent.click(probe)
    await act(async () => {})
    expect(view.container.textContent).toContain('无法访问麦克风')
    vi.unstubAllGlobals()
  })
})

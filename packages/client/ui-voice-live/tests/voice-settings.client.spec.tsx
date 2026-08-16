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

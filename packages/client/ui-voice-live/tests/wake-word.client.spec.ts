// @vitest-environment jsdom
/** 唤醒词检测器：Web Speech API 实现的行为。 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createWakeWordDetector, isSpeechRecognitionAvailable, WebSpeechWakeWord } from '../src/client/wake-word.ts'

/** 可编程 SpeechRecognition fake（模块级共享，测试可触发其结果）。 */
let lastRec: FakeRecognition | null = null
class FakeRecognition {
  continuous = false
  interimResults = false
  lang = ''
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  started = false
  constructor() { lastRec = this } // oxlint-disable-line no-this-alias -- 测试桩需暴露实例供触发结果
  start(): void { this.started = true }
  stop(): void { this.started = false }
  abort(): void { this.started = false }
}

function installSpeech(available: boolean): void {
  const w = window as unknown as Record<string, unknown>
  if (available) {
    w.SpeechRecognition = FakeRecognition
  } else {
    delete w.SpeechRecognition
    delete w.webkitSpeechRecognition
  }
}

function fireResult(text: string): void {
  lastRec?.onresult?.({ resultIndex: 0, results: [[{ transcript: text }]] })
}

beforeEach(() => {
  lastRec = null
  installSpeech(false)
})

describe('WebSpeechWakeWord', () => {
  it('listens continuously in zh-CN and fires onWake only for the keyword', async () => {
    installSpeech(true)
    const onWake = vi.fn()
    const det = new WebSpeechWakeWord('你好小戴', onWake)
    const ok = await det.start()
    expect(ok).toBe(true)
    expect(det.active).toBe(true)
    expect(lastRec?.continuous).toBe(true)
    expect(lastRec?.lang).toBe('zh-CN')

    fireResult('今天天气不错')
    expect(onWake).not.toHaveBeenCalled()
    fireResult('你好小戴，帮我查一下')
    expect(onWake).toHaveBeenCalledTimes(1)
    fireResult('你好小戴')
    expect(onWake).toHaveBeenCalledTimes(2)

    det.stop()
    expect(det.active).toBe(false)
    expect(lastRec?.started).toBe(false)
  })

  it('returns false when SpeechRecognition is unavailable', async () => {
    const det = new WebSpeechWakeWord('你好', vi.fn())
    const ok = await det.start()
    expect(ok).toBe(false)
    expect(det.active).toBe(false)
  })

  it('start() 抛错（如权限拒绝）→ 返回 false 且不激活', async () => {
    class ThrowingRecognition extends FakeRecognition {
      override start(): void { throw new Error('not allowed') }
    }
    const w = window as unknown as Record<string, unknown>
    w.SpeechRecognition = ThrowingRecognition
    const det = new WebSpeechWakeWord('你好', vi.fn())
    const ok = await det.start()
    expect(ok).toBe(false)
    expect(det.active).toBe(false)
  })

  it('onerror 记录失败原因（供设置页诊断，如 Chrome 国内 network）', async () => {
    installSpeech(true)
    const det = new WebSpeechWakeWord('你好', vi.fn())
    const ok = await det.start()
    expect(ok).toBe(true)
    lastRec?.onerror?.({ error: 'network' })
    expect(det.lastError).toBe('network')
    det.stop()
  })

  it('API 缺失时 lastError 记录原因', async () => {
    const det = new WebSpeechWakeWord('你好', vi.fn())
    const ok = await det.start()
    expect(ok).toBe(false)
    expect(det.lastError).not.toBe('')
  })

  it('isSpeechRecognitionAvailable 反映构造器存在性', () => {
    installSpeech(false)
    expect(isSpeechRecognitionAvailable()).toBe(false)
    installSpeech(true)
    expect(isSpeechRecognitionAvailable()).toBe(true)
  })

  it('createWakeWordDetector 工厂返回 Web Speech 实现', () => {
    expect(createWakeWordDetector('你好', vi.fn())).toBeInstanceOf(WebSpeechWakeWord)
  })
})

/**
 * 唤醒词检测器在无浏览器环境（node）下的行为：`window` 未定义时
 * 无法取得 SpeechRecognition 构造器，start() 返回 false（不抛错）。
 * 与 wake-word.client.spec.ts（jsdom）互补，覆盖 speechRecognitionCtor 的
 * 无 window 分支。
 */

import { describe, expect, it, vi } from 'vitest'
import { createWakeWordDetector } from '../src/client/wake-word.ts'

describe('WebSpeechWakeWord（node 环境）', () => {
  it('window 未定义时 start 返回 false 且不激活', async () => {
    expect(typeof window).toBe('undefined')
    const det = createWakeWordDetector('你好', vi.fn())
    const ok = await det.start()
    expect(ok).toBe(false)
    expect(det.active).toBe(false)
    det.stop() // 无 recognition → abort 静默
  })
})

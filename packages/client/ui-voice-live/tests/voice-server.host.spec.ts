/**
 * /voice 协议行为（stage 1：稳定半双工）。
 * 覆盖任务书必测项：
 *  - 50 段音频 → 每段恰好一个 final、顺序一致；
 *  - 纯静音 → 零提交（能量仅作提示，不作为句界）；
 *  - 多句 TTS → tts_push 串行不重叠、顺序一致；
 *  - 畸形/超大/乱序（voiceSessionId 不匹配）控制消息被拒绝；
 *  - 双会话隔离：不叙述另一个会话的回复；
 *  - 伪造 Host 的 WebSocket upgrade 被 403 拒绝。
 * volcengine.ts 以 vi.mock 替换为可编程双工桩（不触网）。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { createVoiceUpgrade } from '../src/host/voice-server.ts'

/** 可编程火山双工桩的状态（在 vi.mock 工厂内通过 hoisted 共享）。 */
const h = vi.hoisted(() => ({
  asrCalls: 0,
  asrChunks: [] as Buffer[],
  ttsActive: 0,
  ttsMaxActive: 0,
  ttsTexts: [] as string[],
  reset() {
    this.asrCalls = 0
    this.asrChunks = []
    this.ttsActive = 0
    this.ttsMaxActive = 0
    this.ttsTexts = []
  },
}))

vi.mock('../src/host/volcengine.ts', () => ({
  VolcengineVoiceError: class extends Error {},
  async asrStream(
    source: AsyncIterable<Buffer>,
    _apiKey: string,
    onText: (r: { text: string; is_final: boolean; utterances: unknown[]; raw: Record<string, unknown> }) => void,
  ) {
    h.asrCalls++
    const call = h.asrCalls
    let bytes = 0
    for await (const chunk of source) {
      h.asrChunks.push(chunk)
      bytes += chunk.length
    }
    if (bytes >= 2 * 1280) {
      // 模拟服务端端点检测：音频结束后返回 partial + definite final
      await new Promise(r => setTimeout(r, 10))
      onText({ text: `partial-${call}`, is_final: false, utterances: [], raw: {} })
      onText({ text: `final-${call}`, is_final: true, utterances: [], raw: {} })
    }
  },
  async ttsStream(
    text: string,
    _voice: string,
    _apiKey: string,
    onChunk: ((chunk: Buffer) => void) | undefined,
  ) {
    h.ttsActive++
    h.ttsMaxActive = Math.max(h.ttsMaxActive, h.ttsActive)
    h.ttsTexts.push(text)
    await new Promise(r => setTimeout(r, 10))
    onChunk?.(Buffer.from('MP3FAKE'))
    h.ttsActive--
  },
}))

/** 40ms @16k Int16 mono 人声帧（RMS≈8000，超过能量提示阈值）。 */
function voiceFrame(n = 1280): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i += 2) b.writeInt16LE(8000, i)
  return b
}

/** 低能量帧（RMS=100 < 启动阈值 300）：识别已启动后必须原样交给服务端 VAD。 */
function lowEnergyFrame(): Buffer {
  const b = Buffer.alloc(1280)
  for (let i = 0; i < 1280; i += 2) b.writeInt16LE(100, i)
  return b
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface TestCtx {
  client: WebSocket
  sessionId: string
  close: () => Promise<void>
}

async function setup(): Promise<TestCtx> {
  h.reset()
  const upgrade = createVoiceUpgrade('test-key', 'zh_female_vv_uranus_bigtts')
  const server = createServer()
  server.on('upgrade', (req, socket, head) => upgrade.handle(req, socket, head))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const client = new WebSocket(`ws://127.0.0.1:${port}/voice`, {
    origin: `http://127.0.0.1:${port}`,
  })
  const ready = await waitForMsg(client, m => m.type === 'ready')
  const sessionId = String(ready.voiceSessionId)
  client.send(JSON.stringify({ type: 'asr_start', voiceSessionId: sessionId }))
  return {
    client,
    sessionId,
    close: async () => {
      client.close()
      await new Promise<void>((r) => {
        if (client.readyState === WebSocket.CLOSED) { r(); return }
        client.once('close', () => r())
      })
      upgrade.close()
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

function waitForMsg(
  client: WebSocket,
  pred: (m: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMsg)
      reject(new Error('waitForMsg timeout'))
    }, timeoutMs)
    function onMsg(data: WebSocket.RawData): void {
      const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      let m: Record<string, unknown>
      try { m = JSON.parse(s) } catch { return }
      if (pred(m)) {
        clearTimeout(timer)
        client.off('message', onMsg)
        resolve(m)
      }
    }
    client.on('message', onMsg)
  })
}

function waitForCount(
  client: WebSocket,
  pred: (m: Record<string, unknown>) => boolean,
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = 0
    const timer = setTimeout(() => {
      client.off('message', onMsg)
      reject(new Error(`waitForCount timeout: seen ${seen}/${count}`))
    }, timeoutMs)
    function onMsg(data: WebSocket.RawData): void {
      const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      let m: Record<string, unknown>
      try { m = JSON.parse(s) } catch { return }
      if (pred(m)) {
        seen++
        if (seen >= count) {
          clearTimeout(timer)
          client.off('message', onMsg)
          resolve()
        }
      }
    }
    client.on('message', onMsg)
  })
}

function textOf(data: WebSocket.RawData): string {
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
}

afterEach(() => h.reset())

describe('ASR：50 段音频 exactly-once 有序', () => {
  it('每段恰好一个 final，顺序一致、无重复', async () => {
    const { client, sessionId, close } = await setup()
    try {
      const finals: string[] = []
      client.on('message', (data) => {
        if (data instanceof ArrayBuffer || Array.isArray(data)) return
        try {
          const m = JSON.parse(textOf(data)) as { type?: string; text?: string }
          if (m.type === 'asr_final') finals.push(String(m.text))
        } catch { /* ignore */ }
      })

      for (let i = 0; i < 50; i++) {
        if (i > 0) client.send(JSON.stringify({ type: 'asr_start', voiceSessionId: sessionId }))
        client.send(voiceFrame())
        client.send(voiceFrame())
        client.send(voiceFrame())
        client.send(JSON.stringify({ type: 'asr_end', voiceSessionId: sessionId }))
        await waitForMsg(client, m => m.type === 'asr_final' && m.text === `final-${i + 1}`)
      }

      expect(finals.length).toBe(50)
      for (let i = 0; i < 50; i++) expect(finals[i]).toBe(`final-${i + 1}`)
      expect(new Set(finals).size).toBe(50)
      expect(h.asrCalls).toBe(50)
    } finally {
      await close()
    }
  })

  it('纯静音 → 零提交（不启动识别）', async () => {
    const { client, sessionId, close } = await setup()
    try {
      client.send(Buffer.alloc(1280)) // 全零（RMS=0）
      client.send(Buffer.alloc(1280))
      client.send(JSON.stringify({ type: 'asr_end', voiceSessionId: sessionId }))
      await sleep(150)
      expect(h.asrCalls).toBe(0)
    } finally {
      await close()
    }
  })

  it('识别启动后保留低能量原始帧，由服务端端点检测决定句界', async () => {
    const { client, sessionId, close } = await setup()
    try {
      client.send(voiceFrame()) // 能量帧
      client.send(lowEnergyFrame())
      client.send(lowEnergyFrame())
      client.send(JSON.stringify({ type: 'asr_end', voiceSessionId: sessionId }))
      await waitForMsg(client, m => m.type === 'asr_final')
      expect(h.asrCalls).toBe(1)
      // 低音量语音不能被本地阈值抹掉；三帧都原样含非零采样。
      expect(h.asrChunks.length).toBeGreaterThanOrEqual(3)
      expect(h.asrChunks[0]?.some(b => b !== 0)).toBe(true)
      expect(h.asrChunks[1]?.some(b => b !== 0)).toBe(true)
      expect(h.asrChunks[2]?.some(b => b !== 0)).toBe(true)
    } finally {
      await close()
    }
  })

  it('asr_cancel → 丢弃，不提交 final', async () => {
    const { client, sessionId, close } = await setup()
    try {
      client.send(voiceFrame())
      client.send(voiceFrame())
      client.send(JSON.stringify({ type: 'asr_cancel', voiceSessionId: sessionId }))
      await sleep(150)
      expect(h.asrCalls).toBe(1) // 启动了
      // 取消后不应有 final 事件
      const gotFinal = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 150)
        const on = (data: WebSocket.RawData) => {
          try {
            const m = JSON.parse(textOf(data))
            if (m.type === 'asr_final') { clearTimeout(t); client.off('message', on); resolve(true) }
          } catch { /* ignore */ }
        }
        client.on('message', on)
      })
      expect(gotFinal).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('TTS：多句串行不重叠', () => {
  it('10 句多句 TTS → 顺序一致、最大并发 1', async () => {
    const { client, close } = await setup()
    try {
      const sentences = Array.from({ length: 10 }, (_, i) => `句子${i + 1}。`)
      const starts: string[] = []
      const dones: string[] = []
      client.on('message', (data) => {
        try {
          const m = JSON.parse(textOf(data)) as { type?: string; text?: string; ttsId?: string }
          if (m.type === 'tts_start') starts.push(String(m.text))
          if (m.type === 'tts_done') dones.push(String(m.ttsId))
        } catch { /* ignore */ }
      })
      client.send(JSON.stringify({ type: 'tts_push', text: sentences.join('') }))
      client.send(JSON.stringify({ type: 'tts_flush' }))
      await waitForCount(client, m => m.type === 'tts_done', 10)
      await sleep(50)
      expect(h.ttsMaxActive).toBeLessThanOrEqual(1)
      expect(h.ttsTexts).toEqual(sentences)
      expect(starts).toEqual(sentences)
      expect(dones.length).toBe(10)
    } finally {
      await close()
    }
  })
})

describe('畸形 / 超大 / 乱序消息拒绝', () => {
  it('畸形 JSON 与未知类型被忽略，连接存活', async () => {
    const { client, close } = await setup()
    try {
      client.send('not-json{{{')
      client.send(JSON.stringify({ type: 'unknown_type', voiceSessionId: 'x' }))
      await sleep(100)
      expect(client.readyState).toBe(WebSocket.OPEN)
      expect(h.asrCalls).toBe(0)
    } finally {
      await close()
    }
  })

  it('超大控制帧与超大二进制帧被拒绝', async () => {
    const { client, close } = await setup()
    try {
      client.send('x'.repeat(64 * 1024 + 1)) // 控制帧 > 64KB
      client.send(Buffer.alloc(1024 * 1024 + 1)) // 二进制帧 > 1MB
      await sleep(100)
      expect(client.readyState).toBe(WebSocket.OPEN)
      expect(h.asrCalls).toBe(0)
    } finally {
      await close()
    }
  })

  it('voiceSessionId 不匹配的 asr_end 被拒绝（乱序/迟到消息）', async () => {
    const { client, sessionId, close } = await setup()
    try {
      let finals = 0
      client.on('message', (data) => {
        try {
          const m = JSON.parse(textOf(data))
          if (m.type === 'asr_final') finals++
        } catch { /* ignore */ }
      })
      client.send(voiceFrame())
      client.send(voiceFrame())
      // 错误 session id 的 asr_end → 不应结束当前 utterance
      client.send(JSON.stringify({ type: 'asr_end', voiceSessionId: 'not-my-session' }))
      await sleep(150)
      expect(finals).toBe(0)
      // 正确 session id 的 asr_end → 正常提交恰好一个 final
      client.send(JSON.stringify({ type: 'asr_end', voiceSessionId: sessionId }))
      await waitForMsg(client, m => m.type === 'asr_final')
      await sleep(50)
      expect(finals).toBe(1)
    } finally {
      await close()
    }
  })

  it('voiceSessionId 不匹配的 tts_push 被拒绝', async () => {
    const { client, close } = await setup()
    try {
      client.send(JSON.stringify({ type: 'tts_push', voiceSessionId: 'stale', text: '不该合成。' }))
      client.send(JSON.stringify({ type: 'tts_flush', voiceSessionId: 'stale' }))
      await sleep(150)
      expect(h.ttsTexts).toEqual([])
    } finally {
      await close()
    }
  })
})

describe('会话隔离', () => {
  it('不叙述另一个会话的回复', async () => {
    const a = await setup()
    const b = await setup()
    try {
      const bFinals: string[] = []
      b.client.on('message', (data) => {
        try {
          const m = JSON.parse(textOf(data))
          if (m.type === 'asr_final') bFinals.push(String(m.text))
        } catch { /* ignore */ }
      })
      a.client.send(voiceFrame())
      a.client.send(voiceFrame())
      a.client.send(JSON.stringify({ type: 'asr_end', voiceSessionId: a.sessionId }))
      await waitForMsg(a.client, m => m.type === 'asr_final')
      await sleep(100)
      expect(bFinals).toEqual([])
      expect(h.asrCalls).toBe(1)
    } finally {
      await a.close()
      await b.close()
    }
  })
})

describe('upgrade 信任（集成级）', () => {
  it('伪造 Host 的 WebSocket upgrade 被 403 拒绝', async () => {
    const upgrade = createVoiceUpgrade('test-key', 'v')
    const server = createServer()
    server.on('upgrade', (req, socket, head) => upgrade.handle(req, socket, head))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port

    const net = await import('node:net')
    const raw = net.connect(port, '127.0.0.1')
    const got: string[] = []
    raw.on('data', (d: Buffer) => got.push(d.toString('utf8')))
    raw.write([
      'GET /voice HTTP/1.1',
      `Host: evil.example:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'))

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no 403')), 1500)
      const poll = () => {
        if (got.join('').includes('403')) { clearTimeout(t); resolve(); return }
        setTimeout(poll, 10)
      }
      poll()
    })
    raw.destroy()
    upgrade.close()
    await new Promise<void>(r => server.close(() => r()))
  })

  it('同源 upgrade 正常握手并收到 ready', async () => {
    const { client, sessionId, close } = await setup()
    try {
      expect(sessionId.length).toBeGreaterThan(0)
      expect(client.readyState).toBe(WebSocket.OPEN)
    } finally {
      await close()
    }
  })
})

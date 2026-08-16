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
import { createVoiceUpgrade, VoiceSession } from '../src/host/voice-server.ts'

/** 可编程火山双工桩的状态（在 vi.mock 工厂内通过 hoisted 共享）。 */
const h = vi.hoisted(() => ({
  asrCalls: 0,
  asrChunks: [] as Buffer[],
  ttsActive: 0,
  ttsMaxActive: 0,
  ttsTexts: [] as string[],
  /** asrStream 行为模式：slow=永不消费（测队列溢出）；midstream-final=流中直接断句。 */
  mode: 'normal' as 'normal' | 'slow' | 'midstream-final',
  /** asrStream 在首个分片后抛错（asr error 路径）。 */
  asrThrow: false,
  /** ttsStream 直接抛错（tts_error 路径）。 */
  ttsThrow: false,
  /** ttsStream 单次合成耗时（ms），默认 10。 */
  ttsDelay: 10,
  reset() {
    this.asrCalls = 0
    this.asrChunks = []
    this.ttsActive = 0
    this.ttsMaxActive = 0
    this.ttsTexts = []
    this.mode = 'normal'
    this.asrThrow = false
    this.ttsThrow = false
    this.ttsDelay = 10
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
    if (h.mode === 'slow') await new Promise(() => {}) // 永不消费：队列可被撑满
    const call = h.asrCalls
    let bytes = 0
    let emittedFinal = false
    for await (const chunk of source) {
      if (h.asrThrow) throw new Error('asr boom')
      h.asrChunks.push(chunk)
      bytes += chunk.length
      if (h.mode === 'midstream-final' && !emittedFinal && bytes >= 2 * 1280) {
        emittedFinal = true
        onText({ text: `final-${call}`, is_final: true, utterances: [], raw: {} })
      }
    }
    if (h.mode !== 'midstream-final' && bytes >= 2 * 1280) {
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
    if (h.ttsThrow) throw new Error('tts boom')
    h.ttsActive++
    h.ttsMaxActive = Math.max(h.ttsMaxActive, h.ttsActive)
    h.ttsTexts.push(text)
    await new Promise(r => setTimeout(r, h.ttsDelay))
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
  server.on('upgrade', (req, socket, head) => { upgrade.handle(req, socket, head) })
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
        client.once('close', () => { r() })
      })
      upgrade.close()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
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
      const m = jsonOf(data)
      if (m === null) return
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
      const m = jsonOf(data)
      if (m === null) return
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
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function jsonOf(data: WebSocket.RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(textOf(data))
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

afterEach(() => { h.reset() })

describe('ASR：50 段音频 exactly-once 有序', () => {
  it('每段恰好一个 final，顺序一致、无重复', async () => {
    const { client, sessionId, close } = await setup()
    try {
      const finals: string[] = []
      client.on('message', (data) => {
        if (data instanceof ArrayBuffer || Array.isArray(data)) return
        const m = jsonOf(data)
        if (m?.type === 'asr_final' && typeof m.text === 'string') finals.push(m.text)
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
        const t = setTimeout(() => { resolve(false) }, 150)
        const on = (data: WebSocket.RawData) => {
          const m = jsonOf(data)
          if (m?.type === 'asr_final') { clearTimeout(t); client.off('message', on); resolve(true) }
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
        const m = jsonOf(data)
        if (m?.type === 'tts_start' && typeof m.text === 'string') starts.push(m.text)
        if (m?.type === 'tts_done' && typeof m.ttsId === 'string') dones.push(m.ttsId)
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
      client.send(JSON.stringify('just-a-string')) // 合法 JSON 但非对象 → 忽略
      client.send(JSON.stringify(42))
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
        const m = jsonOf(data)
        if (m?.type === 'asr_final') finals++
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
        const m = jsonOf(data)
        if (m?.type === 'asr_final' && typeof m.text === 'string') bFinals.push(m.text)
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

describe('barge-in：打断触发 agent 取消', () => {
  it('config 携带 dshSessionId；tts_cancel 时回调取消对应 agent（每连接恰好一次）', async () => {
    h.reset()
    const cancelled: string[] = []
    const upgrade = createVoiceUpgrade('test-key', 'v', (id) => { cancelled.push(id) })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => { upgrade.handle(req, socket, head) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const client = new WebSocket(`ws://127.0.0.1:${port}/voice`, { origin: `http://127.0.0.1:${port}` })
    try {
      const ready = await waitForMsg(client, m => m.type === 'ready')
      const sessionId = String(ready.voiceSessionId)
      // config 带 dshSessionId
      client.send(JSON.stringify({ type: 'config', provider: 'volcengine', voice: 'v', dshSessionId: 'dsh-sess-1' }))
      await sleep(50)
      // tts_cancel 触发 agent 取消回调（携带该会话 id）
      client.send(JSON.stringify({ type: 'tts_cancel', voiceSessionId: sessionId }))
      await sleep(50)
      expect(cancelled).toEqual(['dsh-sess-1'])
      // 重复取消不重复回调（cancelTts 幂等由客户端代次保证，这里只验证一次成功路径）
      expect(client.readyState).toBe(WebSocket.OPEN)
    } finally {
      client.close()
      upgrade.close()
      await new Promise<void>(r => server.close(() => { r() }))
    }
  })

  it('未携带 dshSessionId 时取消回调不被调用', async () => {
    h.reset()
    const cancelled: string[] = []
    const upgrade = createVoiceUpgrade('test-key', 'v', (id) => { cancelled.push(id) })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => { upgrade.handle(req, socket, head) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const client = new WebSocket(`ws://127.0.0.1:${port}/voice`, { origin: `http://127.0.0.1:${port}` })
    try {
      const ready = await waitForMsg(client, m => m.type === 'ready')
      client.send(JSON.stringify({ type: 'config', voice: 'v' }))
      await sleep(50)
      client.send(JSON.stringify({ type: 'tts_cancel', voiceSessionId: String(ready.voiceSessionId) }))
      await sleep(50)
      expect(cancelled).toEqual([])
    } finally {
      client.close()
      upgrade.close()
      await new Promise<void>(r => server.close(() => { r() }))
    }
  })
})

describe('upgrade 信任（集成级）', () => {
  it('伪造 Host 的 WebSocket upgrade 被 403 拒绝', async () => {
    const upgrade = createVoiceUpgrade('test-key', 'v')
    const server = createServer()
    server.on('upgrade', (req, socket, head) => { upgrade.handle(req, socket, head) })
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
      const t = setTimeout(() => { reject(new Error('no 403')) }, 1500)
      const poll = () => {
        if (got.join('').includes('403')) { clearTimeout(t); resolve(); return }
        setTimeout(() => { poll() }, 10)
      }
      poll()
    })
    raw.destroy()
    upgrade.close()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
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

describe('VoiceSession 单元（防御分支）', () => {
  /** 直接驱动 VoiceSession 的伪 ws（readyState=OPEN），记录发送的文本。 */
  function fakeWs(): { readyState: number; send: (d: string) => void; sent: string[] } {
    const sent: string[] = []
    return {
      readyState: 1, // WebSocket.OPEN
      send: (d: string) => { sent.push(d) },
      sent,
    }
  }

  it('空帧不启动识别（能量函数空缓冲分支）', async () => {
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.asrStart()
    s.feedAudio(Buffer.alloc(0))
    expect(h.asrCalls).toBe(0)
    expect(ws.sent).toEqual([])
  })

  it('未开启采集 / 朗读中 / 已释放时丢弃麦克风帧', async () => {
    h.ttsDelay = 300 // 拉长合成窗口，保证断言发生在朗读中
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.feedAudio(voiceFrame()) // 未 asr_start → acceptingAudio=false → 丢弃
    expect(h.asrCalls).toBe(0)
    s.asrStart()
    s.pushTts('句子。') // 触发朗读 → ttsActive=true 硬门控
    await sleep(20) // 等 speak 进入 ttsStream
    s.feedAudio(voiceFrame()) // 朗读中 → 丢弃（防外放朗读声被录成新指令）
    expect(h.asrCalls).toBe(0)
    await sleep(400) // 等 ttsStream 完成、ttsActive 复位
    s.dispose() // disposed → 丢弃
    s.feedAudio(voiceFrame())
    expect(h.asrCalls).toBe(0)
  })

  it('音频队列溢出：取消该轮并上报错误', async () => {
    h.mode = 'slow' // asrStream 永不消费 → 队列可被撑满
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.asrStart()
    s.feedAudio(voiceFrame(1024 * 1024)) // 恰好一帧上限：入队成功
    s.feedAudio(voiceFrame()) // 超出上限 → push false → 溢出
    expect(h.asrCalls).toBe(1)
    const err = ws.sent.find(m => m.includes('overflow'))
    expect(err).toBeDefined()
  })

  it('dispose 后 asr_start / tts_push 为无操作，重复 dispose 幂等', async () => {
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.dispose()
    s.dispose() // 第二次直接返回
    s.asrStart()
    s.pushTts('不该合成。')
    expect(h.asrCalls).toBe(0)
    expect(h.ttsTexts).toEqual([])
    expect(ws.sent).toEqual([])
  })

  it('tts_push 超出待合成上限时报错且不入队', async () => {
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.pushTts('x'.repeat(20001))
    expect(ws.sent.some(m => m.includes('pending text is too large'))).toBe(true)
    await sleep(30)
    expect(h.ttsTexts).toEqual([])
  })

  it('tts_flush 把未断句的残留当作收尾句子合成', async () => {
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.pushTts('没有标点的尾巴')
    await sleep(20) // 无句号 → popSentence 返回 null → 不提前合成
    expect(h.ttsTexts).toEqual([])
    await s.flushTts() // 收尾：残留当一句
    expect(h.ttsTexts).toEqual(['没有标点的尾巴'])
    expect(ws.sent.some(m => m.includes('"tts_idle"'))).toBe(true)
  })

  it('朗读中 tts_cancel：已排队任务代次失效被丢弃，当前句不补发 tts_done', async () => {
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.pushTts('句子一。')
    s.pushTts('句子二。')
    await sleep(5) // job1 已进入 speak（句子一），job2 仍在串行链队列
    expect(h.ttsTexts).toEqual(['句子一。'])
    s.cancelTts() // ttsGeneration++ → job2 代次失效；ttsBuf 清空
    await sleep(60)
    expect(h.ttsTexts).toEqual(['句子一。']) // 句子二被丢弃
    expect(ws.sent.some(m => m.includes('"tts_done"'))).toBe(false) // 当前句代次已过期
  })

  it('TTS 合成失败：发送 tts_error 且不发送 tts_done', async () => {
    h.ttsThrow = true
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.pushTts('句子。')
    await sleep(30)
    expect(ws.sent.some(m => m.includes('"tts_error"'))).toBe(true)
    expect(ws.sent.some(m => m.includes('"tts_done"'))).toBe(false)
  })

  it('ASR 流式出错：上报 asr error 并停止接收', async () => {
    h.asrThrow = true
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.asrStart()
    s.feedAudio(voiceFrame())
    s.feedAudio(voiceFrame())
    await sleep(30)
    expect(ws.sent.some(m => m.includes('"error"') && m.includes('asr:'))).toBe(true)
  })

  it('服务端流中断句（definite final 不依赖 asr_end）：清空当前轮并上报 final', async () => {
    h.mode = 'midstream-final'
    const ws = fakeWs()
    const s = new VoiceSession(ws as never, 'k', 'v')
    s.asrStart()
    s.feedAudio(voiceFrame())
    s.feedAudio(voiceFrame())
    s.feedAudio(voiceFrame())
    await sleep(30)
    expect(ws.sent.some(m => m.includes('"asr_final"'))).toBe(true)
    expect(h.asrCalls).toBe(1)
  })
})

describe('协议边界：超长文本 / 音色参数 / 连接数 / 存活时长', () => {
  it('tts_push 超长文本被拒绝；携带 voice 参数生效', async () => {
    const { client, sessionId, close } = await setup()
    try {
      client.send(JSON.stringify({ type: 'tts_push', voiceSessionId: sessionId, text: 'x'.repeat(10001) }))
      await sleep(50)
      expect(h.ttsTexts).toEqual([])
      client.send(JSON.stringify({ type: 'tts_push', voiceSessionId: sessionId, text: '短句。', voice: 'custom-voice' }))
      await waitForMsg(client, m => m.type === 'tts_start')
      await sleep(20)
      expect(h.ttsTexts).toEqual(['短句。'])
    } finally {
      await close()
    }
  })

  it('tts_flush 携带 voice 参数', async () => {
    const { client, sessionId, close } = await setup()
    try {
      client.send(JSON.stringify({ type: 'tts_push', voiceSessionId: sessionId, text: '尾巴' }))
      client.send(JSON.stringify({ type: 'tts_flush', voiceSessionId: sessionId, voice: 'v2' }))
      await waitForMsg(client, m => m.type === 'tts_idle')
      expect(h.ttsTexts).toEqual(['尾巴'])
    } finally {
      await close()
    }
  })

  it('超过 MAX_CONNECTIONS 的连接被拒绝（1008）', async () => {
    const upgrade = createVoiceUpgrade('test-key', 'v')
    const server = createServer()
    server.on('upgrade', (req, socket, head) => { upgrade.handle(req, socket, head) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const clients: WebSocket[] = []
    const closedCodes: number[] = []
    try {
      for (let i = 0; i < 9; i++) {
        const c = new WebSocket(`ws://127.0.0.1:${port}/voice`, { origin: `http://127.0.0.1:${port}` })
        c.on('close', (code: number) => { closedCodes.push(code) })
        clients.push(c)
      }
      await sleep(300)
      expect(closedCodes.filter(code => code === 1008).length).toBe(1)
      expect(clients.filter(c => c.readyState === WebSocket.OPEN).length).toBe(8)
    } finally {
      clients.forEach((c) => { c.close() })
      upgrade.close()
      await new Promise<void>(r => server.close(() => { r() }))
    }
  })

  it('单连接最长存活：超过 MAX_SESSION_MS 被强制断开', async () => {
    vi.useFakeTimers() // 先于连接建立：让存活计时器挂在 fake timers 上
    const upgrade = createVoiceUpgrade('test-key', 'v')
    const server = createServer()
    server.on('upgrade', (req, socket, head) => { upgrade.handle(req, socket, head) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const client = new WebSocket(`ws://127.0.0.1:${port}/voice`, { origin: `http://127.0.0.1:${port}` })
    try {
      await waitForMsg(client, m => m.type === 'ready')
      const closed = new Promise<void>((r) => { client.once('close', () => { r() }) })
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000)
      vi.useRealTimers()
      await closed
      expect(client.readyState).toBe(WebSocket.CLOSED)
    } finally {
      vi.useRealTimers()
      client.close()
      upgrade.close()
      await new Promise<void>(r => server.close(() => { r() }))
    }
  })
})

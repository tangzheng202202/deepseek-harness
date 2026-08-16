/** 火山协议中与 DSH 回合边界直接相关的纯解析契约。 */

import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import {
  Compression,
  Event,
  Flags,
  isDefiniteAsrResult,
  Message,
  MsgType,
  Serialization,
  VolcengineVoiceError,
} from '../src/host/volcengine.ts'

describe('VolcengineVoiceError', () => {
  it('carries optional server code and payload without exposing credentials', () => {
    const plain = new VolcengineVoiceError('failed')
    expect(plain.message).toBe('failed')
    expect(plain.code).toBeUndefined()
    const coded = new VolcengineVoiceError('failed', 401, { reason: 'auth' })
    expect(coded.name).toBe('VolcengineVoiceError')
    expect(coded.message).toBe('[401] failed')
    expect(coded.payload).toEqual({ reason: 'auth' })
  })
})

describe('Message wire codec', () => {
  it('round-trips sequenced gzip JSON frames', () => {
    const encoded = new Message({
      type: MsgType.FullClientRequest,
      flag: Flags.PositiveSeq,
      serialization: Serialization.JSON,
      compression: Compression.Gzip,
      sequence: 7,
      payload: gzipSync(Buffer.from(JSON.stringify({ hello: '世界' }))),
    }).marshal()
    const decoded = Message.unmarshal(encoded)
    expect(decoded.type).toBe(MsgType.FullClientRequest)
    expect(decoded.sequence).toBe(7)
    expect(decoded.jsonPayload()).toEqual({ hello: '世界' })
  })

  it('round-trips session events, connection events, errors and empty payloads', () => {
    const session = Message.unmarshal(new Message({
      type: MsgType.FullServerResponse,
      flag: Flags.WithEvent,
      event: Event.SessionStarted,
      session_id: 'session-1',
      payload: Buffer.from('{}'),
    }).marshal())
    expect(session.event).toBe(Event.SessionStarted)
    expect(session.session_id).toBe('session-1')

    const connection = Message.unmarshal(new Message({
      type: MsgType.FullClientRequest,
      flag: Flags.WithEvent,
      event: Event.StartConnection,
    }).marshal())
    expect(connection.event).toBe(Event.StartConnection)
    expect(connection.session_id).toBe('')

    const error = Message.unmarshal(new Message({
      type: MsgType.Error,
      error_code: 123,
      payload: Buffer.from('bad'),
    }).marshal())
    expect(error.error_code).toBe(123)
    expect(error.payload.toString()).toBe('bad')

    const last = Message.unmarshal(new Message({
      type: MsgType.FullServerResponse,
      flag: Flags.LastNoSeq,
    }).marshal())
    expect(last.flag).toBe(Flags.LastNoSeq)
    expect(last.jsonPayload()).toBeNull()
  })

  it('parses server connection ids and rejects malformed headers safely', () => {
    const cid = Buffer.from('connection-1')
    const body = Buffer.alloc(4 + 4 + cid.length + 4)
    body.writeInt32BE(Event.ConnectionStarted, 0)
    body.writeUInt32BE(cid.length, 4)
    cid.copy(body, 8)
    body.writeUInt32BE(0, 8 + cid.length)
    const frame = Buffer.concat([
      Buffer.from([0x11, (MsgType.FullServerResponse << 4) | Flags.WithEvent, 0x10, 0]),
      body,
    ])
    expect(Message.unmarshal(frame).connect_id).toBe('connection-1')
    expect(() => Message.unmarshal(Buffer.from([1, 2, 3]))).toThrow(/frame too short/)
    expect(() => Message.unmarshal(Buffer.from([0x10, 0, 0, 0]))).toThrow(/invalid header_size/)
  })

  it('returns null for non-object, invalid and invalid-gzip JSON payloads', () => {
    expect(new Message({ payload: Buffer.from('42') }).jsonPayload()).toBeNull()
    expect(new Message({ payload: Buffer.from('{') }).jsonPayload()).toBeNull()
    expect(new Message({ compression: Compression.Gzip, payload: Buffer.from('not-gzip') }).jsonPayload()).toBeNull()
  })
})

describe('isDefiniteAsrResult', () => {
  it('以最后一个 utterance.definite 作为双向流式句末', () => {
    expect(isDefiniteAsrResult({
      text: '你好。',
      utterances: [{ text: '你好。', definite: true }],
    })).toBe(true)
    expect(isDefiniteAsrResult({
      text: '你好',
      utterances: [{ text: '你好', definite: false }],
    })).toBe(false)
  })

  it('只看最后一个分句，旧 definite 不能提前终止正在增长的新分句', () => {
    expect(isDefiniteAsrResult({
      utterances: [
        { text: '第一句。', definite: true },
        { text: '第二', definite: false },
      ],
    })).toBe(false)
  })

  it('兼容明确的顶层 is_final，并安全处理畸形 utterances', () => {
    expect(isDefiniteAsrResult({ is_final: true })).toBe(true)
    expect(isDefiniteAsrResult({ utterances: [] })).toBe(false)
    expect(isDefiniteAsrResult({ utterances: [null] })).toBe(false)
    expect(isDefiniteAsrResult({ utterances: 'bad' })).toBe(false)
  })
})

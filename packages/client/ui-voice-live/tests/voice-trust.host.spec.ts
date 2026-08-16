/** /voice 信任检查行为（rebinding + 跨站防御），与 client-connection 的 /api 栅栏同构。 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isLoopbackHostname, isTrustedVoiceRequest } from '../src/host/voice-trust.ts'

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isLoopbackHostname', () => {
  it('classifies loopback spellings', () => {
    for (const h of ['localhost', '[::1]', '127.0.0.1', '127.8.9.10']) {
      expect(isLoopbackHostname(h)).toBe(true)
    }
    for (const h of ['192.168.1.5', 'harness.example', '127.0.0.1.1', '127.1']) {
      expect(isLoopbackHostname(h)).toBe(false)
    }
  })
})

describe('isTrustedVoiceRequest', () => {
  it('accepts loopback Hosts in every spelling, with and without ports', () => {
    for (const host of ['localhost', 'localhost:3080', '127.0.0.1', '127.0.0.1:3080', '[::1]', '[::1]:3080']) {
      expect(isTrustedVoiceRequest(req({ host, origin: `http://${host}` }))).toBe(true)
    }
  })

  it('accepts a same-origin browser request with or without an Origin header', () => {
    expect(isTrustedVoiceRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
    expect(isTrustedVoiceRequest(req({ host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })

  it('refuses a rebound or remote Host even when Origin matches that Host', () => {
    expect(isTrustedVoiceRequest(req({ host: 'evil.example:3080', origin: 'http://evil.example:3080' }))).toBe(false)
    expect(isTrustedVoiceRequest(req({ host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' }))).toBe(false)
  })

  it('refuses a missing Host', () => {
    expect(isTrustedVoiceRequest(req({}))).toBe(false)
    expect(isTrustedVoiceRequest(req({ host: '[' }))).toBe(false)
  })

  it('refuses cross-site markers and cross-origin Origin even on a loopback Host', () => {
    expect(isTrustedVoiceRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isTrustedVoiceRequest(req({ host: '127.0.0.1:3080', origin: 'http://evil.example' }))).toBe(false)
    expect(isTrustedVoiceRequest(req({ host: '127.0.0.1:3080', origin: 'null' }))).toBe(false)
  })
})

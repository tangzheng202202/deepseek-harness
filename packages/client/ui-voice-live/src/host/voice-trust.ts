/**
 * /voice WebSocket 信任检查（与 client-connection 的 /api 栅栏同构）。
 * 防御两条浏览器对本地 HTTP 服务的 confused-deputy 路径：
 *  - DNS rebinding：Host 头写着攻击者域名，但 socket 打到了本机服务；
 *  - 跨站请求：恶意页面发起的 WebSocket 握手。
 * 当前只允许 loopback 主机 + 同源 Origin；非本机暴露在信任检查落地前不允许。
 */

import type { IncomingMessage } from 'node:http'

/** 归一化 hostname 是否为本机 loopback（localhost / ::1 / 127/8）。 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 一个 WebSocket upgrade 请求是否被信任：
 *  - Host 必须解析为 loopback 主机（DNS rebinding 防御）；
 *  - sec-fetch-site 为 cross-site 时直接拒绝；
 *  - 浏览器若带 Origin，必须与 Host 同源。
 */
export function isTrustedVoiceRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 拒绝一次 WebSocket upgrade（HTTP 403 后立即断开）。 */
export function rejectWebSocketUpgrade(socket: import('node:stream').Duplex): void {
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  socket.destroy()
}

import { net, session } from 'electron'
import type { ProxyMode } from '../shared/types'

/** 校验并规范化代理地址；返回 null 表示无效 */
export function normalizeProxyUrl(u: string): string | null {
  const s = u.trim()
  if (!s) return null
  const withScheme = /^[a-z0-9]+:\/\//i.test(s) ? s : 'http://' + s
  try {
    const url = new URL(withScheme)
    if (!/^(http|https|socks|socks4|socks5):$/.test(url.protocol)) return null
    if (!url.hostname || !url.port) return null
    return `${url.protocol}//${url.hostname}:${url.port}`
  } catch {
    return null
  }
}

let currentLabel: string | undefined

/** 把代理设置应用到默认会话（模型请求、网页抓取、语音转写都经由 net.fetch 走这里） */
export async function applyProxy(mode: ProxyMode, proxyUrl: string, ses = session.defaultSession): Promise<string> {
  if (mode === 'custom') {
    const u = normalizeProxyUrl(proxyUrl)
    if (!u) throw new Error(`代理地址无效：「${proxyUrl}」。示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080`)
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: u, proxyBypassRules: '<local>;localhost;127.0.0.1;::1' })
    currentLabel = u
  } else if (mode === 'direct') {
    await ses.setProxy({ mode: 'direct' })
    currentLabel = undefined
  } else {
    await ses.setProxy({ mode: 'system' })
    currentLabel = undefined
  }
  await ses.closeAllConnections?.()
  return currentLabel || (mode === 'direct' ? '直连' : '跟随系统')
}

export const proxyLabel = (): string | undefined => currentLabel

/** 使用 Chromium 网络栈（遵循代理设置）的 fetch */
export const netFetch: typeof fetch = ((input: any, init?: any) => net.fetch(input, init)) as typeof fetch

/** 供 Playwright 浏览器使用的代理参数 */
export function playwrightProxy(mode: ProxyMode, proxyUrl: string): { server: string; bypass: string } | undefined {
  if (mode !== 'custom') return undefined
  const u = normalizeProxyUrl(proxyUrl)
  return u ? { server: u, bypass: 'localhost,127.0.0.1' } : undefined
}

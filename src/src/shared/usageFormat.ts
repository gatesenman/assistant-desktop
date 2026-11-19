import type { MessageUsage, UsageNumbers } from './types'

export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (!n) return '$0'
  if (n < 0.0001) return '<$0.0001'
  if (n < 0.01) return '$' + n.toFixed(4)
  if (n < 1) return '$' + n.toFixed(3)
  return '$' + n.toFixed(2)
}

export function fmtCny(usd: number, rate = 7.1): string {
  const n = usd * (rate || 7.1)
  if (!n) return '¥0'
  if (n < 0.001) return '<¥0.001'
  if (n < 1) return '¥' + n.toFixed(3)
  return '¥' + n.toFixed(2)
}

/** 缓存命中率（输入中命中缓存的比例） */
export function hitRate(u: UsageNumbers): number {
  return u.input > 0 ? u.cacheHit / u.input : 0
}

/** 一行用量说明：「输入 12.3k（缓存命中 80%）· 输出 512 · $0.0021 ≈ ¥0.015」 */
export function usageLine(u: MessageUsage, rate = 7.1): string {
  const parts = [`输入 ${fmtTokens(u.input)}${u.cacheHit ? `（缓存命中 ${Math.round(hitRate(u) * 100)}%）` : ''}`, `输出 ${fmtTokens(u.output)}`]
  if (u.reasoning) parts.push(`其中思考 ${fmtTokens(u.reasoning)}`)
  if (u.priced) parts.push(`${fmtUsd(u.cost)} ≈ ${fmtCny(u.cost, rate)}`)
  else parts.push('未定价')
  if (u.calls > 1) parts.push(`${u.calls} 次调用`)
  if (u.estimated) parts.push('估算')
  if (u.peak) parts.push('高峰价')
  return parts.join(' · ')
}

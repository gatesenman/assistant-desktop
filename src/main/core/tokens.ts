import type { ChatMessage } from '../../shared/types'

/** 粗略估算 token 数：CJK 字符约 1 token/字，其它约 4 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) || 0
    if (c >= 0x2e80) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

export const IMAGE_TOKENS = 800

export function messageTokens(m: ChatMessage): number {
  let t = 4 + estimateTokens(m.content || '')
  if (m.images) t += m.images.length * IMAGE_TOKENS
  if (m.toolCalls) for (const tc of m.toolCalls) t += 8 + estimateTokens(tc.name) + estimateTokens(tc.arguments)
  return t
}

/**
 * 按 token 预算从最近的消息往前截取上下文：
 * - 最后一条用户消息及其之后的内容始终保留
 * - 结果总是从 user 消息开始，且不会出现孤立的 tool 消息
 */
export function selectContextByBudget(history: ChatMessage[], budget: number): ChatMessage[] {
  const usable = history.filter((m) => !(m.error && !m.content && !m.toolCalls?.length))
  if (!usable.length) return []
  let lastUser = -1
  for (let i = usable.length - 1; i >= 0; i--)
    if (usable[i].role === 'user') {
      lastUser = i
      break
    }
  if (lastUser < 0) return []
  let start = lastUser
  let used = usable.slice(lastUser).reduce((s, m) => s + messageTokens(m), 0)
  for (let i = lastUser - 1; i >= 0; i--) {
    const t = messageTokens(usable[i])
    if (used + t > budget) break
    used += t
    start = i
  }
  let slice = usable.slice(start)
  while (slice.length && slice[0].role !== 'user') slice = slice.slice(1)
  return slice
}

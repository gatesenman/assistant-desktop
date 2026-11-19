import { describe, expect, it } from 'vitest'
import { estimateTokens, messageTokens, selectContextByBudget } from '../src/main/core/tokens'
import type { ChatMessage } from '../src/shared/types'

const msg = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, createdAt: 0, ...extra })

describe('token budget', () => {
  it('estimates CJK and latin text', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(messageTokens(msg('1', 'user', 'abcd', { images: ['x'] }))).toBe(4 + 1 + 800)
  })

  it('keeps newest messages within budget and starts with user', () => {
    const h: ChatMessage[] = []
    for (let i = 0; i < 20; i++) {
      h.push(msg(`u${i}`, 'user', '问'.repeat(100)))
      h.push(msg(`a${i}`, 'assistant', '答'.repeat(100)))
    }
    const sel = selectContextByBudget(h, 1000)
    expect(sel[0].role).toBe('user')
    expect(sel.at(-1)!.id).toBe('a19')
    const total = sel.reduce((s, m) => s + messageTokens(m), 0)
    expect(total).toBeLessThanOrEqual(1000)
    expect(sel.length).toBe(8)
  })

  it('always keeps the last user turn even if over budget, without orphan tool messages', () => {
    const h: ChatMessage[] = [
      msg('u0', 'user', 'old'),
      msg('a0', 'assistant', '', { toolCalls: [{ id: 't', name: 'x', arguments: '{}', status: 'done' }] }),
      msg('t0', 'tool', 'r'.repeat(4000), { toolCallId: 't' }),
      msg('u1', 'user', '长'.repeat(5000)),
      msg('a1', 'assistant', 'ok')
    ]
    const sel = selectContextByBudget(h, 100)
    expect(sel.map((m) => m.id)).toEqual(['u1', 'a1'])
    const sel2 = selectContextByBudget(h, 6000)
    expect(sel2[0].id).toBe('u1')
    const sel3 = selectContextByBudget(h, 100000)
    expect(sel3.map((m) => m.id)).toEqual(['u0', 'a0', 't0', 'u1', 'a1'])
  })

  it('drops pure error messages and returns [] without user', () => {
    expect(selectContextByBudget([msg('a', 'assistant', 'x')], 100)).toEqual([])
    const sel = selectContextByBudget([msg('u', 'user', 'q'), msg('e', 'assistant', '', { error: 'boom' })], 100)
    expect(sel.map((m) => m.id)).toEqual(['u'])
  })
})

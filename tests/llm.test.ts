import { afterEach, describe, expect, it } from 'vitest'
import { chatCompletionsUrl, streamChat, toApiMessages } from '../src/main/core/llm'
import type { ChatMessage } from '../src/shared/types'
import { startServer, sse, textChunks, toolCallChunks, type MockServer } from './helpers'

let srv: MockServer | null = null
afterEach(async () => {
  await srv?.close()
  srv = null
})

describe('llm', () => {
  it('builds chat completions url', () => {
    expect(chatCompletionsUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions')
    expect(chatCompletionsUrl('https://x/v1/chat/completions')).toBe('https://x/v1/chat/completions')
  })

  it('streams text deltas and sends auth header + tools', async () => {
    srv = await startServer((_b, _q, res) => sse(res, textChunks('你好，世界！这是流式输出。', 4)))
    const deltas: string[] = []
    const r = await streamChat({
      baseUrl: srv.url + '/v1',
      apiKey: 'sk-test',
      model: 'm1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object' } } }],
      onDelta: (d) => deltas.push(d)
    })
    expect(r.content).toBe('你好，世界！这是流式输出。')
    expect(deltas.length).toBeGreaterThan(1)
    expect(r.finishReason).toBe('stop')
    expect(srv.requests[0].url).toBe('/v1/chat/completions')
    expect(srv.requests[0].headers.authorization).toBe('Bearer sk-test')
    expect(srv.requests[0].body.stream).toBe(true)
    expect(srv.requests[0].body.model).toBe('m1')
    expect(srv.requests[0].body.tools).toHaveLength(1)
  })

  it('assembles fragmented tool calls', async () => {
    srv = await startServer((_b, _q, res) =>
      sse(res, toolCallChunks([
        { id: 'c1', name: 'run_shell', args: { command: 'echo hi' } },
        { id: 'c2', name: 'list_dir', args: { path: '/tmp' } }
      ]))
    )
    const r = await streamChat({ baseUrl: srv.url, apiKey: '', model: 'm', messages: [] })
    expect(r.toolCalls).toEqual([
      { id: 'c1', name: 'run_shell', arguments: '{"command":"echo hi"}' },
      { id: 'c2', name: 'list_dir', arguments: '{"path":"/tmp"}' }
    ])
    expect(r.finishReason).toBe('tool_calls')
  })

  it('throws readable error on HTTP failure', async () => {
    srv = await startServer((_b, _q, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"invalid api key"}}')
    })
    await expect(streamChat({ baseUrl: srv.url, apiKey: 'bad', model: 'm', messages: [] })).rejects.toThrow(/401.*invalid api key/)
  })

  it('handles non-streaming JSON responses', async () => {
    srv = await startServer((_b, _q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }] }))
    })
    const r = await streamChat({ baseUrl: srv.url, apiKey: '', model: 'm', messages: [] })
    expect(r.content).toBe('plain')
  })

  it('can be aborted', async () => {
    srv = await startServer((_b, _q, res) => sse(res, textChunks('a'.repeat(50), 50), 50))
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 150)
    await expect(streamChat({ baseUrl: srv.url, apiKey: '', model: 'm', messages: [], signal: ac.signal })).rejects.toThrow()
  })

  it('converts history incl. images and tool calls', () => {
    const h: ChatMessage[] = [
      { id: '1', role: 'user', content: '看图', images: ['data:image/png;base64,AAA'], createdAt: 0 },
      { id: '2', role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'list_dir', arguments: '{}', status: 'done' }], createdAt: 0 },
      { id: '3', role: 'tool', content: 'result', toolCallId: 't1', createdAt: 0 },
      { id: '4', role: 'assistant', content: '完成', createdAt: 0 }
    ]
    const out = toApiMessages('SYS', h) as any[]
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
    expect(out[2].tool_calls[0].function.name).toBe('list_dir')
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'result' })
    expect(out[4]).toEqual({ role: 'assistant', content: '完成' })
  })

  it('injects tool screenshots as a user image message (vision on) and omits them when off', () => {
    const h: ChatMessage[] = [
      { id: '1', role: 'user', content: '截图', createdAt: 0 },
      { id: '2', role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'browser_screenshot', arguments: '{}', status: 'done' }], createdAt: 0 },
      { id: '3', role: 'tool', content: '已截图', toolCallId: 't1', images: ['data:image/jpeg;base64,QQ'], createdAt: 0 },
      { id: '4', role: 'assistant', content: '看到了', createdAt: 0 }
    ]
    const on = toApiMessages('', h, { vision: true }) as any[]
    expect(on.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    expect(on[3].content[1].image_url.url).toBe('data:image/jpeg;base64,QQ')
    const off = toApiMessages('', h, { vision: false }) as any[]
    expect(off.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })
})

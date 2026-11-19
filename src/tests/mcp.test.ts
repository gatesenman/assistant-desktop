import { afterEach, describe, expect, it } from 'vitest'
import path from 'path'
import { HttpTransport, McpClient, McpManager, StdioTransport, exposedToolName, slugify } from '../src/main/core/mcp'
import type { McpServerConfig, McpServerStatus } from '../src/shared/types'
import { startServer, type MockServer } from './helpers'

const serverScript = path.resolve(__dirname, '../scripts/test-mcp-server.mjs')
const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'id-1',
  name: 'demo',
  type: 'stdio',
  command: process.execPath,
  args: [serverScript],
  env: {},
  url: '',
  headers: {},
  enabled: true,
  disabledTools: [],
  autoApprove: false,
  ...over
})

let srv: MockServer | null = null
let mgr: McpManager | null = null
afterEach(async () => {
  await mgr?.closeAll()
  mgr = null
  await srv?.close()
  srv = null
})

describe('mcp naming', () => {
  it('slugifies and namespaces tool names', () => {
    expect(slugify('My Files!', 'x')).toBe('my_files')
    expect(slugify('中文', 'abc-123')).toBe('sabc123')
    expect(exposedToolName('demo', 'read.file')).toBe('mcp__demo__read_file')
    expect(exposedToolName('d', 'x'.repeat(100)).length).toBe(64)
  })
})

describe('mcp stdio client', () => {
  it('initializes, lists and calls tools', async () => {
    const c = new McpClient(new StdioTransport(process.execPath, [serverScript], {}))
    await c.connect()
    expect(c.serverInfo.name).toBe('test-mcp')
    const tools = await c.listTools()
    expect(tools.map((t) => t.name)).toEqual(['add', 'echo', 'fail'])
    expect((await c.callTool('add', { a: 2, b: 3 })).text).toBe('5')
    await expect(c.callTool('fail', {})).rejects.toThrow('故意失败')
    await expect(c.callTool('nope', {})).rejects.toThrow(/unknown tool/)
    await c.close()
  })

  it('reports spawn errors', async () => {
    const c = new McpClient(new StdioTransport('/definitely/not/here', [], {}))
    await expect(c.connect()).rejects.toThrow(/无法启动/)
  })
})

describe('mcp http client', () => {
  it('works with JSON and SSE responses and session ids', async () => {
    let sawSession = false
    srv = await startServer((body, req, res) => {
      if (req.method === 'DELETE') {
        res.writeHead(200)
        return res.end()
      }
      if (req.headers['mcp-session-id'] === 'sess-1') sawSession = true
      if (!body.id) {
        res.writeHead(202)
        return res.end()
      }
      if (body.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'http-mcp' }, capabilities: {} } }))
      }
      if (body.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'time', description: 'now', inputSchema: { type: 'object' } }] } })}\n\n`)
      }
      if (body.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`)
        return res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '12:00' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }] } })}\n\n`)
      }
    })
    const c = new McpClient(new HttpTransport(srv.url + '/mcp', { Authorization: 'Bearer t' }))
    await c.connect()
    const tools = await c.listTools()
    expect(tools[0].name).toBe('time')
    const r = await c.callTool('time', {})
    expect(r.text).toBe('12:00')
    expect(r.images).toEqual(['data:image/png;base64,QUJD'])
    expect(sawSession).toBe(true)
    expect(srv.requests[0].headers.authorization).toBe('Bearer t')
    expect(srv.requests.find((x) => x.body?.method === 'tools/list').headers['mcp-protocol-version']).toBe('2025-03-26')
    await c.close()
  })
})

describe('mcp manager', () => {
  it('exposes namespaced tool defs, honours disabled tools and calls through', async () => {
    const statuses: McpServerStatus[][] = []
    mgr = new McpManager((s) => statuses.push(s))
    await mgr.sync([cfg()])
    const st = mgr.statuses()[0]
    expect(st.status).toBe('connected')
    expect(st.tools.map((t) => t.exposedName)).toEqual(['mcp__demo__add', 'mcp__demo__echo', 'mcp__demo__fail'])
    expect(mgr.toolDefs().map((d) => d.function.name)).toContain('mcp__demo__add')
    expect((await mgr.call('mcp__demo__add', { a: 40, b: 2 })).text).toBe('42')
    expect(mgr.resolve('mcp__demo__echo')!.tool).toBe('echo')

    await mgr.sync([cfg({ disabledTools: ['fail'] })])
    expect(mgr.toolDefs().map((d) => d.function.name)).not.toContain('mcp__demo__fail')
    await expect(mgr.call('mcp__demo__fail', {})).rejects.toThrow(/禁用/)

    await mgr.sync([cfg({ enabled: false })])
    expect(mgr.statuses()[0].status).toBe('disconnected')
    expect(mgr.toolDefs()).toEqual([])
    await mgr.sync([])
    expect(mgr.statuses()).toEqual([])
    expect(statuses.length).toBeGreaterThan(2)
  })

  it('marks failing servers as error', async () => {
    mgr = new McpManager(() => {})
    await mgr.sync([cfg({ command: process.execPath, args: ['-e', 'process.exit(3)'] })])
    expect(mgr.statuses()[0].status).toBe('error')
  })
})

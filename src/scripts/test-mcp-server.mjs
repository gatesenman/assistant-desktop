#!/usr/bin/env node
// 一个极简的 MCP stdio 测试服务器（从零实现，用于测试连接器功能）
// 提供工具：add(a,b)、echo(text)、fail()
import readline from 'readline'

const tools = [
  {
    name: 'add',
    description: '计算两个数字之和',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
  },
  {
    name: 'echo',
    description: '原样返回文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  { name: 'fail', description: '总是返回错误', inputSchema: { type: 'object', properties: {} } }
]

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const rl = readline.createInterface({ input: process.stdin })
process.stderr.write('test-mcp-server started\n')

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (id === undefined) return // 通知
  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test-mcp', version: '1.0.0' } }
      })
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} })
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools } })
    case 'tools/call': {
      const a = params?.arguments || {}
      if (params?.name === 'add') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${Number(a.a) + Number(a.b)}` }] } })
      if (params?.name === 'echo') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${a.text}` }] } })
      if (params?.name === 'fail') return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '故意失败' }] } })
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } })
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})

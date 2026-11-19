import http from 'http'
import type { AddressInfo } from 'net'

export interface MockServer {
  url: string
  requests: any[]
  close(): Promise<void>
}

export type Handler = (body: any, req: http.IncomingMessage, res: http.ServerResponse, n: number) => unknown

export async function startServer(handler: Handler): Promise<MockServer> {
  const requests: any[] = []
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      let body: any = null
      try {
        body = data ? JSON.parse(data) : null
      } catch {
        body = data
      }
      requests.push({ url: req.url, headers: req.headers, body })
      void handler(body, req, res, requests.length)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      })
  }
}

/** 以 OpenAI SSE 格式输出若干 chunk */
export function sse(res: http.ServerResponse, chunks: any[], delayMs = 0): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  return (async () => {
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify(c)}\n\n`)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })()
}

export const textChunks = (text: string, parts = 3): any[] => {
  const size = Math.ceil(text.length / parts)
  const out: any[] = []
  for (let i = 0; i < text.length; i += size) out.push({ choices: [{ index: 0, delta: { content: text.slice(i, i + size) } }] })
  out.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  return out
}

export const toolCallChunks = (calls: { id: string; name: string; args: any }[]): any[] => {
  const out: any[] = []
  calls.forEach((c, index) => {
    const a = JSON.stringify(c.args)
    const mid = Math.floor(a.length / 2)
    out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] })
    out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: a.slice(0, mid) } }] } }] })
    out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: a.slice(mid) } }] } }] })
  })
  out.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  return out
}

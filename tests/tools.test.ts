import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { executeTool, htmlToText, resolvePath, TOOL_DEFS } from '../src/main/core/tools'
import { startServer, type MockServer } from './helpers'

let dir: string
let srv: MockServer
const mem: string[] = []
const ctx = () => ({ workDir: dir, saveMemory: (t: string) => mem.push(t) })

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  srv = await startServer((_b, req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><head><style>.x{}</style><script>alert(1)</script></head><body><h1>标题</h1><p>你好 &amp; 欢迎</p></body></html>')
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('plain text')
    }
  })
})
afterAll(async () => {
  await srv.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('tools', () => {
  it('defines all required tools', () => {
    expect(TOOL_DEFS.map((t) => t.function.name).sort()).toEqual(['list_dir', 'read_file', 'run_shell', 'save_memory', 'web_fetch', 'write_file'])
  })

  it('resolves paths', () => {
    expect(resolvePath('a/b.txt', '/w')).toBe(path.resolve('/w', 'a/b.txt'))
    expect(resolvePath('~/x', '/w')).toBe(path.join(os.homedir(), 'x'))
    expect(resolvePath('', '/w')).toBe('/w')
  })

  it('write_file / read_file / list_dir', async () => {
    const w = await executeTool('write_file', { path: 'sub/hello.txt', content: '你好\nworld' }, ctx())
    expect(w).toContain('已写入')
    expect(await executeTool('read_file', { path: 'sub/hello.txt' }, ctx())).toBe('你好\nworld')
    const l = await executeTool('list_dir', { path: 'sub' }, ctx())
    expect(l).toContain('[文件] hello.txt')
    const root = await executeTool('list_dir', {}, ctx())
    expect(root).toContain('[目录] sub/')
  })

  it('read_file errors on missing file', async () => {
    await expect(executeTool('read_file', { path: 'nope.txt' }, ctx())).rejects.toThrow()
  })

  it('run_shell returns output and exit code', async () => {
    const r = await executeTool('run_shell', { command: 'echo hello-shell && echo err 1>&2 && exit 3' }, ctx())
    expect(r).toContain('退出码: 3')
    expect(r).toContain('hello-shell')
    expect(r).toContain('err')
  })

  it('run_shell uses workDir and times out', async () => {
    const pwd = await executeTool('run_shell', { command: 'pwd' }, ctx())
    expect(pwd).toContain(fs.realpathSync(dir))
    const t = await executeTool('run_shell', { command: 'sleep 5', timeout_sec: 1 }, ctx())
    expect(t).toContain('超时')
  })

  it('web_fetch converts html to text', async () => {
    const r = await executeTool('web_fetch', { url: srv.url + '/page' }, ctx())
    expect(r).toContain('HTTP 200')
    expect(r).toContain('标题')
    expect(r).toContain('你好 & 欢迎')
    expect(r).not.toContain('alert')
    await expect(executeTool('web_fetch', { url: 'file:///etc/passwd' }, ctx())).rejects.toThrow(/http/)
  })

  it('save_memory calls context', async () => {
    await executeTool('save_memory', { text: '用户喜欢绿茶' }, ctx())
    expect(mem).toContain('用户喜欢绿茶')
  })

  it('htmlToText', () => {
    expect(htmlToText('<p>a</p><p>b&lt;c</p>')).toBe('a\nb<c')
  })

  it('unknown tool throws', async () => {
    await expect(executeTool('rm_rf', {}, ctx())).rejects.toThrow(/未知工具/)
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Store } from '../src/main/core/store'
import { plainCodec } from '../src/main/core/secrets'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v05-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('v0.5 bot model / threads / folders', () => {
  it('creates assistant with computerMode/runStyle and workDir bound', () => {
    const store = new Store(dir, plainCodec)
    const a = store.createAssistant('测试')
    expect(a.computerMode).toBe('this')
    expect(a.computerEnabled).toBe(true)
    expect(a.runStyle).toBe('ask')
    store.updateAssistant(a.id, { workDir: '/tmp/bot-work', computerMode: 'off', computerEnabled: false })
    const again = store.getAssistant(a.id)!
    expect(again.workDir).toBe('/tmp/bot-work')
    expect(again.computerMode).toBe('off')
  })

  it('threads switch chat keys', () => {
    const store = new Store(dir, plainCodec)
    const a = store.createAssistant('T')
    store.getMessages(a.id).push({ id: 'm1', role: 'user', content: 'main', createdAt: 1 })
    store.saveMessages(a.id)
    const t = store.createThread(a.id, '旁路')
    expect(store.getMessages(a.id)).toEqual([])
    store.getMessages(a.id).push({ id: 'm2', role: 'user', content: 'side', createdAt: 2 })
    store.saveMessages(a.id)
    // 回到主线程（无 threadId）
    store.switchThread(a.id, '')
    expect(store.getMessages(a.id).some((m) => m.content === 'main')).toBe(true)
    store.switchThread(a.id, t.id)
    expect(store.getMessages(a.id).some((m) => m.content === 'side')).toBe(true)
  })

  it('pin duplicate hide folders runStyle preview', () => {
    const store = new Store(dir, plainCodec)
    const a = store.createAssistant('P')
    store.pinAssistant(a.id, true)
    expect(store.getAssistant(a.id)!.pinned).toBe(true)
    const copy = store.duplicateAssistant(a.id)
    expect(copy.name).toContain('副本')
    expect(copy.id).not.toBe(a.id)
    const f = store.saveFolder({ name: '工作' })
    store.moveAssistantToFolder(a.id, f.id)
    expect(store.getAssistant(a.id)!.folderId).toBe(f.id)
    store.setRunStyle(a.id, 'auto')
    expect(store.getAssistant(a.id)!.runStyle).toBe('auto')
    store.setComputerPreview('data:image/png;base64,xx', 'local')
    expect(store.publicState().computerPreview?.thumb).toContain('data:image')
    store.hideAssistant(a.id, true)
    expect(store.getAssistant(a.id)!.hidden).toBe(true)
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  LocalVmManager,
  isAsarPath,
  MISSING_DOCKERFILE_MSG,
  dockerDesktopCandidatePaths,
  checkDiskFree,
  tryStartDockerDesktop
} from '../src/main/core/localVm'

describe('localVm helpers', () => {
  it('exposes Chinese install guide for missing Docker', () => {
    const m = new LocalVmManager()
    const g = m.installGuide()
    expect(g).toMatch(/Docker/)
    expect(g.length).toBeGreaterThan(40)
  })

  it('refresh reports docker presence without throwing', async () => {
    const m = new LocalVmManager()
    const s = await m.refresh()
    expect(['need_docker', 'idle', 'ready', 'sleeping', 'checking', 'error']).toContain(s.phase)
    expect(s.installGuide).toBeTruthy()
    expect(typeof s.dockerInstalled).toBe('boolean')
  })

  it('desktopUrl points at localhost novnc', () => {
    const m = new LocalVmManager()
    expect(m.desktopUrl()).toContain('127.0.0.1:')
  })

  it('isAsarPath rejects electron asar contexts', () => {
    expect(isAsarPath('C:\\Users\\x\\AppData\\Local\\Programs\\AssistantDesktop\\resources\\app.asar\\resources\\local-vm')).toBe(true)
    expect(isAsarPath('/opt/AssistantDesktop/resources/app.asar/resources/local-vm')).toBe(true)
    expect(isAsarPath('/opt/AssistantDesktop/resources/local-vm')).toBe(false)
    expect(isAsarPath('C:\\Users\\x\\AppData\\Local\\Programs\\AssistantDesktop\\resources\\local-vm')).toBe(false)
  })

  it('MISSING_DOCKERFILE_MSG asks to reinstall latest package (not a pinned version)', () => {
    expect(MISSING_DOCKERFILE_MSG).toMatch(/请重装最新安装包/)
    expect(MISSING_DOCKERFILE_MSG).not.toMatch(/0\.5\.1/)
  })

  it('dockerDesktopCandidatePaths joins ProgramFiles variants', () => {
    const paths = dockerDesktopCandidatePaths({
      ProgramFiles: 'D:\\Program Files',
      'ProgramFiles(x86)': 'D:\\Program Files (x86)',
      LOCALAPPDATA: 'D:\\Users\\u\\AppData\\Local',
      USERPROFILE: 'D:\\Users\\u'
    })
    expect(paths.some((p) => p.includes(path.join('D:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe')) || p.replace(/\\/g, '/').includes('Program Files/Docker/Docker/Docker Desktop.exe'))).toBe(true)
    expect(paths.some((p) => /Docker Desktop\.exe$/i.test(p))).toBe(true)
    expect(paths.length).toBeGreaterThanOrEqual(3)
    // All candidates end with Docker Desktop.exe
    for (const p of paths) expect(p).toMatch(/Docker Desktop\.exe$/i)
  })

  it('tryStartDockerDesktop on non-Windows returns Chinese guidance', async () => {
    if (process.platform === 'win32') return
    const r = await tryStartDockerDesktop()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Windows|手动启动/)
  })

  it('checkDiskFree returns structured result', async () => {
    const r = await checkDiskFree(os.tmpdir())
    expect(typeof r.ok).toBe('boolean')
    expect(r.detail.length).toBeGreaterThan(2)
  })
})

describe('resolveDockerfileDir / prepareDockerBuildContext', () => {
  let tmp: string
  let recipe: string
  let userData: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-vm-test-'))
    recipe = path.join(tmp, 'real-local-vm')
    userData = path.join(tmp, 'userData')
    fs.mkdirSync(recipe, { recursive: true })
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(path.join(recipe, 'Dockerfile'), 'FROM scratch\n')
    fs.writeFileSync(path.join(recipe, 'entrypoint.sh'), '#!/bin/sh\n')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('prefers override when it has Dockerfile and is not asar', () => {
    const m = new LocalVmManager()
    expect(m.resolveDockerfileDir('/nonexistent/app.asar', recipe)).toBe(path.resolve(recipe))
  })

  it('rejects override inside .asar', () => {
    const m = new LocalVmManager()
    const asarDir = path.join(tmp, 'app.asar', 'resources', 'local-vm')
    fs.mkdirSync(asarDir, { recursive: true })
    fs.writeFileSync(path.join(asarDir, 'Dockerfile'), 'FROM scratch\n')
    expect(() => m.resolveDockerfileDir('/x', asarDir)).toThrow(/asar/)
  })

  it('skips asar candidates and uses real resourcesPath-style dir', () => {
    const m = new LocalVmManager()
    const resources = path.join(tmp, 'resources')
    const realVm = path.join(resources, 'local-vm')
    fs.mkdirSync(realVm, { recursive: true })
    fs.writeFileSync(path.join(realVm, 'Dockerfile'), 'FROM ubuntu:24.04\n')
    const prev = process.cwd()
    try {
      process.chdir(tmp)
      const found = m.resolveDockerfileDir(path.join(tmp, 'resources', 'app.asar'))
      expect(isAsarPath(found)).toBe(false)
      expect(fs.existsSync(path.join(found, 'Dockerfile'))).toBe(true)
    } finally {
      process.chdir(prev)
    }
  })

  it('throws Chinese missing-recipe message when Dockerfile absent', () => {
    const m = new LocalVmManager()
    const empty = path.join(tmp, 'empty-recipe')
    fs.mkdirSync(empty, { recursive: true })
    expect(() => m.prepareDockerBuildContext(empty, userData)).toThrow(MISSING_DOCKERFILE_MSG)
    class EmptyCandidates extends LocalVmManager {
      resolveDockerfileDir(appPath: string, override?: string): string {
        if (override && !isAsarPath(override) && fs.existsSync(path.join(override, 'Dockerfile'))) {
          return path.resolve(override)
        }
        throw new Error(MISSING_DOCKERFILE_MSG)
      }
    }
    expect(() => new EmptyCandidates().resolveDockerfileDir(path.join(tmp, 'app.asar'))).toThrow(MISSING_DOCKERFILE_MSG)
  })

  it('prefers process.resourcesPath/local-vm over asar appPath', () => {
    const m = new LocalVmManager()
    const resRoot = path.join(tmp, 'packaged-resources')
    const realVm = path.join(resRoot, 'local-vm')
    fs.mkdirSync(realVm, { recursive: true })
    fs.writeFileSync(path.join(realVm, 'Dockerfile'), 'FROM prefer-resources\n')
    const prevRes = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    try {
      ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resRoot
      const asarApp = path.join(tmp, 'resources', 'app.asar')
      fs.mkdirSync(path.join(asarApp, 'resources', 'local-vm'), { recursive: true })
      fs.writeFileSync(path.join(asarApp, 'resources', 'local-vm', 'Dockerfile'), 'FROM asar\n')
      const found = m.resolveDockerfileDir(asarApp)
      expect(found).toBe(path.resolve(realVm))
      expect(isAsarPath(found)).toBe(false)
    } finally {
      const proc = process as NodeJS.Process & { resourcesPath?: string }
      if (prevRes !== undefined) proc.resourcesPath = prevRes
      else Reflect.deleteProperty(proc, 'resourcesPath')
    }
  })

  it('always copies context to userData/local-vm-context and never returns asar', () => {
    const m = new LocalVmManager()
    const dest = m.prepareDockerBuildContext(recipe, userData)
    expect(dest).toBe(path.join(userData, 'local-vm-context'))
    expect(isAsarPath(dest)).toBe(false)
    expect(fs.existsSync(path.join(dest, 'Dockerfile'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'entrypoint.sh'))).toBe(true)
    expect(fs.readFileSync(path.join(dest, 'Dockerfile'), 'utf8')).toContain('FROM scratch')
  })

  it('prepareDockerBuildContext refuses asar source', () => {
    const m = new LocalVmManager()
    const asarDir = path.join(tmp, 'packed.asar', 'local-vm')
    fs.mkdirSync(asarDir, { recursive: true })
    fs.writeFileSync(path.join(asarDir, 'Dockerfile'), 'FROM scratch\n')
    expect(() => m.prepareDockerBuildContext(asarDir, userData)).toThrow(/asar/)
  })

  it('start stays in need_docker when docker CLI missing (no build attempt)', async () => {
    const m = new LocalVmManager()
    m.detectDocker = async () => ({
      installed: false,
      running: false,
      detail: '未检测到 docker 命令（CLI）。请先安装并启动 Docker Desktop。'
    })
    let built = false
    m.ensureImage = async () => {
      built = true
    }
    const s = await m.start({
      workDir: path.join(tmp, 'work'),
      appPath: tmp,
      userDataPath: userData,
      dockerfileDir: recipe
    })
    expect(built).toBe(false)
    expect(s.phase).toBe('need_docker')
    expect(s.dockerInstalled).toBe(false)
    expect(s.message).toMatch(/docker/i)
  })

  it('preflight returns Chinese checklist structure', async () => {
    const m = new LocalVmManager()
    m.detectDocker = async () => ({
      installed: true,
      running: true,
      detail: 'Docker mock-ok'
    })
    const pf = await m.preflight({ workDir: tmp, appPath: tmp, dockerfileDir: recipe })
    expect(pf.items.length).toBeGreaterThanOrEqual(3)
    const ids = pf.items.map((i) => i.id)
    expect(ids).toContain('docker')
    expect(ids).toContain('disk')
    expect(ids).toContain('recipe')
    expect(ids).toContain('port6080')
    expect(pf.summary).toMatch(/预检/)
    const recipeItem = pf.items.find((i) => i.id === 'recipe')!
    expect(recipeItem.ok).toBe(true)
    expect(isAsarPath(recipeItem.detail)).toBe(false)
  })

  it('preflight fails when recipe missing', async () => {
    const m = new LocalVmManager()
    m.detectDocker = async () => ({ installed: true, running: true, detail: 'ok' })
    m.resolveDockerfileDir = () => {
      throw new Error(MISSING_DOCKERFILE_MSG)
    }
    const pf = await m.preflight({ workDir: tmp, appPath: path.join(tmp, 'no-recipe-app') })
    expect(pf.ok).toBe(false)
    const recipeItem = pf.items.find((i) => i.id === 'recipe')!
    expect(recipeItem.ok).toBe(false)
    expect(recipeItem.detail).toMatch(/请重装最新安装包|配方/)
  })

  it('start calls ensureImage without force when image already exists', async () => {
    const m = new LocalVmManager()
    m.detectDocker = async () => ({ installed: true, running: true, detail: 'ok' })
    m.imageExists = async () => true
    m.containerRunning = async () => true
    m.containerExists = async () => true
    let forceArg: boolean | undefined
    let called = false
    m.ensureImage = async (_a, _d, _o, _u, force) => {
      called = true
      forceArg = !!force
    }
    ;(m as any).postConfigure = async () => {}
    const s = await m.start({
      workDir: path.join(tmp, 'work'),
      appPath: tmp,
      userDataPath: userData,
      dockerfileDir: recipe
    })
    expect(called).toBe(true)
    expect(forceArg).toBe(false)
    expect(s.phase).toBe('ready')
  })

  it('forceRebuild passes through to ensureImage', async () => {
    const m = new LocalVmManager()
    m.detectDocker = async () => ({ installed: true, running: true, detail: 'ok' })
    m.imageExists = async () => true
    m.containerRunning = async () => true
    m.containerExists = async () => true
    let forceSeen: boolean | undefined
    m.ensureImage = async (_a, _d, _o, _u, force) => {
      forceSeen = !!force
    }
    ;(m as any).postConfigure = async () => {}
    const s = await m.start({
      workDir: path.join(tmp, 'work'),
      appPath: tmp,
      userDataPath: userData,
      dockerfileDir: recipe,
      forceRebuild: true
    })
    expect(forceSeen).toBe(true)
    expect(s.phase).toBe('ready')
  })

  it('diagnosticSummary returns JSON with localVm/detectDocker/preflight', async () => {
    const m = new LocalVmManager()
    m.detectDocker = async () => ({ installed: false, running: false, detail: 'mock-missing' })
    const text = await m.diagnosticSummary(tmp, tmp)
    const j = JSON.parse(text)
    expect(j.localVm).toBeTruthy()
    expect(j.detectDocker.detail).toMatch(/mock-missing/)
    expect(j.preflight).toBeTruthy()
    expect(j.preflight.items).toBeInstanceOf(Array)
    // no api key field
    expect(JSON.stringify(j)).not.toMatch(/apiKey|sk-/)
  })
})

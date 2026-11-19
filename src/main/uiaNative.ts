import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseA11yJson, type A11ySnapshot } from './core/som'

/**
 * Windows UI Automation 元素树（v0.7）。
 *
 * 用系统自带的 PowerShell + .NET System.Windows.Automation（Win10/11 开箱即有，无需安装任何组件），
 * 以常驻子进程的方式运行，避免每次截图都付出 PowerShell 冷启动（~1 秒）的代价：
 *  - 一次 CacheRequest(TreeScope.Subtree) 把前台窗口的控件子树连同属性一并取回（只有一次跨进程调用）
 *  - 过滤 ControlView + 屏幕外元素；本地遍历时限制深度 / 数量 / 时间预算
 *  - Node 端超时会杀掉并重启子进程，绝不让一次卡死的 UIA 调用拖住智能体
 */
export const UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class AdW {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
}
"@
[void][AdW]::SetProcessDPIAware()
$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
function Esc([string]$s) {
  if ($null -eq $s) { return '""' }
  if ($s.Length -gt 160) { $s = $s.Substring(0, 160) }
  $sb = New-Object System.Text.StringBuilder ($s.Length + 2)
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if ($ch -eq '"') { [void]$sb.Append('\"') }
    elseif ($ch -eq '\') { [void]$sb.Append('\\') }
    elseif ($c -lt 32) { [void]$sb.Append(' ') }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}
$req = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($A::ControlTypeProperty, $A::NameProperty, $A::BoundingRectangleProperty, $A::IsEnabledProperty,
  $A::HasKeyboardFocusProperty, $A::AutomationIdProperty, $A::IsOffscreenProperty,
  $A::IsInvokePatternAvailableProperty, $A::IsValuePatternAvailableProperty, $A::IsTogglePatternAvailableProperty,
  $A::IsSelectionItemPatternAvailableProperty, $A::IsExpandCollapsePatternAvailableProperty,
  [System.Windows.Automation.ValuePattern]::ValueProperty)) { $req.Add($p) }
$req.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
$req.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
$notOff = New-Object System.Windows.Automation.PropertyCondition ($A::IsOffscreenProperty, $false)
$req.TreeFilter = New-Object System.Windows.Automation.AndCondition ([System.Windows.Automation.Automation]::ControlViewCondition, $notOff)

function Walk($el, [int]$depth, [string]$win, $out, $cfg, $sw) {
  if ($out.Count -ge $cfg.max -or $depth -gt $cfg.depth -or $sw.ElapsedMilliseconds -gt $cfg.budget) { return }
  $kids = $el.CachedChildren
  foreach ($k in $kids) {
    if ($out.Count -ge $cfg.max -or $sw.ElapsedMilliseconds -gt $cfg.budget) { return }
    try {
      $r = $k.Cached.BoundingRectangle
      $role = $k.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if (-not $r.IsEmpty -and $r.Width -ge 4 -and $r.Height -ge 4 -and -not [double]::IsInfinity($r.X)) {
        $pats = @()
        if ($k.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty)) { $pats += 'invoke' }
        if ($k.GetCachedPropertyValue($A::IsValuePatternAvailableProperty)) { $pats += 'value' }
        if ($k.GetCachedPropertyValue($A::IsTogglePatternAvailableProperty)) { $pats += 'toggle' }
        if ($k.GetCachedPropertyValue($A::IsSelectionItemPatternAvailableProperty)) { $pats += 'select' }
        if ($k.GetCachedPropertyValue($A::IsExpandCollapsePatternAvailableProperty)) { $pats += 'expand' }
        $v = ''
        if ($pats -contains 'value') { try { $v = [string]$k.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } catch {} }
        $name = $k.Cached.Name
        $pj = ($pats | ForEach-Object { '"' + $_ + '"' }) -join ','
        $e = if ($k.Cached.IsEnabled) { 1 } else { 0 }
        $f = if ($k.Cached.HasKeyboardFocus) { 1 } else { 0 }
        [void]$out.Add('{"r":' + (Esc $role) + ',"n":' + (Esc $name) + ',"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + ',"p":[' + $pj + '],"e":' + $e + ',"f":' + $f + ',"v":' + (Esc $v) + ',"a":' + (Esc $k.Cached.AutomationId) + ',"win":' + (Esc $win) + '}')
      }
      Walk $k ($depth + 1) $win $out $cfg $sw
    } catch {}
  }
}

function Snap($cmd) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $cfg = @{ depth = [int]$cmd.depth; max = [int]$cmd.max; budget = [int]$cmd.budget }
  $out = New-Object System.Collections.ArrayList
  $roots = @()
  $h = [AdW]::GetForegroundWindow()
  $fg = ''
  if ($h -ne [IntPtr]::Zero) {
    try { $fgEl = $A::FromHandle($h); $fg = $fgEl.Current.Name; $roots += ,@($fgEl, $fg) } catch {}
  }
  if ($cmd.scope -eq 'desktop') {
    $tray = [AdW]::FindWindow('Shell_TrayWnd', $null)
    if ($tray -ne [IntPtr]::Zero) { try { $roots += ,@($A::FromHandle($tray), '任务栏') } catch {} }
  }
  foreach ($pair in $roots) {
    if ($sw.ElapsedMilliseconds -gt $cfg.budget) { break }
    try {
      $cached = $pair[0].GetUpdatedCache($req)
      Walk $cached 0 $pair[1] $out $cfg $sw
    } catch {}
  }
  $sw2 = [AdW]::GetSystemMetrics(0); $sh2 = [AdW]::GetSystemMetrics(1)
  return '{"ok":true,"engine":"uia","screen":{"w":' + $sw2 + ',"h":' + $sh2 + '},"fg":' + (Esc $fg) + ',"ms":' + $sw.ElapsedMilliseconds + ',"els":[' + ($out -join ',') + ']}'
}

function SetVal($cmd) {
  $pt = New-Object System.Windows.Point ([double]$cmd.x, [double]$cmd.y)
  $el = $A::FromPoint($pt)
  for ($i = 0; $i -lt 4 -and $null -ne $el; $i++) {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      if ($vp.Current.IsReadOnly) { return '{"ok":false,"error":"readonly"}' }
      try { $el.SetFocus() } catch {}
      $vp.SetValue([string]$cmd.text)
      return '{"ok":true,"role":' + (Esc ($el.Current.ControlType.ProgrammaticName)) + '}'
    }
    $el = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el)
  }
  return '{"ok":false,"error":"no-value-pattern"}'
}

[Console]::Out.WriteLine('@@READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $cmd = $line | ConvertFrom-Json
    $id = [int]$cmd.id
    if ($cmd.cmd -eq 'snap') { $res = Snap $cmd }
    elseif ($cmd.cmd -eq 'set') { $res = SetVal $cmd }
    elseif ($cmd.cmd -eq 'ping') { $res = '{"ok":true,"engine":"uia"}' }
    else { $res = '{"ok":false,"error":"unknown"}' }
  } catch {
    $res = '{"ok":false,"error":' + (Esc $_.Exception.Message) + '}'
  }
  [Console]::Out.WriteLine('@@' + $id + ' ' + $res)
  [Console]::Out.Flush()
}
`

export interface UiaStatus {
  available: boolean
  state: 'idle' | 'starting' | 'ready' | 'error' | 'unsupported'
  lastMs?: number
  lastCount?: number
  lastError?: string
}

const status: UiaStatus = { available: process.platform === 'win32', state: process.platform === 'win32' ? 'idle' : 'unsupported' }

export function uiaStatus(): UiaStatus {
  return { ...status }
}

class UiaHelper {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private buf = ''
  private seq = 0
  private waiters = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private failures = 0

  private scriptPath(): string {
    let dir: string
    try {
      dir = app.getPath('userData')
    } catch {
      dir = os.tmpdir()
    }
    const file = path.join(dir, 'uia-helper-v1.ps1')
    // 带 BOM 的 UTF-8，Windows PowerShell 5.1 才能正确识别脚本里的中文
    const content = '\ufeff' + UIA_SCRIPT
    try {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content, 'utf8')
    } catch {
      /* ignore */
    }
    return file
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    status.state = 'starting'
    this.ready = new Promise<void>((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath()], {
        windowsHide: true,
        stdio: 'pipe'
      })
      this.proc = ps
      this.buf = ''
      const startTimer = setTimeout(() => {
        reject(new Error('UI Automation 组件启动超时（PowerShell 15 秒内未就绪）'))
        this.kill()
      }, 15000)
      ps.stdout.setEncoding('utf8')
      ps.stdout.on('data', (d: string) => {
        this.buf += d
        let i: number
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/\r$/, '')
          this.buf = this.buf.slice(i + 1)
          if (line === '@@READY') {
            clearTimeout(startTimer)
            status.state = 'ready'
            resolve()
            continue
          }
          const m = /^@@(\d+) (.*)$/.exec(line)
          if (!m) continue
          const w = this.waiters.get(Number(m[1]))
          if (w) {
            clearTimeout(w.timer)
            this.waiters.delete(Number(m[1]))
            w.resolve(m[2])
          }
        }
      })
      ps.stderr.on('data', (d) => {
        const t = String(d).trim()
        if (t) status.lastError = t.slice(0, 300)
      })
      ps.once('error', (e) => {
        clearTimeout(startTimer)
        status.state = 'error'
        status.lastError = '无法启动 PowerShell：' + e.message
        reject(new Error(status.lastError))
        this.reset()
      })
      ps.once('exit', () => {
        clearTimeout(startTimer)
        reject(new Error('UI Automation 组件已退出' + (status.lastError ? '：' + status.lastError : '')))
        this.reset()
      })
    })
    return this.ready
  }

  private reset(): void {
    this.proc = null
    this.ready = null
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer)
      w.reject(new Error('UI Automation 组件已重启'))
    }
    this.waiters.clear()
  }

  kill(): void {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.reset()
  }

  async call(cmd: Record<string, unknown>, timeoutMs: number): Promise<string> {
    await this.start()
    const id = ++this.seq
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        // 一次 UIA 调用卡住（某些应用的无障碍实现会挂起）：重启子进程，下次重新来过
        this.kill()
        reject(new Error(`读取界面元素超时（${Math.round(timeoutMs / 1000)} 秒），已跳过`))
      }, timeoutMs)
      this.waiters.set(id, { resolve, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, ...cmd }) + '\n')
    }).then(
      (r) => {
        this.failures = 0
        return r
      },
      (e) => {
        this.failures++
        throw e
      }
    )
  }

  /** 连续失败多次后短暂熔断，避免每一步都卡几秒 */
  get tripped(): boolean {
    return this.failures >= 3
  }
  resetTrip(): void {
    this.failures = 0
  }
}

let helper: UiaHelper | null = null
let trippedAt = 0
const cache = { key: '', at: 0, snap: null as A11ySnapshot | null }

export interface UiaOptions {
  depth?: number
  max?: number
  budgetMs?: number
  timeoutMs?: number
}

/** 读取前台窗口（scope=desktop 时另加任务栏）的 UIA 元素，坐标为物理像素屏幕坐标 */
export async function uiaSnapshot(scope: 'foreground' | 'desktop' = 'foreground', opts: UiaOptions = {}): Promise<A11ySnapshot | null> {
  if (process.platform !== 'win32') return null
  helper ??= new UiaHelper()
  if (helper.tripped) {
    if (Date.now() - trippedAt < 60000) return { elements: [], screen: { width: 0, height: 0 }, engine: 'uia', error: status.lastError || 'UI Automation 暂时不可用' }
    helper.resetTrip()
  }
  const key = scope
  // 300ms 内重复请求（如截图后马上 get_ui_elements）直接复用
  if (cache.key === key && cache.snap && Date.now() - cache.at < 300) return cache.snap
  const t0 = Date.now()
  try {
    const raw = await helper.call({ cmd: 'snap', scope, depth: opts.depth ?? 30, max: opts.max ?? 400, budget: opts.budgetMs ?? 2500 }, opts.timeoutMs ?? 6000)
    const snap = parseA11yJson(raw)
    if (snap.error) status.lastError = snap.error
    status.lastMs = snap.ms ?? Date.now() - t0
    status.lastCount = snap.elements.length
    cache.key = key
    cache.at = Date.now()
    cache.snap = snap
    return snap
  } catch (e: any) {
    status.lastError = e?.message || String(e)
    if (helper.tripped) trippedAt = Date.now()
    return { elements: [], screen: { width: 0, height: 0 }, engine: 'uia', error: status.lastError }
  }
}

/** 用 ValuePattern 直接设置 (x,y) 处输入框的值；x/y 为 UIA（物理像素）坐标 */
export async function uiaSetValue(x: number, y: number, text: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  helper ??= new UiaHelper()
  try {
    const raw = await helper.call({ cmd: 'set', x, y, text }, 4000)
    cache.snap = null
    return /"ok":true/.test(raw)
  } catch {
    return false
  }
}

export function uiaScreen(): { width: number; height: number } | null {
  return cache.snap?.screen.width ? cache.snap.screen : null
}

export function disposeUia(): void {
  helper?.kill()
  helper = null
}

/**
 * v0.7 Set-of-Mark（SoM）：把无障碍树（Windows UIA / Linux AT-SPI）元素、OCR 文字元素和
 * 启发式矩形控件合并成一份带编号的可交互元素列表。
 *  - 视觉模型：在截图上画编号框，模型只需回答「点 #12」；
 *  - 纯文本模型（DeepSeek 等）：发送紧凑的文字列表（编号、类型、名称、坐标范围）。
 * 本文件是纯函数，便于单元测试；坐标统一为「截图坐标系」。
 */
import type { ScreenElement, UiBox } from './ocr'

export type ElementSource = 'uia' | 'atspi' | 'ocr' | 'box'

/** 无障碍接口返回的原始元素（屏幕坐标系，单位为输入驱动/物理像素） */
export interface A11yElement {
  role: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** 可调用的模式，如 invoke / value / toggle / expand / select */
  patterns?: string[]
  enabled?: boolean
  focused?: boolean
  value?: string
  automationId?: string
  /** 所属窗口标题 */
  window?: string
}

export interface A11ySnapshot {
  elements: A11yElement[]
  /** 元素坐标所在的屏幕尺寸（用于换算到截图坐标） */
  screen: { width: number; height: number }
  engine: string
  /** 前台窗口标题 */
  foreground?: string
  ms?: number
  error?: string
}

/** 编号后的元素（截图坐标系） */
export interface SomElement {
  id: number
  role: string
  name: string
  x1: number
  y1: number
  x2: number
  y2: number
  cx: number
  cy: number
  source: ElementSource
  patterns?: string[]
  enabled?: boolean
  value?: string
  window?: string
}

/** UIA ControlType / AT-SPI role → 简短中文类型 */
const ROLE_ZH: Record<string, string> = {
  button: '按钮',
  splitbutton: '按钮',
  'push button': '按钮',
  'toggle button': '开关',
  edit: '输入框',
  text: '文字',
  entry: '输入框',
  'password text': '密码框',
  'text box': '输入框',
  document: '文档',
  checkbox: '复选框',
  'check box': '复选框',
  radiobutton: '单选',
  'radio button': '单选',
  combobox: '下拉框',
  'combo box': '下拉框',
  hyperlink: '链接',
  link: '链接',
  listitem: '列表项',
  'list item': '列表项',
  menuitem: '菜单项',
  'menu item': '菜单项',
  menu: '菜单',
  tabitem: '标签页',
  'page tab': '标签页',
  treeitem: '树节点',
  'tree item': '树节点',
  slider: '滑块',
  spinner: '数值框',
  'spin button': '数值框',
  dataitem: '单元格',
  'table cell': '单元格',
  image: '图标',
  icon: '图标',
  ocrtext: '文字',
  box: '控件'
}

export function roleLabel(role: string): string {
  const k = role.replace(/^ControlType\./i, '').toLowerCase()
  return ROLE_ZH[k] || role.replace(/^ControlType\./i, '')
}

/** 可交互的 role（无障碍树里的纯文字/分组等容器默认不编号，除非有名字且可点击） */
const INTERACTIVE = new Set([
  'button',
  'splitbutton',
  'push button',
  'toggle button',
  'edit',
  'entry',
  'password text',
  'text box',
  'checkbox',
  'check box',
  'radiobutton',
  'radio button',
  'combobox',
  'combo box',
  'hyperlink',
  'link',
  'listitem',
  'list item',
  'menuitem',
  'menu item',
  'tabitem',
  'page tab',
  'treeitem',
  'tree item',
  'slider',
  'spinner',
  'spin button',
  'dataitem',
  'table cell',
  'document',
  'icon'
])

export function isInteractiveRole(role: string, patterns?: string[]): boolean {
  const k = role.replace(/^ControlType\./i, '').toLowerCase()
  if (INTERACTIVE.has(k)) return true
  return !!patterns?.some((p) => p === 'invoke' || p === 'value' || p === 'toggle' || p === 'select' || p === 'expand')
}

export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  const inter = ix * iy
  if (!inter) return 0
  const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
  return ua > 0 ? inter / ua : 0
}

/** a 被 b 覆盖的比例（a∩b / a） */
export function coverage(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  const area = (a.x2 - a.x1) * (a.y2 - a.y1)
  return area > 0 ? (ix * iy) / area : 0
}

/** 把无障碍元素（屏幕坐标）换算为截图坐标，并裁剪到截图范围内；完全在屏幕外/过小的丢弃 */
export function a11yToShot(snap: A11ySnapshot, shot: { width: number; height: number }, opts: { minSize?: number } = {}): Omit<SomElement, 'id'>[] {
  const sx = shot.width / Math.max(1, snap.screen.width)
  const sy = shot.height / Math.max(1, snap.screen.height)
  const min = opts.minSize ?? 4
  const out: Omit<SomElement, 'id'>[] = []
  for (const e of snap.elements) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !(e.w > 0) || !(e.h > 0)) continue
    if (e.enabled === false && !e.name) continue
    if (!isInteractiveRole(e.role, e.patterns)) continue
    let x1 = e.x * sx
    let y1 = e.y * sy
    let x2 = (e.x + e.w) * sx
    let y2 = (e.y + e.h) * sy
    x1 = Math.max(0, x1)
    y1 = Math.max(0, y1)
    x2 = Math.min(shot.width, x2)
    y2 = Math.min(shot.height, y2)
    if (x2 - x1 < min || y2 - y1 < min) continue
    // 覆盖几乎整屏的容器（如文档根节点）对点击没有意义
    if ((x2 - x1) * (y2 - y1) > shot.width * shot.height * 0.6) continue
    const r = { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) }
    out.push({
      ...r,
      cx: Math.round((r.x1 + r.x2) / 2),
      cy: Math.round((r.y1 + r.y2) / 2),
      // AT-SPI 的可编辑文本区域角色为 text（与 OCR「文字」同名），带 value 能力时按输入框处理
      role: (() => {
        const r = e.role.replace(/^ControlType\./i, '')
        return r === 'text' && snap.engine.startsWith('atspi') && e.patterns?.includes('value') ? 'text box' : r
      })(),
      name: (e.name || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      source: snap.engine.startsWith('atspi') ? 'atspi' : 'uia',
      patterns: e.patterns?.length ? e.patterns : undefined,
      enabled: e.enabled,
      value: e.value ? e.value.slice(0, 80) : undefined,
      window: e.window
    })
  }
  return out
}

export interface MergeInput {
  a11y?: Omit<SomElement, 'id'>[]
  ocr?: ScreenElement[]
  boxes?: UiBox[]
  /** 最多编号数量 */
  max?: number
}

/**
 * 合并去重并编号：
 *  1. 无障碍元素优先（有语义、名称准确）；同一控件的重复节点（IoU>0.85）只保留名字更完整的那个；
 *  2. 启发式矩形控件：与已有元素 IoU>0.5 或被覆盖 >70% 视为重复；否则作为「控件」加入（补 UIA 拿不到的 Electron/Canvas 控件）；
 *  3. OCR 文字：中心落在已有元素内则把文字补到该元素名字（若其无名）并丢弃；否则作为「文字」元素加入；
 *  4. 按阅读顺序（行优先，行高容差 10px）编号 1..N。
 */
export function mergeElements(input: MergeInput): SomElement[] {
  const max = input.max ?? 200
  const list: Omit<SomElement, 'id'>[] = []
  for (const e of input.a11y || []) {
    const dup = list.findIndex((x) => iou(x, e) > 0.85)
    if (dup >= 0) {
      if (!list[dup].name && e.name) list[dup] = { ...e }
      continue
    }
    list.push({ ...e })
  }
  for (const b of input.boxes || []) {
    if (list.some((x) => iou(x, b) > 0.5 || coverage(b, x) > 0.7)) continue
    list.push({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, cx: b.cx, cy: b.cy, role: 'box', name: (b.text || '').trim(), source: 'box' })
  }
  for (const t of input.ocr || []) {
    const host = list.find((x) => t.cx >= x.x1 && t.cx <= x.x2 && t.cy >= x.y1 && t.cy <= x.y2 && (x.x2 - x.x1) * (x.y2 - x.y1) < (t.x2 - t.x1) * (t.y2 - t.y1) * 40)
    if (host) {
      if (!host.name) host.name = t.text.slice(0, 120)
      continue
    }
    list.push({ x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, cx: t.cx, cy: t.cy, role: 'ocrtext', name: t.text.slice(0, 120), source: 'ocr' })
  }
  const sorted = sortReadingOrder(list)
  return sorted.slice(0, max).map((e, i) => ({ ...e, id: i + 1 }))
}

/** 阅读顺序：按中心 y 分行（容差 10px），行内按 x */
export function sortReadingOrder<T extends { cx: number; cy: number }>(els: T[], tol = 10): T[] {
  const byY = [...els].sort((a, b) => a.cy - b.cy)
  const rows: T[][] = []
  for (const e of byY) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(row[0].cy - e.cy) <= tol) row.push(e)
    else rows.push([e])
  }
  return rows.flatMap((r) => r.sort((a, b) => a.cx - b.cx))
}

/** 紧凑文字列表：发给纯文本模型（也附在视觉模型的截图说明里） */
export function describeSom(els: SomElement[], o: { width: number; height: number; engine?: string; foreground?: string; max?: number; header?: boolean } ): string {
  const max = o.max ?? 150
  const lines: string[] = []
  if (o.header !== false) {
    lines.push(`【可交互元素列表】坐标系 ${o.width}x${o.height}（与截图/鼠标工具一致），来源：${o.engine || 'OCR'}${o.foreground ? `，前台窗口「${o.foreground}」` : ''}。`)
    lines.push('优先用 click_element(id) / type_into_element(id, text) 按编号操作；编号在每次截图后重新生成，请以最新列表为准。')
  }
  if (!els.length) lines.push('（没有检测到可交互元素，可改用坐标工具或 find_text_on_screen）')
  for (const e of els.slice(0, max)) {
    const extra: string[] = []
    if (e.enabled === false) extra.push('禁用')
    if (e.value && e.value !== e.name) extra.push(`值="${e.value.slice(0, 40)}"`)
    lines.push(`[${e.id}] ${roleLabel(e.role)}${e.name ? ` "${e.name.slice(0, 60)}"` : ''} @(${e.cx},${e.cy}) [${e.x1},${e.y1},${e.x2},${e.y2}]${extra.length ? ' ' + extra.join(' ') : ''}`)
  }
  if (els.length > max) lines.push(`…另有 ${els.length - max} 个元素未列出`)
  return lines.join('\n')
}

/** 根据自然语言描述在 SoM 列表中找最匹配的元素（click_target 的无 grounding 模型兜底） */
export function matchElement(els: SomElement[], description: string): { element: SomElement; score: number }[] {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s"'“”‘’「」『』《》()（）[\]【】,，.。:：!！?？]/g, '')
  const q = norm(description)
  if (!q) return []
  // 描述中的类型提示
  const roleHints: [RegExp, string[]][] = [
    [/按钮|button|btn/i, ['button', 'splitbutton', 'push button', 'toggle button', 'box']],
    [/输入框|文本框|搜索框|input|textbox|edit|field/i, ['edit', 'entry', 'text box', 'password text', 'box', 'document']],
    [/链接|link/i, ['hyperlink', 'link']],
    [/复选|checkbox/i, ['checkbox', 'check box']],
    [/菜单|menu/i, ['menuitem', 'menu item', 'menu']],
    [/标签页|tab/i, ['tabitem', 'page tab']],
    [/下拉|combo|select/i, ['combobox', 'combo box']]
  ]
  const hinted = roleHints.filter(([re]) => re.test(description)).flatMap(([, r]) => r)
  // 去掉类型词后剩下的关键字
  const core = norm(description.replace(/按钮|输入框|文本框|搜索框|链接|复选框|菜单项?|标签页|下拉框|图标|的|点击|单击|那个|这个|button|input|link|the|click|on/gi, ''))
  const out: { element: SomElement; score: number }[] = []
  for (const e of els) {
    const n = norm(e.name || '')
    let s = 0
    if (core && n) {
      if (n === core) s += 100
      else if (n.includes(core)) s += 70 - Math.min(30, n.length - core.length)
      else if (core.includes(n) && n.length >= 2) s += 50
      else {
        // 字符重合度
        const set = new Set(Array.from(core))
        const hit = Array.from(n).filter((c) => set.has(c)).length
        const ratio = hit / Math.max(core.length, n.length)
        if (ratio >= 0.5) s += Math.round(ratio * 40)
      }
    }
    const role = e.role.toLowerCase()
    if (hinted.length && hinted.includes(role)) s += 15
    if (!core && hinted.length && hinted.includes(role)) s += 20
    if (e.source === 'uia' || e.source === 'atspi') s += 3
    if (e.enabled === false) s -= 20
    if (s >= 30) out.push({ element: e, score: s })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** 找出包含某点的最小元素 */
export function elementAt(els: SomElement[], x: number, y: number): SomElement | undefined {
  let best: SomElement | undefined
  for (const e of els) {
    if (x >= e.x1 && x <= e.x2 && y >= e.y1 && y <= e.y2) {
      if (!best || (e.x2 - e.x1) * (e.y2 - e.y1) < (best.x2 - best.x1) * (best.y2 - best.y1)) best = e
    }
  }
  return best
}

/* ------------------------- 无障碍接口输出解析 ------------------------- */

/**
 * 解析 uiaNative.ps1 / atspi_dump.py 的 JSON 输出：
 * { ok, engine, screen:{w,h}, fg, ms, els:[{r,n,x,y,w,h,p?,e?,f?,v?,a?,win?}] }
 * 也兼容字段全名（role/name/...）。坏数据逐条跳过，不整体失败。
 */
export function parseA11yJson(raw: string, fallbackScreen?: { width: number; height: number }): A11ySnapshot {
  const text = String(raw || '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { elements: [], screen: fallbackScreen || { width: 0, height: 0 }, engine: 'none', error: '无障碍接口没有返回数据' }
  let j: any
  try {
    j = JSON.parse(text.slice(start, end + 1))
  } catch (e: any) {
    return { elements: [], screen: fallbackScreen || { width: 0, height: 0 }, engine: 'none', error: '无障碍数据解析失败：' + (e?.message || e) }
  }
  const screen = {
    width: Number(j.screen?.w ?? j.screen?.width) || fallbackScreen?.width || 0,
    height: Number(j.screen?.h ?? j.screen?.height) || fallbackScreen?.height || 0
  }
  const arr: any[] = Array.isArray(j.els) ? j.els : Array.isArray(j.elements) ? j.elements : []
  const elements: A11yElement[] = []
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    const x = Number(r.x)
    const y = Number(r.y)
    const w = Number(r.w ?? r.width)
    const h = Number(r.h ?? r.height)
    if (![x, y, w, h].every(Number.isFinite)) continue
    const p = r.p ?? r.patterns
    elements.push({
      role: String(r.r ?? r.role ?? 'unknown'),
      name: String(r.n ?? r.name ?? ''),
      x,
      y,
      w,
      h,
      patterns: Array.isArray(p) ? p.map(String) : typeof p === 'string' && p ? p.split(',') : undefined,
      enabled: r.e === undefined && r.enabled === undefined ? undefined : !!(r.e ?? r.enabled),
      focused: r.f === undefined ? undefined : !!r.f,
      value: r.v ?? r.value ? String(r.v ?? r.value) : undefined,
      automationId: r.a ?? r.automationId ? String(r.a ?? r.automationId) : undefined,
      window: r.win ? String(r.win) : undefined
    })
  }
  return {
    elements,
    screen,
    engine: String(j.engine || 'uia'),
    foreground: j.fg ? String(j.fg) : undefined,
    ms: Number(j.ms) || undefined,
    error: j.ok === false ? String(j.error || '无障碍接口出错') : undefined
  }
}

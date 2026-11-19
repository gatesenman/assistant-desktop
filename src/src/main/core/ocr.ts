/** 纯文本电脑控制：把 OCR 结果整理成带坐标的屏幕描述，供不能看图的模型使用 */

export interface OcrWord {
  text: string
  x: number
  y: number
  w: number
  h: number
  conf: number
  line: string
}

export interface ScreenElement {
  text: string
  /** 中心坐标（截图坐标系） */
  cx: number
  cy: number
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 解析 tesseract TSV 输出（level 5 = 单词），坐标按 scale 缩放回截图坐标系 */
export function parseTesseractTsv(tsv: string, scale = 1): OcrWord[] {
  const out: OcrWord[] = []
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const c = row.split('\t')
    if (c.length < 12 || c[0] !== '5') continue
    const text = c.slice(11).join('\t').trim()
    const conf = Number(c[10])
    if (!text || !(conf >= 0)) continue
    out.push({
      text,
      x: Number(c[6]) / scale,
      y: Number(c[7]) / scale,
      w: Number(c[8]) / scale,
      h: Number(c[9]) / scale,
      conf,
      line: `${c[1]}-${c[2]}-${c[3]}-${c[4]}`
    })
  }
  return out
}

const isCjk = (s: string): boolean => /[\u2e80-\u9fff\uff00-\uffef]/.test(s)

/**
 * 把单词合并成「元素」：同一行内按水平间距切分（间距大于约 1.2 倍行高视为不同控件，
 * 例如输入框提示文字与旁边的按钮）。
 */
export function groupElements(words: OcrWord[], minConf = 35): ScreenElement[] {
  const lines = new Map<string, OcrWord[]>()
  for (const w of words) {
    if (w.conf < minConf) continue
    if (!/[\p{L}\p{N}]/u.test(w.text)) continue
    const arr = lines.get(w.line) || []
    arr.push(w)
    lines.set(w.line, arr)
  }
  const els: ScreenElement[] = []
  for (const arr of lines.values()) {
    arr.sort((a, b) => a.x - b.x)
    const lh = Math.max(8, arr.reduce((s, w) => s + w.h, 0) / arr.length)
    let cur: OcrWord[] = []
    const flush = (): void => {
      if (!cur.length) return
      let text = ''
      for (const w of cur) text += text && !(isCjk(text.slice(-1)) && isCjk(w.text[0])) ? ' ' + w.text : w.text
      const x1 = Math.min(...cur.map((w) => w.x))
      const y1 = Math.min(...cur.map((w) => w.y))
      const x2 = Math.max(...cur.map((w) => w.x + w.w))
      const y2 = Math.max(...cur.map((w) => w.y + w.h))
      // 过滤单个字母/符号等噪声
      if (text.length >= 2 || isCjk(text))
        els.push({ text, x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) })
      cur = []
    }
    for (const w of arr) {
      const prev = cur[cur.length - 1]
      if (prev && w.x - (prev.x + prev.w) > Math.max(lh * 1.2, 18)) flush()
      cur.push(w)
    }
    flush()
  }
  return els.sort((a, b) => a.cy - b.cy || a.cx - b.cx)
}

export function describeScreen(o: { width: number; height: number; elements: ScreenElement[]; boxes?: UiBox[]; windows?: string[]; engine?: string; max?: number }): string {
  const max = o.max ?? 160
  const lines: string[] = []
  lines.push(`【纯文本屏幕描述】当前模型不能看图，以下是 OCR（${o.engine || 'tesseract'}）识别出的屏幕文字元素及坐标，坐标系为 ${o.width}x${o.height}（与鼠标工具一致）。`)
  lines.push('提示：要点击某个文字/按钮，使用它的中心坐标；输入框通常显示为其中的提示文字（placeholder），点击它再用 type_text 输入。操作后会返回新的屏幕描述，请据此确认结果。')
  if (o.windows?.length) lines.push(`窗口：${o.windows.slice(0, 15).join(' | ')}`)
  if (!o.elements.length) lines.push('（没有识别到文字）')
  else {
    lines.push(`文字元素（共 ${o.elements.length} 个，从上到下${o.elements.length > max ? `，仅列出前 ${max} 个` : ''}）：`)
    o.elements.slice(0, max).forEach((e, i) => lines.push(`#${i + 1} 「${e.text.slice(0, 80)}」 中心(${e.cx},${e.cy}) 范围[${e.x1},${e.y1}–${e.x2},${e.y2}]`))
  }
  if (o.boxes?.length) {
    lines.push(`矩形控件（检测到的输入框 / 按钮等实心区域，共 ${o.boxes.length} 个；没有文字的白色长条通常是输入框）：`)
    o.boxes.forEach((b, i) => lines.push(`控件${i + 1} ${b.text ? `「${b.text.slice(0, 40)}」` : '（无文字）'} 中心(${b.cx},${b.cy}) 范围[${b.x1},${b.y1}–${b.x2},${b.y2}] 颜色${b.color}`))
  }
  return lines.join('\n')
}

/** 在元素中查找文字（忽略空白、大小写） */
export function findElements(elements: ScreenElement[], query: string): ScreenElement[] {
  const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
  const q = norm(query)
  if (!q) return []
  return elements.filter((e) => norm(e.text).includes(q))
}

export interface UiBox {
  x1: number
  y1: number
  x2: number
  y2: number
  cx: number
  cy: number
  /** 填充颜色 #rrggbb */
  color: string
  /** 区域内识别出的文字 */
  text?: string
}

/**
 * 在截图中检测「实心矩形控件」（输入框、按钮、标签页等）：
 * 对降采样后的像素做颜色相近的连通域分析，保留尺寸合适、边缘完整的矩形区域。
 * bitmap 为 BGRA（Electron nativeImage.toBitmap 的格式）。
 */
export function detectUiBoxes(bitmap: Buffer, width: number, height: number, opts: { step?: number; tol?: number; max?: number } = {}): UiBox[] {
  const step = opts.step ?? 2
  const tol = opts.tol ?? 18
  const gw = Math.floor(width / step)
  const gh = Math.floor(height / step)
  const px = (gx: number, gy: number): [number, number, number] => {
    const i = (gy * step * width + gx * step) * 4
    return [bitmap[i + 2], bitmap[i + 1], bitmap[i]]
  }
  const label = new Int32Array(gw * gh).fill(-1)
  const boxes: UiBox[] = []
  const queue = new Int32Array(gw * gh)
  let comp = 0
  for (let sy = 0; sy < gh; sy++)
    for (let sx = 0; sx < gw; sx++) {
      if (label[sy * gw + sx] >= 0) continue
      const [r0, g0, b0] = px(sx, sy)
      let qh = 0
      let qt = 0
      queue[qt++] = sy * gw + sx
      label[sy * gw + sx] = comp
      let minX = sx
      let maxX = sx
      let minY = sy
      let maxY = sy
      let n = 0
      while (qh < qt) {
        const idx = queue[qh++]
        const x = idx % gw
        const y = (idx / gw) | 0
        n++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        const nb = [idx - 1, idx + 1, idx - gw, idx + gw]
        for (let k = 0; k < 4; k++) {
          const j = nb[k]
          if (j < 0 || j >= gw * gh) continue
          if ((k === 0 && x === 0) || (k === 1 && x === gw - 1)) continue
          if (label[j] >= 0) continue
          const [r, g, b] = px(j % gw, (j / gw) | 0)
          if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) > tol) continue
          label[j] = comp
          queue[qt++] = j
        }
      }
      const bw = (maxX - minX + 1) * step
      const bh = (maxY - minY + 1) * step
      if (bw >= 36 && bh >= 16 && bh <= 140 && bw <= width * 0.6 && bw * bh <= width * height * 0.2 && bw >= bh * 1.2) {
        // 边缘完整度：bbox 内收一格的四条边上属于该连通域的比例
        let edge = 0
        let edgeN = 0
        const inset = 1
        for (let x = minX + 2; x <= maxX - 2; x++)
          for (const y of [minY + inset, maxY - inset]) {
            edgeN++
            if (label[y * gw + x] === comp) edge++
          }
        for (let y = minY + 2; y <= maxY - 2; y++)
          for (const x of [minX + inset, maxX - inset]) {
            edgeN++
            if (label[y * gw + x] === comp) edge++
          }
        const area = (maxX - minX + 1) * (maxY - minY + 1)
        if (edgeN && edge / edgeN >= 0.85 && n / area >= 0.55) {
          const x1 = minX * step
          const y1 = minY * step
          const x2 = (maxX + 1) * step
          const y2 = (maxY + 1) * step
          boxes.push({ x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2), color: '#' + [r0, g0, b0].map((v) => v.toString(16).padStart(2, '0')).join('') })
        }
      }
      comp++
    }
  return boxes.sort((a, b) => a.cy - b.cy || a.cx - b.cx).slice(0, opts.max ?? 40)
}

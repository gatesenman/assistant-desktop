/**
 * v0.7 在截图位图（BGRA，Electron nativeImage.toBitmap 格式）上画 Set-of-Mark 编号框。
 * 不依赖 canvas / 字体：内置 5x7 点阵数字字体，按比例放大绘制。纯函数，可单元测试。
 */
import type { SomElement } from './som'

/** 5x7 数字点阵（每行 5 位，高位在左） */
const DIGITS: number[][] = [
  [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], // 0
  [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e], // 1
  [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], // 2
  [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e], // 3
  [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], // 4
  [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e], // 5
  [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], // 6
  [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08], // 7
  [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], // 8
  [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c] // 9
]

export type Rgb = [number, number, number]

/** 按来源着色：UIA/AT-SPI 洋红、矩形控件 橙色、OCR 文字 青色 */
export const SOURCE_COLORS: Record<string, Rgb> = {
  uia: [236, 72, 153],
  atspi: [236, 72, 153],
  box: [245, 158, 11],
  ocr: [6, 182, 212]
}

export interface Bitmap {
  data: Buffer
  width: number
  height: number
}

function setPx(bm: Bitmap, x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return
  const i = (y * bm.width + x) * 4
  bm.data[i] = c[2]
  bm.data[i + 1] = c[1]
  bm.data[i + 2] = c[0]
  bm.data[i + 3] = 255
}

export function fillRect(bm: Bitmap, x1: number, y1: number, x2: number, y2: number, c: Rgb): void {
  const ax = Math.max(0, Math.floor(x1))
  const ay = Math.max(0, Math.floor(y1))
  const bx = Math.min(bm.width, Math.ceil(x2))
  const by = Math.min(bm.height, Math.ceil(y2))
  for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) setPx(bm, x, y, c)
}

export function strokeRect(bm: Bitmap, x1: number, y1: number, x2: number, y2: number, c: Rgb, t = 2): void {
  fillRect(bm, x1, y1, x2, y1 + t, c)
  fillRect(bm, x1, y2 - t, x2, y2, c)
  fillRect(bm, x1, y1, x1 + t, y2, c)
  fillRect(bm, x2 - t, y1, x2, y2, c)
}

/** 画数字串，返回绘制宽度 */
export function drawNumber(bm: Bitmap, text: string, x: number, y: number, scale: number, c: Rgb): number {
  let cx = x
  for (const ch of text) {
    const g = DIGITS[ch.charCodeAt(0) - 48]
    if (!g) {
      cx += 3 * scale
      continue
    }
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++) if (g[row] & (1 << (4 - col))) fillRect(bm, cx + col * scale, y + row * scale, cx + (col + 1) * scale, y + (row + 1) * scale, c)
    cx += 6 * scale
  }
  return cx - x - scale
}

export function labelSize(id: number, scale: number): { w: number; h: number } {
  const n = String(id).length
  return { w: n * 6 * scale - scale + 2 * scale + 2, h: 7 * scale + 2 * scale + 2 }
}

/**
 * 在位图上绘制编号框。标签放在元素左上角外侧（空间不够时放内侧），
 * 已放置的标签会被避让（向右/向下平移），避免数字重叠看不清。
 * 返回每个编号标签的位置（测试用）。
 */
export function drawMarks(bm: Bitmap, els: SomElement[], opts: { scale?: number; maxLabels?: number } = {}): { id: number; x: number; y: number; w: number; h: number }[] {
  const scale = opts.scale ?? (bm.width >= 1600 ? 3 : 2)
  const placed: { id: number; x: number; y: number; w: number; h: number }[] = []
  const overlaps = (r: { x: number; y: number; w: number; h: number }): boolean =>
    placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)
  for (const e of els.slice(0, opts.maxLabels ?? 200)) {
    const c = SOURCE_COLORS[e.source] || SOURCE_COLORS.box
    strokeRect(bm, e.x1, e.y1, e.x2, e.y2, c, e.source === 'ocr' ? 1 : 2)
    const { w, h } = labelSize(e.id, scale)
    const cands = [
      { x: e.x1, y: e.y1 - h },
      { x: e.x1, y: e.y1 },
      { x: e.x2 - w, y: e.y1 - h },
      { x: e.x1 - w, y: e.y1 },
      { x: e.x2, y: e.y1 },
      { x: e.x1, y: e.y2 }
    ].map((p) => ({ x: Math.max(0, Math.min(bm.width - w, Math.round(p.x))), y: Math.max(0, Math.min(bm.height - h, Math.round(p.y))), w, h }))
    let r = cands.find((p) => !overlaps(p)) || cands[0]
    // 实在放不下：在第一个候选附近向下错位
    for (let k = 0; overlaps(r) && k < 6; k++) r = { ...r, y: Math.min(bm.height - h, r.y + h) }
    fillRect(bm, r.x, r.y, r.x + w, r.y + h, c)
    // 白字 + 1px 深色描边增强对比
    drawNumber(bm, String(e.id), r.x + scale + 1, r.y + scale + 1, scale, [255, 255, 255])
    placed.push({ id: e.id, ...r })
  }
  return placed
}

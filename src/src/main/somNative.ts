import { nativeImage } from 'electron'
import type { Capture } from './core/computer'
import { detectUiBoxes, type UiBox } from './core/ocr'
import type { SomElement } from './core/som'
import { drawMarks } from './core/somDraw'

/** 在截图上画 Set-of-Mark 编号框，返回 JPEG（视觉模型看到的就是这张图） */
export async function annotateCapture(c: Capture, els: SomElement[]): Promise<Buffer> {
  const img = nativeImage.createFromBuffer(c.png || c.jpeg)
  let { width, height } = img.getSize()
  let base = img
  if (width !== c.width || height !== c.height) {
    base = img.resize({ width: c.width, height: c.height, quality: 'good' })
    width = c.width
    height = c.height
  }
  // toBitmap 返回 BGRA，且是副本，可以直接改
  const data = Buffer.from(base.toBitmap())
  drawMarks({ data, width, height }, els, { scale: width >= 1600 ? 3 : 2 })
  return nativeImage.createFromBitmap(data, { width, height }).toJPEG(78)
}

/** 只做矩形控件检测（不跑 OCR，速度快），视觉模式下用来给没有无障碍信息的控件补编号 */
export async function detectBoxes(png: Buffer): Promise<UiBox[]> {
  const img = nativeImage.createFromBuffer(png)
  const { width, height } = img.getSize()
  return detectUiBoxes(img.toBitmap(), width, height, { max: 40 })
}

/** BGRA 帧 → Capture（VNC 等来源） */
export function encodeBgra(bgra: Buffer, width: number, height: number, maxW = 1280): Capture {
  let img = nativeImage.createFromBitmap(bgra, { width, height })
  if (width > maxW) img = img.resize({ width: maxW, quality: 'good' })
  const s = img.getSize()
  return { jpeg: img.toJPEG(72), thumb: img.resize({ width: 320, quality: 'good' }).toJPEG(60), width: s.width, height: s.height, png: img.toPNG() }
}

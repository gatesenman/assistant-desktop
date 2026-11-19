import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import type { ComputerLogEntry } from '../../shared/types'

export interface ReplayFrame {
  at: number
  tool: string
  args: string
  ok: boolean
  error?: string
  thumb?: string
  reasoning?: string
}

export interface TaskTimeline {
  runId: string
  assistantId: string
  taskId?: string
  startedAt: number
  endedAt: number
  frames: ReplayFrame[]
}

/** 按任务 / 运行分组电脑日志 */
export function groupComputerLog(log: ComputerLogEntry[]): TaskTimeline[] {
  const map = new Map<string, TaskTimeline>()
  for (const e of log) {
    const runId = e.runId || e.taskId || `solo:${e.assistantId}`
    let g = map.get(runId)
    if (!g) {
      g = { runId, assistantId: e.assistantId, taskId: e.taskId, startedAt: e.at, endedAt: e.at, frames: [] }
      map.set(runId, g)
    }
    g.endedAt = Math.max(g.endedAt, e.at)
    g.startedAt = Math.min(g.startedAt, e.at)
    g.frames.push({
      at: e.at,
      tool: e.tool,
      args: e.args,
      ok: e.ok,
      error: e.error,
      thumb: e.thumb,
      reasoning: e.reasoning
    })
  }
  return [...map.values()].sort((a, b) => b.startedAt - a.startedAt)
}

function decodeDataUrl(url: string): Buffer | null {
  const m = String(url || '').match(/^data:image\/\w+;base64,(.+)$/)
  if (!m) return null
  try {
    return Buffer.from(m[1], 'base64')
  } catch {
    return null
  }
}

/** 将截图序列导出为 GIF（纯 JS 简化：多帧拼成「幻灯」GIF 不实现完整编码器时退化为写出帧目录 + 尝试 ffmpeg） */
export function exportReplay(
  frames: ReplayFrame[],
  outDir: string,
  opts: { format?: 'gif' | 'mp4'; fps?: number; basename?: string } = {}
): { ok: boolean; path?: string; message: string; framesDir?: string } {
  fs.mkdirSync(outDir, { recursive: true })
  const format = opts.format || 'gif'
  const fps = Math.max(1, Math.min(10, opts.fps || 2))
  const base = opts.basename || `replay-${Date.now()}`
  const framesDir = path.join(outDir, base + '-frames')
  fs.mkdirSync(framesDir, { recursive: true })
  const withThumb = frames.filter((f) => f.thumb)
  if (!withThumb.length) return { ok: false, message: '没有可导出的截图帧' }
  const files: string[] = []
  withThumb.forEach((f, i) => {
    const buf = decodeDataUrl(f.thumb!)
    if (!buf) return
    const ext = f.thumb!.startsWith('data:image/png') ? 'png' : 'jpg'
    const fp = path.join(framesDir, `frame-${String(i).padStart(4, '0')}.${ext}`)
    fs.writeFileSync(fp, buf)
    files.push(fp)
  })
  if (!files.length) return { ok: false, message: '截图解码失败', framesDir }

  const outPath = path.join(outDir, `${base}.${format}`)
  // 统一为 png 序号，避免 glob 在部分 ffmpeg 构建上失败
  const seqDir = path.join(framesDir, '_seq')
  fs.mkdirSync(seqDir, { recursive: true })
  files.forEach((fp, i) => {
    const dest = path.join(seqDir, `frame-${String(i).padStart(4, '0')}.png`)
    try {
      fs.copyFileSync(fp, dest)
    } catch {
      fs.writeFileSync(dest, fs.readFileSync(fp))
    }
  })
  const inputPattern = path.join(seqDir, 'frame-%04d.png')
  const vfGif = 'scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse'
  const vfMp4 = 'scale=960:-2'
  const ffArgs =
    format === 'gif'
      ? ['-y', '-framerate', String(fps), '-i', inputPattern, '-vf', vfGif, outPath]
      : ['-y', '-framerate', String(fps), '-i', inputPattern, '-vf', vfMp4, '-pix_fmt', 'yuv420p', outPath]
  const ff = spawnSync('ffmpeg', ffArgs, { encoding: 'utf8', timeout: 120000 })
  if (ff.status === 0 && fs.existsSync(outPath)) {
    return { ok: true, path: outPath, message: `已导出 ${format.toUpperCase()}（${files.length} 帧）`, framesDir }
  }
  const listPath = path.join(outDir, `${base}-frames.json`)
  fs.writeFileSync(listPath, JSON.stringify({ frames: files, fps, note: 'ffmpeg 不可用或失败，已导出帧序列' }, null, 2))
  return {
    ok: true,
    path: listPath,
    message: `ffmpeg 未能生成 ${format}（${String(ff.stderr || ff.error || 'unknown').slice(0, 200)}），已导出 ${files.length} 帧到 ${framesDir}`,
    framesDir
  }
}

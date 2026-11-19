import { app, nativeImage } from 'electron'
import { execFile } from 'child_process'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { detectUiBoxes, parseTesseractTsv, type OcrWord, type UiBox } from './core/ocr'

/**
 * OCR 引擎：
 * 1. 系统已安装的 tesseract 命令行（最快，Linux 可 apt install tesseract-ocr tesseract-ocr-chi-sim）
 * 2. 内置 tesseract.js（WebAssembly，离线语言包 chi_sim+eng 随安装包分发，Windows/macOS 开箱即用）
 */
const UPSCALE = 2

function tessdataDir(): string {
  const cands = [
    path.join(process.resourcesPath || '', 'tessdata'),
    path.join(app.getAppPath(), 'resources', 'tessdata'),
    path.join(__dirname, '../../resources/tessdata')
  ]
  return cands.find((d) => fs.existsSync(path.join(d, 'eng.traineddata'))) || cands[0]
}

let cliOk: Promise<boolean> | null = null
function hasCli(): Promise<boolean> {
  if (process.env.ASSISTANT_OCR_ENGINE === 'wasm') return Promise.resolve(false)
  cliOk ??= new Promise((resolve) => {
    execFile('tesseract', ['--list-langs'], { timeout: 5000 }, (err, stdout, stderr) => resolve(!err && /chi_sim|eng/.test(stdout + stderr)))
  })
  return cliOk
}

function cliLangs(): Promise<string> {
  return new Promise((resolve) => {
    execFile('tesseract', ['--list-langs'], { timeout: 5000 }, (_e, out, err) => {
      const t = out + err
      resolve([t.includes('chi_sim') && 'chi_sim', t.includes('eng') && 'eng'].filter(Boolean).join('+') || 'eng')
    })
  })
}

async function ocrCli(png: Buffer, psm = '11', format: 'tsv' | 'txt' = 'tsv'): Promise<string> {
  const file = path.join(os.tmpdir(), `assistant-ocr-${process.pid}-${Date.now()}.png`)
  fs.writeFileSync(file, png)
  const langs = await cliLangs()
  try {
    return await new Promise<string>((resolve, reject) =>
      execFile('tesseract', [file, 'stdout', '-l', langs, '--psm', psm, ...(format === 'tsv' ? ['tsv'] : [])], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout)
      )
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/**
 * tesseract.js 在 Electron 环境下会把 langPath 当作 URL 用 fetch 读取，
 * 因此用一个仅监听 127.0.0.1 的只读小服务器提供内置语言包。
 */
let langServer: Promise<string> | null = null
function serveTessdata(): Promise<string> {
  langServer ??= new Promise((resolve, reject) => {
    const dir = tessdataDir()
    const srv = http.createServer((req, res) => {
      const name = path.basename(decodeURIComponent((req.url || '').split('?')[0]))
      const file = path.join(dir, name)
      if (!/^[\w-]+\.traineddata(\.gz)?$/.test(name) || !fs.existsSync(file)) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    })
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      srv.unref()
      resolve(`http://127.0.0.1:${(srv.address() as any).port}`)
    })
  })
  return langServer
}

let worker: Promise<any> | null = null
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}
async function ocrWasm(png: Buffer, psm = '11', format: 'tsv' | 'txt' = 'tsv'): Promise<string> {
  worker ??= (async () => {
    const { createWorker } = await import('tesseract.js')
    const w = await createWorker(['chi_sim', 'eng'], 1, {
      langPath: await serveTessdata(),
      // 不让 worker 错误变成主进程未捕获异常（会导致应用重启）
      errorHandler: (e: unknown) => console.warn('[ocr] tesseract.js', e),
      gzip: false,
      cachePath: path.join(app.getPath('userData'), 'ocr-cache'),
      cacheMethod: 'none'
    } as any)
    await w.setParameters({ tessedit_pageseg_mode: '11' as any })
    return w
  })().catch((e) => {
    worker = null
    throw e
  })
  const w = await withTimeout(worker, 90000, 'OCR 引擎初始化超时')
  await w.setParameters({ tessedit_pageseg_mode: psm as any })
  const r: any = await withTimeout(w.recognize(png, {}, { tsv: format === 'tsv', text: format === 'txt', blocks: false, hocr: false }), 60000, 'OCR 识别超时')
  return (format === 'tsv' ? r.data.tsv : r.data.text) || ''
}

export async function ocrEngine(): Promise<string> {
  if (await hasCli()) return 'tesseract'
  return fs.existsSync(path.join(tessdataDir(), 'eng.traineddata')) ? 'tesseract.js' : 'none'
}

/**
 * 识别截图：整屏 OCR（文字及坐标）+ 矩形控件检测（输入框 / 按钮），并对每个控件单独做单行 OCR 作为标签。
 * png 为截图坐标系的图像，返回坐标均为该坐标系。
 */
export async function runOcr(png: Buffer): Promise<{ words: OcrWord[]; boxes: UiBox[]; engine: string }> {
  const img = nativeImage.createFromBuffer(png)
  const { width, height } = img.getSize()
  const cli = await hasCli()
  const run = cli ? ocrCli : ocrWasm
  const big = img.resize({ width: width * UPSCALE, quality: 'best' }).toPNG()
  const words = parseTesseractTsv(await run(big, '11', 'tsv'), UPSCALE)
  let boxes: UiBox[] = []
  try {
    boxes = detectUiBoxes(img.toBitmap(), width, height, { max: 30 })
    for (const b of boxes) {
      const crop = img.crop({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 })
      const t = (await run(crop.resize({ width: (b.x2 - b.x1) * UPSCALE, quality: 'best' }).toPNG(), '7', 'txt')).replace(/\s+/g, ' ').trim()
      if (t && /[\p{L}\p{N}]/u.test(t)) b.text = t.replace(/(?<=[\u4e00-\u9fff]) (?=[\u4e00-\u9fff])/g, '')
    }
  } catch (e) {
    console.warn('[ocr] 控件检测失败', e)
  }
  return { words, boxes, engine: cli ? 'tesseract' : 'tesseract.js' }
}

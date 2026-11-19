import type { UpdateInfo } from '../../shared/types'

/** 比较语义化版本：a>b 返回 1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * 自动更新钩子（占位实现）：从 updateUrl 读取 latest.json
 *   { "version": "0.4.0", "notes": "...", "url": "https://.../AssistantDesktop-Setup-0.4.0.exe" }
 * 目前只提示并打开下载页面；以后可替换为 electron-updater。
 */
export async function checkForUpdate(current: string, updateUrl: string, fetchImpl: typeof fetch = fetch): Promise<UpdateInfo> {
  if (!updateUrl) return { ok: false, current, available: false, message: '尚未配置更新地址（全局设置 → 关于与更新）' }
  try {
    const res = await fetchImpl(updateUrl, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } })
    if (!res.ok) return { ok: false, current, available: false, message: `检查更新失败：HTTP ${res.status}` }
    const j = (await res.json()) as { version?: string; notes?: string; url?: string }
    if (!j.version) return { ok: false, current, available: false, message: '更新信息格式不正确（缺少 version）' }
    const available = compareVersions(j.version, current) > 0
    return {
      ok: true,
      current,
      latest: j.version,
      available,
      notes: j.notes,
      url: j.url,
      message: available ? `发现新版本 ${j.version}（当前 ${current}）` : `已是最新版本（${current}）`
    }
  } catch (e: any) {
    return { ok: false, current, available: false, message: '检查更新失败：' + (e?.message || String(e)) }
  }
}

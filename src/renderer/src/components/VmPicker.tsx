import { useEffect, useMemo, useState } from 'react'
import type { AppState, Assistant, VmOs, VmPreflightResult, VmStatus, VmUserConfig } from '../../../shared/types'
import { normalizeVmConfig, VM_OS_LIST, VM_PROFILES } from '../../../shared/vmProfiles'
import Icon from './Icon'

/** 状态徽标文字 + 色调 */
export function vmBadge(st?: VmStatus | null): { text: string; tone: 'ok' | 'warn' | 'err' | 'idle' | 'busy' } {
  if (!st) return { text: '未创建', tone: 'idle' }
  switch (st.phase) {
    case 'ready':
      return { text: '运行中', tone: 'ok' }
    case 'installing':
      return {
        text: /下载/.test(st.progress || '') ? `下载系统中${st.percent !== undefined ? ' ' + st.percent + '%' : ''}` : st.percent !== undefined ? `安装中 ${st.percent}%` : '运行中 · 安装/启动',
        tone: 'busy'
      }
    case 'building':
      return { text: '下载/构建中', tone: 'busy' }
    case 'starting':
    case 'configuring':
    case 'checking':
      return { text: st.phase === 'checking' ? '检测中' : '启动中', tone: 'busy' }
    case 'sleeping':
      return { text: '已休眠', tone: 'warn' }
    case 'stopped':
      return { text: '已停止', tone: 'warn' }
    case 'need_docker':
      return { text: '需要 Docker', tone: 'err' }
    case 'need_kvm':
      return { text: '需要 KVM', tone: 'err' }
    case 'error':
      return { text: '出错', tone: 'err' }
    default:
      return st.containerExists ? { text: '已停止', tone: 'warn' } : { text: '未创建', tone: 'idle' }
  }
}

const isRunning = (st?: VmStatus | null): boolean => !!st && (st.phase === 'ready' || st.phase === 'installing' || (st.containerRunning && st.phase !== 'sleeping'))
const exists = (st?: VmStatus | null): boolean =>
  !!st && (!!st.containerExists || ['ready', 'installing', 'sleeping', 'stopped'].includes(st.phase))

/** 内嵌虚拟桌面（iframe 加载 noVNC / dockur Web 查看器） */
export function VmViewer({ st, onClose }: { st: VmStatus; onClose(): void }): JSX.Element {
  const url = st.desktopUrl || ''
  const [nonce, setNonce] = useState(0)
  return (
    <div className="modal-backdrop vm-viewer-backdrop" data-testid="vm-viewer" onClick={onClose}>
      <div className="vm-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="vm-viewer-bar">
          <strong>
            <Icon name={VM_PROFILES[st.os].icon} /> {VM_PROFILES[st.os].title}
          </strong>
          <span className="muted small">{url}</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" title="重新加载" onClick={() => setNonce((n) => n + 1)}>
            <Icon name="refresh-line" />
          </button>
          <button className="btn sm" data-testid="vm-viewer-takeover" onClick={() => void window.api.takeover('', '用户从虚拟桌面查看器接管')}>
            <Icon name="hand-heart-line" /> 我来接管
          </button>
          <button className="btn sm" data-testid="vm-viewer-handback" onClick={() => void window.api.handback('', '')}>
            <Icon name="play-circle-line" /> 交还继续
          </button>
          <button className="btn sm" data-testid="vm-viewer-open-browser" onClick={() => void window.api.vmOpenInBrowser(st.os)}>
            <Icon name="external-link-line" /> 在浏览器打开
          </button>
          <button className="btn sm" data-testid="vm-viewer-close" onClick={onClose}>
            <Icon name="close-line" />
          </button>
        </div>
        {url ? (
          <iframe key={nonce} className="vm-viewer-frame" src={url} title="虚拟桌面" data-testid="vm-viewer-frame" allow="clipboard-read; clipboard-write; fullscreen" />
        ) : (
          <div className="preview-empty muted">虚拟电脑未运行</div>
        )}
      </div>
    </div>
  )
}

/** v0.6 选择系统：Linux / Windows / macOS 桌面卡片 + 每台 VM 的管理操作 */
export default function VmPicker({
  state,
  assistant,
  onState,
  onHint
}: {
  state: AppState
  assistant: Assistant
  onState(s: AppState): void
  onHint?(t: string): void
}): JSX.Element {
  const [list, setList] = useState<VmStatus[]>(state.vms || [])
  const [sel, setSel] = useState<VmOs>(state.settings.vmLastOs || assistant.vmOs || 'linux')
  const [cfgs, setCfgs] = useState<Partial<Record<VmOs, VmUserConfig>>>(state.settings.vmConfigs || {})
  const [pf, setPf] = useState<Partial<Record<VmOs, VmPreflightResult>>>({})
  const [busy, setBusy] = useState<VmOs | null>(null)
  const [hint, setHint] = useState('')
  const [viewer, setViewer] = useState<VmOs | null>(null)
  const [showAdv, setShowAdv] = useState(false)

  useEffect(() => {
    if (state.vms?.length) setList(state.vms)
  }, [state.vms])
  useEffect(() => {
    void window.api.vmList().then(setList).catch(() => {})
    const off = window.api.onEvent((ev) => {
      if (ev.type === 'vms') setList(ev.list)
    })
    return () => {
      off()
    }
  }, [])

  const byOs = useMemo(() => {
    const m: Partial<Record<VmOs, VmStatus>> = {}
    for (const s of list) m[s.os] = s
    return m
  }, [list])
  const cfg = normalizeVmConfig(sel, cfgs[sel])
  const prof = VM_PROFILES[sel]
  const cur = byOs[sel]
  const say = (t: string): void => {
    setHint(t)
    onHint?.(t)
  }

  const choose = async (os: VmOs): Promise<void> => {
    setSel(os)
    setShowAdv(false)
    onState(await window.api.vmSaveConfig(os, cfgs[os]))
  }
  const updCfg = (patch: Partial<VmUserConfig>): void => {
    setCfgs((c) => ({ ...c, [sel]: normalizeVmConfig(sel, { ...cfg, ...patch }) }))
  }
  const upsert = (s: VmStatus): void => setList((l) => [...l.filter((x) => x.os !== s.os), s])

  const runPreflight = async (os: VmOs): Promise<void> => {
    setBusy(os)
    say('正在预检…')
    try {
      const r = await window.api.vmPreflight(os, assistant.id)
      setPf((p) => ({ ...p, [os]: r }))
      say(r.ok ? '预检通过' : '预检未通过，请按提示处理')
    } catch (e: any) {
      say(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }
  const start = async (os: VmOs, forceRebuild = false): Promise<void> => {
    setBusy(os)
    say(forceRebuild ? '正在强制重建…' : '正在启动…')
    try {
      const s = await window.api.vmStart(os, assistant.id, { forceRebuild, config: normalizeVmConfig(os, cfgs[os]) })
      upsert(s)
      if (s.preflight) setPf((p) => ({ ...p, [os]: { os, ...s.preflight! } }))
      onState(await window.api.getState())
      say(s.message)
    } catch (e: any) {
      say(String(e?.message || e))
    } finally {
      setBusy(null)
    }
  }
  const act = async (os: VmOs, kind: 'sleep' | 'stop' | 'delete'): Promise<void> => {
    if (kind === 'delete') {
      const p = VM_PROFILES[os]
      const removeData =
        p.volume !== null && window.confirm(`同时删除「${p.title}」的系统磁盘（${p.volume}）吗？\n确定 = 连同已安装的系统一起删除（不可恢复）\n取消 = 只删除容器，保留磁盘`)
      if (!window.confirm(`确定删除「${p.title}」虚拟电脑容器？`)) return
      setBusy(os)
      try {
        upsert(await window.api.vmDelete(os, removeData))
      } finally {
        setBusy(null)
      }
    } else {
      setBusy(os)
      try {
        upsert(kind === 'sleep' ? await window.api.vmSleep(os) : await window.api.vmStop(os))
      } finally {
        setBusy(null)
      }
    }
    onState(await window.api.getState())
  }
  const setActive = async (os: VmOs): Promise<void> => {
    onState(await window.api.vmSetActive(os, assistant.id))
    say(`电脑控制目标已切换到：${VM_PROFILES[os].title}${!VM_PROFILES[os].agentControl ? '（该系统暂不支持自动键鼠，仅手动操作）' : os === 'linux' ? '' : '（智能体通过 VNC 自动键鼠；VNC 只能输入英文字符）'}`)
  }

  const activeMid = state.settings.activeMachineId
  const curPf = pf[sel] || (cur?.preflight ? { os: sel, ...cur.preflight } : undefined)
  const created = VM_OS_LIST.filter((o) => exists(byOs[o]))

  return (
    <div className="vm-picker" data-testid="vm-picker">
      <div className="vm-picker-title">
        <strong>选择系统</strong>
        <span className="muted small">每个系统一台，可同时存在</span>
      </div>
      <div className="vm-os-cards" data-testid="vm-os-cards">
        {VM_OS_LIST.map((os) => {
          const p = VM_PROFILES[os]
          const b = vmBadge(byOs[os])
          return (
            <button
              key={os}
              className={'vm-os-card' + (sel === os ? ' selected' : '')}
              data-testid={`vm-os-card-${os}`}
              aria-pressed={sel === os}
              onClick={() => void choose(os)}
            >
              <div className="vm-os-icon">
                <Icon name={p.icon} size={22} />
              </div>
              <div className="vm-os-main">
                <div className="vm-os-head">
                  <span className="vm-os-name">{p.title}</span>
                  <span className={'vm-badge ' + b.tone} data-testid={`vm-badge-${os}`}>
                    {b.text}
                  </span>
                </div>
                <div className="vm-os-desc">{p.short}</div>
                <div className="vm-os-req">
                  <Icon name="cpu-line" /> {p.requirement}
                </div>
                {p.licenseNote && (
                  <div className="vm-os-license" data-testid={`vm-license-${os}`}>
                    <Icon name="information-line" /> {p.licenseNote}
                  </div>
                )}
              </div>
              {sel === os && <Icon name="checkbox-circle-fill" className="vm-os-check" />}
            </button>
          )
        })}
      </div>

      <div className="vm-config" data-testid="vm-config">
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <label className="small" style={{ flex: 1 }}>
            版本
            <select
              className="input"
              data-testid="vm-version"
              value={cfg.version}
              disabled={sel === 'linux'}
              onChange={(e) => updCfg({ version: e.target.value })}
            >
              {prof.versions.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          {sel !== 'linux' && (
            <button className="btn sm ghost" data-testid="vm-adv-toggle" onClick={() => setShowAdv((v) => !v)} style={{ alignSelf: 'flex-end' }}>
              <Icon name="settings-3-line" /> 资源
            </button>
          )}
        </div>
        {sel !== 'linux' && showAdv && (
          <div className="vm-res-grid" data-testid="vm-resources">
            <label className="small">
              内存 GB
              <input className="input" type="number" min={2} max={64} value={cfg.ramGb} onChange={(e) => updCfg({ ramGb: Number(e.target.value) })} />
            </label>
            <label className="small">
              CPU 核
              <input className="input" type="number" min={1} max={32} value={cfg.cpuCores} onChange={(e) => updCfg({ cpuCores: Number(e.target.value) })} />
            </label>
            <label className="small">
              磁盘 GB
              <input className="input" type="number" min={32} max={1024} value={cfg.diskGb} onChange={(e) => updCfg({ diskGb: Number(e.target.value) })} />
            </label>
            {sel === 'windows' && (
              <label className="small">
                语言
                <select className="input" value={cfg.language} onChange={(e) => updCfg({ language: e.target.value })}>
                  {['Chinese', 'English', 'Japanese', 'Korean'].map((l) => (
                    <option key={l} value={l}>
                      {l === 'Chinese' ? '中文' : l === 'English' ? 'English' : l === 'Japanese' ? '日本語' : '한국어'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="muted small" style={{ gridColumn: '1 / -1' }}>
              {sel === 'windows'
                ? '首次启动会自动下载并安装 Windows（默认账户 Docker / 密码 admin），磁盘数据保存在卷中。'
                : '首次启动后需在桌面中：磁盘工具 → 抹掉最大的 VirtIO 磁盘 → 重新安装 macOS。'}
              {' '}已创建的虚拟电脑修改资源后需「强制重建」生效（磁盘保留）。
            </div>
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {!isRunning(cur) && (
            <button className="btn primary" data-testid="vm-start" disabled={busy === sel} onClick={() => void start(sel)}>
              <Icon name="play-circle-line" />{' '}
              {busy === sel ? '请稍候…' : cur?.phase === 'sleeping' ? '唤醒' : exists(cur) ? '启动' : `创建并启动${prof.title}`}
            </button>
          )}
          <button className="btn sm" data-testid="vm-preflight" disabled={busy === sel} onClick={() => void runPreflight(sel)}>
            <Icon name="shield-check-line" /> 预检
          </button>
        </div>
        {cur && cur.phase !== 'idle' && (
          <div className="muted small" data-testid="local-vm-status" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
            <span className={'vm-badge ' + vmBadge(cur).tone}>{vmBadge(cur).text}</span>{' '}
            {(cur.phase === 'need_docker' || cur.phase === 'need_kvm') && curPf ? '详见下方预检结果' : (cur.message || '').split('\n')[0]}
          </div>
        )}
        {curPf && (
          <div className={'vm-preflight' + (curPf.ok ? '' : ' err')} data-testid="vm-preflight-result">
            <div className="vm-preflight-head">
              <Icon name={curPf.ok ? 'checkbox-circle-line' : 'error-warning-line'} /> {curPf.ok ? `${prof.title}预检通过` : `${prof.title}预检未通过`}
            </div>
            {curPf.items.map((i) => (
              <div key={i.id} className={'vm-pf-item ' + (i.ok ? (i.warn ? 'warn' : 'ok') : 'fail')} data-testid={`vm-pf-${i.id}`}>
                <span className="vm-pf-mark">{i.ok ? (i.warn ? '⚠' : '✓') : '✗'}</span>
                <div>
                  <div>
                    <strong>{i.label}</strong>：{i.detail}
                  </div>
                  {!i.ok && i.fix && (
                    <ol className="vm-pf-fix">
                      {i.fix.map((f, k) => (
                        <li key={k}>{f.replace(/^\d+\.\s*/, '')}</li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            ))}
            {curPf.items.some((i) => i.id === 'docker' && !i.ok) && (
              <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => void window.api.localVmTryStartDocker().then(() => runPreflight(sel))}>
                  <Icon name="play-circle-line" /> 启动 Docker Desktop
                </button>
                <button className="btn sm" onClick={() => void window.api.openExternal('https://www.docker.com/products/docker-desktop/')}>
                  <Icon name="download-line" /> Docker 官网
                </button>
              </div>
            )}
          </div>
        )}
        {cur && (cur.phase === 'error' || cur.phase === 'building' || cur.phase === 'installing' || cur.phase === 'starting') && !curPf?.items.some((i) => !i.ok) && (
          <div className={'vm-status' + (cur.phase === 'error' ? ' err' : '')} data-testid="vm-progress">
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
              {cur.progress || cur.message}
            </div>
            {cur.percent !== undefined && (
              <div className="vm-progress-bar">
                <div style={{ width: `${cur.percent}%` }} />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="vm-picker-title" style={{ marginTop: 14 }}>
        <strong>我的虚拟电脑</strong>
        <span className="muted small">{created.length ? `${created.length} 台` : '尚未创建'}</span>
      </div>
      <div className="vm-list" data-testid="vm-list">
        {created.length === 0 && <div className="muted small">选择上方系统后点「创建并启动」。</div>}
        {created.map((os) => {
          const st = byOs[os]!
          const p = VM_PROFILES[os]
          const b = vmBadge(st)
          const running = isRunning(st)
          const active = activeMid === p.machineId || (os === 'linux' && activeMid === 'virtual')
          return (
            <div key={os} className={'vm-row' + (active ? ' active' : '')} data-testid={`vm-row-${os}`}>
              <div className="vm-row-head">
                <Icon name={p.icon} /> <strong>{p.title}</strong>
                <span className={'vm-badge ' + b.tone}>{b.text}</span>
                {active && <span className="pill accent">控制目标</span>}
                <span style={{ flex: 1 }} />
                <span className="muted small">:{st.webPort}</span>
              </div>
              {(st.phase === 'installing' || st.phase === 'building') && st.progress && <div className="muted small vm-row-progress">{st.progress}</div>}
              <div className="row vm-row-actions">
                {running ? (
                  <>
                    <button className="btn sm primary" data-testid={`vm-open-${os}`} onClick={() => setViewer(os)}>
                      <Icon name="window-line" /> 打开桌面
                    </button>
                    <button className="btn sm" data-testid={`vm-browser-${os}`} title="在浏览器打开" onClick={async () => say((await window.api.vmOpenInBrowser(os)).message)}>
                      <Icon name="external-link-line" />
                    </button>
                    <button className="btn sm" data-testid={`vm-sleep-${os}`} disabled={busy === os} onClick={() => void act(os, 'sleep')}>
                      <Icon name="moon-line" /> 休眠
                    </button>
                    <button className="btn sm" data-testid={`vm-stop-${os}`} disabled={busy === os} onClick={() => void act(os, 'stop')}>
                      <Icon name="shut-down-line" /> 停止
                    </button>
                  </>
                ) : (
                  <button className="btn sm primary" data-testid={`vm-resume-${os}`} disabled={busy === os} onClick={() => void start(os)}>
                    <Icon name="play-circle-line" /> {st.phase === 'sleeping' ? '唤醒' : '启动'}
                  </button>
                )}
                {!active && (
                  <button className="btn sm" data-testid={`vm-target-${os}`} onClick={() => void setActive(os)} title="设为智能体电脑控制目标">
                    <Icon name="focus-3-line" /> 设为目标
                  </button>
                )}
                <button className="btn sm" data-testid={`vm-rebuild-${os}`} disabled={busy === os} onClick={() => void start(os, true)} title={os === 'linux' ? '重新构建镜像并重建容器' : '重新拉取镜像并重建容器（磁盘保留）'}>
                  <Icon name="refresh-line" /> 强制重建
                </button>
                <button className="btn sm danger" data-testid={`vm-delete-${os}`} disabled={busy === os} onClick={() => void act(os, 'delete')}>
                  <Icon name="delete-bin-line" /> 删除
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {hint && (
        <div className="muted small" data-testid="vm-hint" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
          {hint}
        </div>
      )}
      {viewer && byOs[viewer] && <VmViewer st={byOs[viewer]!} onClose={() => setViewer(null)} />}
    </div>
  )
}

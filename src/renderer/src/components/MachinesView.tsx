import { useEffect, useState } from 'react'
import type { AppState, LocalVmStatus } from '../../../shared/types'
import Icon from './Icon'
import { vmBadge } from './VmPicker'
import { VM_PROFILES } from '../../../shared/vmProfiles'

export default function MachinesView({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const machines = state.machines || []
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('ws://127.0.0.1:8787')
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState('')
  const [vm, setVm] = useState<LocalVmStatus | null>(state.localVm || null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.localVmStatus().then(setVm).catch(() => {})
    void window.api.vmList().catch(() => {})
  }, [])

  return (
    <div className="page" data-testid="machines-view">
      <div className="page-inner">
        <div className="page-head">
          <h2>
            <Icon name="computer-line" /> 电脑
          </h2>
        </div>

        <section className="card form" data-testid="local-vm-card">
          <h3>
            <Icon name="cloud-line" /> 本地虚拟电脑（推荐）
          </h3>
          <p className="muted small">
            一键启动 Docker Linux 桌面：自动配置中文、Firefox、挂载工作目录，并把键鼠控制指向该环境。装好即用，无需再手工设置。
          </p>
          {vm && (
            <div className="vm-status" data-testid="machines-vm-status">
              <strong>{vm.phase}</strong> — {vm.message}
            </div>
          )}
          {(vm?.phase === 'need_docker' || vm?.phase === 'error') && vm.installGuide && (
            <pre className="vm-guide" data-testid="docker-install-guide">
              {vm.installGuide}
            </pre>
          )}
          {(vm?.phase === 'need_docker' || (vm && vm.dockerInstalled && !vm.dockerRunning)) && (
            <div className="form-actions" data-testid="docker-actions">
              {vm.dockerInstalled && !vm.dockerRunning && (
                <button
                  className="btn primary"
                  data-testid="start-docker-desktop"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      const s = await window.api.localVmTryStartDocker()
                      setVm(s)
                      onState(await window.api.getState())
                      setMsg(s.message)
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  启动 Docker Desktop
                </button>
              )}
              <button className="btn" data-testid="open-docker-download" onClick={() => void window.api.openExternal('https://www.docker.com/products/docker-desktop/')}>
                打开 Docker 官网下载
              </button>
            </div>
          )}
          <div className="form-actions">
            <button
              className="btn primary"
              data-testid="local-vm-start"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const s = await window.api.localVmStart()
                  setVm(s)
                  onState(await window.api.getState())
                  setMsg(s.phase === 'ready' ? '虚拟电脑已就绪' : s.message)
                } catch (e: any) {
                  setMsg(String(e?.message || e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? '启动中…' : '一键启动虚拟电脑'}
            </button>
            <button
              className="btn"
              data-testid="open-desktop"
              onClick={async () => {
                const r = await window.api.localVmOpenDesktop()
                setMsg(r.message)
              }}
            >
              打开桌面
            </button>
            <button
              className="btn"
              data-testid="sleep-vm"
              onClick={async () => {
                setVm(await window.api.localVmStop())
                onState(await window.api.getState())
              }}
            >
              休眠
            </button>
            <button
              className="btn"
              data-testid="local-vm-rebuild"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const s = await window.api.localVmRebuild()
                  setVm(s)
                  onState(await window.api.getState())
                  setMsg(s.message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              强制重建镜像
            </button>
          </div>
          {msg && <div className="muted small">{msg}</div>}
          <div className="vm-list" data-testid="machines-vm-list" style={{ marginTop: 12 }}>
            <div className="muted small">v0.6：在右侧「电脑 → 虚拟电脑」中可选择 Linux / Windows / macOS 桌面，各系统可同时存在：</div>
            {(state.vms || []).map((v) => (
              <div key={v.os} className="vm-row" data-testid={`machines-vm-${v.os}`}>
                <div className="vm-row-head">
                  <Icon name={VM_PROFILES[v.os].icon} /> <strong>{VM_PROFILES[v.os].title}</strong>
                  <span className={'vm-badge ' + vmBadge(v).tone}>{vmBadge(v).text}</span>
                  <span style={{ flex: 1 }} />
                  <span className="muted small">
                    {VM_PROFILES[v.os].container} · :{v.webPort}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card form">
          <h3>本机作为远程伴侣</h3>
          <div className="form-actions">
            <button className="btn primary" data-testid="remote-start" onClick={async () => setMsg((await window.api.startRemoteAgentServer()).message)}>
              开启监听
            </button>
            <button className="btn" onClick={() => void window.api.stopRemoteAgentServer()}>
              停止
            </button>
          </div>
          <p className="muted small">高级：让其他电脑连到本机。日常推荐上方「本地虚拟电脑」。</p>
        </section>
        <section className="card form">
          <h3>添加远程机器</h3>
          <label>
            名称
            <input className="input" data-testid="machine-label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            WebSocket 地址
            <input className="input mono" data-testid="machine-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label>
            口令
            <input className="input mono" type="password" data-testid="machine-token" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <button
            className="btn primary"
            data-testid="machine-save"
            onClick={async () => {
              try {
                await window.api.saveMachine({ label: label || '远程电脑', url, token })
                onState(await window.api.getState())
                setMsg('已连接')
              } catch (e: any) {
                setMsg(String(e?.message || e))
              }
            }}
          >
            连接并保存
          </button>
        </section>
        <section className="card form">
          <h3>机器列表</h3>
          {machines.map((m) => (
            <div key={m.id} className="row" data-testid={`machine-${m.id}`} style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <strong>{m.label}</strong>{' '}
                <span className="muted small">
                  {m.kind} · {m.status}
                  {m.platform ? ' · ' + m.platform : ''}
                </span>
                {m.url && <div className="muted small mono">{m.url}</div>}
              </div>
              <div className="row">
                <button
                  className={'btn sm' + (state.settings.activeMachineId === m.id ? ' primary' : '')}
                  data-testid={`machine-active-${m.id}`}
                  onClick={async () => onState(await window.api.setActiveMachine(m.id))}
                >
                  {state.settings.activeMachineId === m.id ? '当前目标' : '设为电脑控制目标'}
                </button>
                {m.kind === 'remote' && (
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await window.api.deleteMachine(m.id)
                      onState(await window.api.getState())
                    }}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

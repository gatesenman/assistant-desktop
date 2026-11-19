import { useEffect, useState } from 'react'
import type { AppState, Assistant, ComputerTargetMode, LocalVmStatus } from '../../../shared/types'
import Icon from './Icon'
import VmPicker from './VmPicker'
import { vmOsFromMachineId, VM_PROFILES } from '../../../shared/vmProfiles'

/** 右侧电脑面板：本机 / 虚拟电脑（一键） / 远程 / 关闭；预览 ≠ 授权 */
export default function ComputerPanel({
  state,
  assistant,
  onState,
  open,
  onClose
}: {
  state: AppState
  assistant: Assistant
  onState(s: AppState): void
  open: boolean
  onClose(): void
}): JSX.Element | null {
  const [preview, setPreview] = useState(state.computerPreview)
  const [vm, setVm] = useState<LocalVmStatus | null>(state.localVm || null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const mode: ComputerTargetMode = assistant.computerMode || 'this'
  const enabled = assistant.computerEnabled !== false && mode !== 'off'

  useEffect(() => {
    setPreview(state.computerPreview)
  }, [state.computerPreview])
  useEffect(() => {
    setVm(state.localVm || null)
  }, [state.localVm])

  useEffect(() => {
    if (!open) return
    void window.api.localVmStatus().then(setVm).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    if (mode !== 'virtual' && !enabled) return
    let stop = false
    const tick = async (): Promise<void> => {
      try {
        const r = await window.api.captureComputerPreview()
        if (!stop && r) setPreview({ ...r, machineId: state.settings.activeMachineId || 'local' })
      } catch {
        /* ignore */
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 2500)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [open, enabled, mode, assistant.id, state.settings.activeMachineId])

  if (!open) return null

  const setMode = async (m: ComputerTargetMode): Promise<void> => {
    onState(await window.api.updateAssistant(assistant.id, { computerMode: m, computerEnabled: m !== 'off' ? assistant.computerEnabled !== false : false }))
    if (m === 'this') onState(await window.api.setActiveMachine('local'))
    if (m === 'virtual') onState(await window.api.vmSetActive(assistant.vmOs || state.settings.vmLastOs || 'linux', assistant.id))
    if (m === 'remote' && assistant.remoteMachineId) onState(await window.api.setActiveMachine(assistant.remoteMachineId))
  }

  const oneClick = async (forceRebuild = false): Promise<void> => {
    setBusy(true)
    setHint('')
    try {
      await setMode('virtual')
      const s = forceRebuild
        ? await window.api.localVmRebuild(assistant.id)
        : await window.api.localVmStart(assistant.id)
      setVm(s)
      onState(await window.api.getState())
    } catch (e: any) {
      setVm((v) => ({
        ...(v || ({} as LocalVmStatus)),
        phase: 'error',
        message: String(e?.message || e),
        error: String(e?.message || e),
        dockerInstalled: false,
        dockerRunning: false,
        imageReady: false,
        containerRunning: false,
        desktopUrl: null,
        workDirMounted: null,
        platform: '',
        installGuide: ''
      }))
    } finally {
      setBusy(false)
    }
  }

  const startDockerDesktop = async (): Promise<void> => {
    setBusy(true)
    setHint('正在启动 Docker Desktop…')
    try {
      const s = await window.api.localVmTryStartDocker()
      setVm(s)
      onState(await window.api.getState())
      setHint(s.dockerRunning ? 'Docker 已就绪' : s.message)
    } catch (e: any) {
      setHint(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const activeVmOs = vmOsFromMachineId(state.settings.activeMachineId)
  const showNeedDockerActions = vm?.phase === 'need_docker' || (vm && vm.dockerInstalled && !vm.dockerRunning)

  return (
    <aside className="computer-panel" data-testid="computer-panel">
      <div className="side-panel-head">
        <strong>
          <Icon name="computer-line" /> 电脑
        </strong>
        <button className="btn sm" onClick={onClose}>
          <Icon name="close-line" />
        </button>
      </div>
      <div className="side-panel-body">
        <div className="segmented" data-testid="computer-target">
          {(
            [
              ['this', '本机'],
              ['virtual', '虚拟电脑'],
              ['remote', '远程'],
              ['off', '关闭']
            ] as [ComputerTargetMode, string][]
          ).map(([k, l]) => (
            <button key={k} className={mode === k ? 'active' : ''} data-testid={`computer-target-${k}`} onClick={() => void setMode(k)}>
              {l}
            </button>
          ))}
        </div>

        {mode === 'virtual' && (
          <div className="vm-wizard" data-testid="local-vm-wizard" style={{ marginTop: 12 }}>
            <VmPicker state={state} assistant={assistant} onState={onState} onHint={setHint} />
          </div>
        )}

        {mode === 'remote' && (
          <label className="small" style={{ display: 'block', marginTop: 8 }}>
            远程机器
            <select
              className="input"
              value={assistant.remoteMachineId || ''}
              onChange={async (e) => {
                onState(await window.api.updateAssistant(assistant.id, { remoteMachineId: e.target.value || undefined }))
                if (e.target.value) onState(await window.api.setActiveMachine(e.target.value))
              }}
            >
              <option value="">选择…</option>
              {(state.machines || [])
                .filter((m) => m.kind === 'remote')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.status})
                  </option>
                ))}
            </select>
          </label>
        )}

        <label className="row" style={{ marginTop: 12 }} data-testid="computer-enable-row">
          <input
            type="checkbox"
            data-testid="computer-enable"
            checked={enabled}
            disabled={mode === 'off'}
            onChange={async (e) => onState(await window.api.updateAssistant(assistant.id, { computerEnabled: e.target.checked }))}
          />
          <span>
            <strong>启用控制</strong>
            <div className="muted small">预览屏幕不代表已授权控制；勾选后模型才可键鼠操作。</div>
          </span>
        </label>

        <div className="computer-preview" data-testid="computer-preview">
          {preview?.thumb && !(activeVmOs && activeVmOs !== 'linux') ? (
            <img src={preview.thumb} alt="屏幕预览" />
          ) : (
            <div className="preview-empty muted">
              <Icon name="screenshot-2-line" size={28} />
              <div>
                {activeVmOs && activeVmOs !== 'linux'
                  ? `${VM_PROFILES[activeVmOs].title}：请在上方点「打开桌面」查看（暂无自动截图）`
                  : mode === 'virtual' && vm?.phase !== 'ready'
                    ? '启动虚拟电脑后显示实时预览'
                    : enabled
                      ? '等待截图…'
                      : '控制未启用 — 可先预览或开启控制'}
              </div>
            </div>
          )}
          {preview && <div className="preview-meta muted small">更新于 {new Date(preview.at).toLocaleTimeString('zh-CN', { hour12: false })}</div>}
        </div>

        {mode !== 'virtual' && (
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn sm"
              data-testid="open-desktop-local"
              onClick={async () => {
                // 若本地 VM 已就绪，仍可打开 noVNC；否则提示使用系统桌面
                if (vm?.phase === 'ready' && vm.desktopUrl) {
                  const r = await window.api.localVmOpenDesktop()
                  setHint(r.message)
                } else {
                  setHint('当前为「本机」模式：请直接使用系统桌面。切换到「虚拟电脑」并启动后，可在此打开 noVNC 远程桌面。')
                }
              }}
            >
              <Icon name="window-line" /> 打开桌面
            </button>
            <button
              className="btn sm"
              data-testid="sleep-local"
              onClick={async () => {
                if (vm?.phase === 'ready' || vm?.containerRunning) {
                  setVm(await window.api.localVmStop())
                  onState(await window.api.getState())
                  setHint('虚拟电脑容器已休眠。本机休眠请在系统电源菜单操作。')
                } else {
                  setHint('本机休眠请使用系统电源菜单（开始菜单 → 电源 → 睡眠）。此处不会模拟系统休眠。')
                }
              }}
            >
              <Icon name="moon-line" /> 休眠
            </button>
          </div>
        )}
        {mode !== 'virtual' && hint && (
          <div className="muted small" data-testid="computer-hint" style={{ marginTop: 8 }}>
            {hint}
          </div>
        )}

        {state.runtime?.computerActive && (
          <div className="computer-banner compact" style={{ marginTop: 12 }}>
            <Icon name="computer-line" /> 正在控制 · Ctrl+Alt+Esc 急停
            <button className="btn sm danger" onClick={() => void window.api.emergencyStop()}>
              停止
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

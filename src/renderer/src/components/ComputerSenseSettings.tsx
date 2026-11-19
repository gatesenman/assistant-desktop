import { useEffect, useState } from 'react'
import type { AppState, ComputerSenseStatus } from '../../../shared/types'
import Icon from './Icon'

/** 编号标注（Set-of-Mark）与无障碍控件树设置 */
export default function ComputerSenseSettings({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const s = state.settings
  const [status, setStatus] = useState<ComputerSenseStatus | null>(null)
  const [preview, setPreview] = useState<{ ok: boolean; message: string; image?: string; list?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showList, setShowList] = useState(false)
  const refresh = (): void => void window.api.computerSenseStatus().then(setStatus).catch(() => setStatus(null))
  useEffect(refresh, [s.activeMachineId])
  const toggle = async (patch: Parameters<typeof window.api.saveSettings>[0]): Promise<void> => onState(await window.api.saveSettings(patch))
  return (
    <div className="sense-box" data-testid="som-section">
      <h4>
        <Icon name="list-ordered" /> 屏幕元素编号（Set-of-Mark）
      </h4>
      <p className="muted small">
        每次截图时读取系统无障碍控件树（Windows UI Automation / Linux AT-SPI），再结合 OCR 和矩形检测，把可点击的元素编上号：视觉模型看到带编号框的截图，纯文本模型（DeepSeek）收到「编号 · 类型 · 名称 · 位置」列表，然后用 click_element(编号) 精确点击，比猜坐标可靠得多。
      </p>
      <label className="row">
        <input type="checkbox" data-testid="som-enabled" checked={s.somEnabled !== false} onChange={(e) => void toggle({ somEnabled: e.target.checked })} />
        启用编号标注
      </label>
      <label>
        读取范围
        <div className="segmented" data-testid="som-scope">
          {(
            [
              ['foreground', '前台窗口（更快）'],
              ['desktop', '前台窗口 + 任务栏']
            ] as ['foreground' | 'desktop', string][]
          ).map(([k, l]) => (
            <button key={k} className={(s.somScope || 'foreground') === k ? 'active' : ''} onClick={() => void toggle({ somScope: k })}>
              {l}
            </button>
          ))}
        </div>
      </label>
      {status && (
        <div className={'sense-status ' + (status.available ? 'ok' : 'warn')} data-testid="sense-status" data-engine={status.engine}>
          <Icon name={status.available ? 'checkbox-circle-line' : 'information-line'} /> {status.detail}
        </div>
      )}
      {vmLinux(s.activeMachineId) && (
        <label>
          Linux 虚拟电脑控制通道
          <div className="segmented" data-testid="linux-vm-control">
            {(
              [
                ['docker', 'docker exec + xdotool（默认）'],
                ['vnc', 'VNC（与 Windows / macOS 相同的通道）']
              ] as ['docker' | 'vnc', string][]
            ).map(([k, l]) => (
              <button key={k} className={(s.linuxVmControl || 'docker') === k ? 'active' : ''} data-testid={`linux-vm-control-${k}`} onClick={() => void toggle({ linuxVmControl: k })}>
                {l}
              </button>
            ))}
          </div>
        </label>
      )}
      <div className="form-actions">
        <button className="btn ghost" onClick={refresh}>
          <Icon name="refresh-line" /> 刷新状态
        </button>
        <button
          className="btn"
          data-testid="som-preview"
          disabled={busy || s.somEnabled === false}
          onClick={async () => {
            setBusy(true)
            setPreview(null)
            try {
              setPreview(await window.api.previewMarks())
            } catch (e: any) {
              setPreview({ ok: false, message: String(e?.message || e) })
            }
            setBusy(false)
            refresh()
          }}
        >
          {busy ? '识别中…' : '预览当前屏幕编号'}
        </button>
      </div>
      {preview && (
        <div className="som-preview" data-testid="som-preview-result">
          <div className={preview.ok ? 'ok-text' : 'err-text'}>{preview.message}</div>
          {preview.image && <img src={preview.image} alt="编号预览" data-testid="som-preview-img" />}
          {preview.list && (
            <>
              <button className="link-btn small" onClick={() => setShowList(!showList)}>
                {showList ? '收起' : '展开'}模型收到的元素列表
              </button>
              {showList && <pre className="tool-output som-list" data-testid="som-preview-list">{preview.list}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function vmLinux(id: string): boolean {
  return id === 'vm-local' || id === 'virtual'
}

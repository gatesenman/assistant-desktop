import { useMemo, useState } from 'react'
import type { AppState, ProviderPreset } from '../../../shared/types'
import { PROVIDER_PRESETS } from '../../../shared/providers'
import Icon from './Icon'

const EXTRA: { id: string; models: string[] }[] = [
  { id: 'deepseek', models: ['deepseek-chat', 'deepseek-v4-pro', 'deepseek-flash'] },
  { id: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'] },
  { id: 'xai', models: ['grok-4', 'grok-3'] },
  { id: 'qwen', models: ['qwen-vl-max', 'qwen-plus', 'qwen-turbo'] },
  { id: 'moonshot', models: ['moonshot-v1-8k-vision-preview', 'moonshot-v1-128k'] },
  { id: 'zhipu', models: ['glm-4v-plus', 'glm-4'] },
  { id: 'ollama', models: ['qwen2.5vl', 'llama3.1', 'mistral'] },
  { id: 'custom', models: [] }
]

export default function ModelPicker({
  state,
  assistantId,
  open,
  onClose,
  onState
}: {
  state: AppState
  assistantId: string
  open: boolean
  onClose(): void
  onState(s: AppState): void
}): JSX.Element | null {
  const [prov, setProv] = useState(() => PROVIDER_PRESETS.find((p) => p.baseUrl === state.settings.baseUrl)?.id || 'deepseek')
  const pack = PROVIDER_PRESETS.find((p) => p.id === prov) as ProviderPreset | undefined
  const models = useMemo(() => {
    const list = EXTRA.find((e) => e.id === prov)?.models || []
    if (pack?.model && !list.includes(pack.model)) return [pack.model, ...list]
    return list.length ? list : [state.settings.model]
  }, [prov, pack, state.settings.model])

  if (!open) return null
  const keyOk = !!state.settings.apiKeySet || /localhost|127\.0\.0\.1/.test(pack?.baseUrl || state.settings.baseUrl) || !!pack?.noKey
  const reason = !keyOk ? (pack?.needsProxy ? '需要 API Key，且中国大陆通常还需代理' : '需要先配置 API Key') : pack?.needsProxy && state.settings.proxyMode === 'direct' ? '该服务商通常需要代理' : ''

  return (
    <div className="modal-backdrop" data-testid="model-picker" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="page-head">
          <h3>
            <Icon name="cpu-line" /> 选择模型
          </h3>
          <button className="btn sm" onClick={onClose}>
            <Icon name="close-line" />
          </button>
        </div>
        <div className="model-picker-grid">
          <div className="provider-rail" data-testid="provider-rail">
            {PROVIDER_PRESETS.filter((p) => p.id !== 'custom').map((p) => (
              <button key={p.id} className={'chip' + (prov === p.id ? ' active' : '')} data-testid={`provider-${p.id}`} onClick={() => setProv(p.id)}>
                {p.name}
              </button>
            ))}
            <button className={'chip' + (prov === 'custom' ? ' active' : '')} onClick={() => setProv('custom')}>
              自定义
            </button>
          </div>
          <div className="model-list">
            {reason && (
              <div className="msg-error" data-testid="model-unavailable-reason">
                <Icon name="error-warning-line" /> {reason}
              </div>
            )}
            {models.map((m) => (
              <button
                key={m}
                className={'model-row' + ((state.assistants.find((a) => a.id === assistantId)?.model || state.settings.model) === m ? ' active' : '')}
                data-testid={`model-${m}`}
                disabled={!!reason && !keyOk}
                onClick={async () => {
                  if (pack?.baseUrl) await window.api.saveSettings({ baseUrl: pack.baseUrl, model: m })
                  else await window.api.saveSettings({ model: m })
                  onState(await window.api.updateAssistant(assistantId, { model: m }))
                  onClose()
                }}
              >
                <Icon name="sparkling-2-line" /> {m}
                {!keyOk && <span className="muted small">不可用</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

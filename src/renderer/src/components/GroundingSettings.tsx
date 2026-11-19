import { useEffect, useState } from 'react'
import type { AppState, GroundingPresetId, GroundingSettings as G } from '../../../shared/types'
import Icon from './Icon'

/** 与主进程 grounding.ts 的预设保持一致（界面用） */
const PRESETS: { id: GroundingPresetId; name: string; desc: string; baseUrl: string; model: string; coordSpace: G['coordSpace']; promptStyle: G['promptStyle']; needKey: boolean }[] = [
  { id: 'main', name: '使用主模型', desc: '直接让当前对话模型在截图上找坐标（需要视觉模型；DeepSeek 等纯文本模型不可用）。', baseUrl: '', model: '', coordSpace: 'pixel', promptStyle: 'json', needKey: false },
  {
    id: 'uitars15-vllm',
    name: 'UI-TARS-1.5（本地 vLLM）',
    desc: '字节开源 UI-TARS-1.5-7B，专门做界面定位。用 vLLM 部署：vllm serve ByteDance-Seed/UI-TARS-1.5-7B --limit-mm-per-prompt image=5。坐标为 smart_resize 后的绝对像素，应用会自动换算。',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'ByteDance-Seed/UI-TARS-1.5-7B',
    coordSpace: 'smart_resize',
    promptStyle: 'uitars',
    needKey: false
  },
  {
    id: 'uitars15-openrouter',
    name: 'UI-TARS-1.5（OpenRouter）',
    desc: '无需本地显卡，通过 OpenRouter 调用 bytedance/ui-tars-1.5-7b（需要 OpenRouter API Key，按量计费）。',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'bytedance/ui-tars-1.5-7b',
    coordSpace: 'smart_resize',
    promptStyle: 'uitars',
    needKey: true
  },
  { id: 'uitars-v1', name: 'UI-TARS（v1，0–1000 相对坐标）', desc: '旧版 UI-TARS-7B/72B（Qwen2-VL 底座），输出 0–1000 的相对坐标。', baseUrl: 'http://127.0.0.1:8000/v1', model: 'bytedance-research/UI-TARS-7B-DPO', coordSpace: 'relative1000', promptStyle: 'uitars', needKey: false },
  {
    id: 'fara7b',
    name: 'Fara-7B（微软）',
    desc: '微软开源的电脑操作小模型（Qwen2.5-VL 底座）。可用 vLLM / Azure Foundry 部署，输出 computer_use 工具调用，应用只取其中的点击坐标。',
    baseUrl: 'http://127.0.0.1:5000/v1',
    model: 'microsoft/Fara-7B',
    coordSpace: 'smart_resize',
    promptStyle: 'fara',
    needKey: false
  },
  { id: 'custom', name: '自定义', desc: '任意 OpenAI 兼容的视觉模型，自选坐标格式。', baseUrl: '', model: '', coordSpace: 'pixel', promptStyle: 'json', needKey: false }
]

type TestRes = Awaited<ReturnType<typeof window.api.testGrounding>>

export default function GroundingSettings({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const g = state.settings.grounding
  const [draft, setDraft] = useState<G>(g)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<TestRes | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => setDraft(state.settings.grounding), [state.settings.grounding])
  const preset = PRESETS.find((p) => p.id === draft.preset) || PRESETS[0]
  const dirty = JSON.stringify(draft) !== JSON.stringify(g) || apiKey !== ''
  const pick = (id: GroundingPresetId): void => {
    const p = PRESETS.find((x) => x.id === id)!
    setDraft({ ...draft, preset: id, baseUrl: p.baseUrl || (id === 'custom' ? draft.baseUrl : ''), model: p.model || (id === 'custom' ? draft.model : ''), coordSpace: p.coordSpace, promptStyle: p.promptStyle })
    setRes(null)
  }
  const save = async (): Promise<void> => {
    onState(await window.api.saveGrounding({ ...draft, ...(apiKey ? { apiKey } : {}) }))
    setApiKey('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  const mainVisionNo = state.settings.capabilities?.[`${state.settings.baseUrl.replace(/\/+$/, '')}|${state.settings.model}`]?.vision === 'no'
  return (
    <section className="card form" id="gs-grounding" data-testid="grounding-section">
      <h3>
        <Icon name="focus-3-line" /> 定位模型（Grounding）
      </h3>
      <p className="muted small">
        规划和定位分开：主模型（如 DeepSeek）负责想下一步做什么，定位模型负责在截图上找到「设置按钮」「右上角的齿轮」这类目标的精确坐标。配置后智能体可使用 click_target 工具；未配置时 click_target 会按编号元素的名称匹配。
      </p>
      <label className="row">
        <input type="checkbox" data-testid="grounding-enabled" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        启用定位模型
      </label>
      <div className="chips" data-testid="grounding-presets">
        {PRESETS.map((p) => (
          <button key={p.id} className={'chip' + (draft.preset === p.id ? ' active' : '')} data-testid={`grounding-preset-${p.id}`} onClick={() => pick(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="muted small preset-desc">{preset.desc}</div>
      {draft.preset === 'main' && mainVisionNo && <div className="warn-text small">当前主模型检测为不支持图片，不能用作定位模型。请选择 UI-TARS / Fara 等专用模型。</div>}
      {draft.preset !== 'main' && (
        <>
          <label>
            Base URL
            <input className="input mono" data-testid="grounding-baseurl" value={draft.baseUrl} placeholder={preset.baseUrl || 'http://127.0.0.1:8000/v1'} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          </label>
          <label>
            模型名称
            <input className="input mono" data-testid="grounding-model" value={draft.model} placeholder={preset.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </label>
          <label>
            API Key{preset.needKey ? '' : '（本地部署可留空）'}
            <input
              className="input mono"
              type="password"
              data-testid="grounding-key"
              value={apiKey}
              placeholder={state.settings.groundingApiKeySet ? '•••••••• 已保存（输入新值以替换）' : preset.needKey ? 'sk-or-...' : '可留空'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <div className="grid2">
            <label>
              坐标格式
              <select className="input" data-testid="grounding-coord" value={draft.coordSpace} onChange={(e) => setDraft({ ...draft, coordSpace: e.target.value as G['coordSpace'] })}>
                <option value="smart_resize">smart_resize 绝对像素（UI-TARS-1.5 / Fara-7B）</option>
                <option value="relative1000">0–1000 相对坐标（UI-TARS v1）</option>
                <option value="pixel">截图像素</option>
              </select>
            </label>
            <label>
              提示词格式
              <select className="input" value={draft.promptStyle} onChange={(e) => setDraft({ ...draft, promptStyle: e.target.value as G['promptStyle'] })}>
                <option value="uitars">UI-TARS 官方 grounding 模板</option>
                <option value="fara">Fara computer_use 工具调用</option>
                <option value="json">通用 JSON（{'{"x":..,"y":..}'}）</option>
              </select>
            </label>
          </div>
        </>
      )}
      <div className="form-actions">
        {saved && (
          <span className="ok-text">
            <Icon name="check-line" /> 已保存
          </span>
        )}
        <button
          className="btn"
          data-testid="grounding-test"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setRes(null)
            try {
              setRes(await window.api.testGrounding({ ...draft, ...(apiKey ? { apiKey } : {}) }))
            } catch (e: any) {
              setRes({ ok: false, message: String(e?.message || e) })
            }
            setBusy(false)
          }}
        >
          {busy ? '测试中…' : '测试定位'}
        </button>
        <button className="btn primary" data-testid="grounding-save" disabled={!dirty} onClick={() => void save()}>
          保存
        </button>
      </div>
      {res && (
        <div className={'grounding-result ' + (res.ok ? 'ok' : 'fail')} data-testid="grounding-result" data-ok={res.ok ? '1' : '0'}>
          <div className={res.ok ? 'ok-text' : 'err-text'}>
            <Icon name={res.ok ? 'checkbox-circle-fill' : 'error-warning-fill'} /> {res.message}
          </div>
          {res.image && <img src={res.image} alt="定位测试结果" className="grounding-img" />}
          <div className="muted small">测试图是一张随机摆放的合成界面，要求模型找到「红色的确认按钮」；绿色十字 = 点中，橙色 = 偏离。</div>
        </div>
      )}
    </section>
  )
}

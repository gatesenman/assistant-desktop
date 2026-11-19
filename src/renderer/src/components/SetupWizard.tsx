import { useEffect, useState } from 'react'
import type { AppState, ConnectionTestResult, ProviderPreset, ProxyMode } from '../../../shared/types'
import { PROVIDER_PRESETS } from '../../../shared/providers'
import Icon from './Icon'

const capText = (v: string): string => (v === 'yes' ? '支持' : v === 'no' ? '不支持' : '未确定')
const capIcon = (v: string): string => (v === 'yes' ? 'checkbox-circle-fill' : v === 'no' ? 'close-circle-fill' : 'question-line')

/** 首次启动向导：必须连接并测试通过一个模型后才能进入应用 */
export default function SetupWizard({ state, onState }: { state: AppState; onState(s: AppState): void }): JSX.Element {
  const s = state.settings
  const [presetId, setPresetId] = useState<string>(() => PROVIDER_PRESETS.find((p) => p.baseUrl === s.baseUrl)?.id || (s.apiKeySet ? 'custom' : 'deepseek'))
  const preset: ProviderPreset = PROVIDER_PRESETS.find((p) => p.id === presetId) || PROVIDER_PRESETS[0]
  const [baseUrl, setBaseUrl] = useState(s.apiKeySet ? s.baseUrl : preset.baseUrl)
  const [model, setModel] = useState(s.apiKeySet ? s.model : preset.model)
  const [apiKey, setApiKey] = useState('')
  const [envHint, setEnvHint] = useState<string>('')
  const [proxyMode, setProxyMode] = useState<ProxyMode>(s.proxyMode)
  const [proxyUrl, setProxyUrl] = useState(s.proxyUrl)
  const [showProxy, setShowProxy] = useState(s.proxyMode === 'custom')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ConnectionTestResult | null>(null)

  useEffect(() => {
    void window.api.getSetupDefaults().then((d) => {
      if (d.env.length && !s.apiKeySet) {
        const first = PROVIDER_PRESETS.find((p) => p.id === d.env[0].id)
        if (first) {
          setPresetId(first.id)
          setBaseUrl(first.baseUrl)
          setModel(first.model)
          setEnvHint(`检测到环境变量 ${d.env.map((e) => e.envKey).join('、')}，已自动选择 ${first.name}；密钥可留空使用环境变量。`)
        }
      }
    })
  }, [])

  const choose = (p: ProviderPreset): void => {
    setPresetId(p.id)
    setResult(null)
    if (p.id !== 'custom') {
      setBaseUrl(p.baseUrl)
      setModel(p.model)
    }
    if (p.needsProxy && proxyMode !== 'custom') setShowProxy(true)
  }

  const run = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      if (proxyMode !== s.proxyMode || proxyUrl !== s.proxyUrl) onState(await window.api.saveSettings({ proxyMode, proxyUrl: proxyUrl.trim() }))
      const r = await window.api.testModel({ baseUrl, apiKey: apiKey.trim(), model, useSavedKey: !apiKey.trim() && s.apiKeySet })
      setResult(r)
    } catch (e: any) {
      setResult({ ok: false, message: String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setTesting(false)
    }
  }

  const finish = async (): Promise<void> => {
    const caps = result?.capabilities
    onState(
      await window.api.saveSettings({
        baseUrl: baseUrl.trim().replace(/\/+$/, ''),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        // 纯文本模型自动关闭图片发送，避免普通对话报错
        vision: caps ? caps.vision !== 'no' : s.vision,
        setupDone: true
      })
    )
  }

  const needKey = !preset.noKey && !/localhost|127\.0\.0\.1/.test(baseUrl)
  const canTest = !!baseUrl.trim() && !!model.trim() && (!needKey || !!apiKey.trim() || s.apiKeySet || !!envHint)
  const caps = result?.capabilities

  return (
    <div className="setup-wizard" data-testid="setup-wizard">
      <div className="sw-card">
        <div className="sw-head">
          <div className="sw-logo">
            <Icon name="sparkling-2-line" size={26} />
          </div>
          <div>
            <h2>欢迎使用助手桌面版</h2>
            <p className="muted">第一步：连接一个大模型。只需要一个 API Key，测试通过后即可开始使用。</p>
          </div>
        </div>

        <div className="sw-label">选择服务商</div>
        <div className="sw-providers">
          {PROVIDER_PRESETS.map((p) => (
            <button key={p.id} className={'sw-provider' + (p.id === presetId ? ' active' : '')} data-testid={`provider-${p.id}`} onClick={() => choose(p)}>
              <span>{p.name}</span>
              {p.needsProxy && <span className="sw-tag">需代理</span>}
              {p.noKey && <span className="sw-tag ok">免密钥</span>}
            </button>
          ))}
        </div>
        {envHint && <div className="sw-hint ok"><Icon name="information-line" /> {envHint}</div>}

        <div className="sw-grid">
          <label>
            API Key
            <input
              className="input mono"
              data-testid="setup-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setResult(null)
              }}
              placeholder={s.apiKeySet ? '已保存（留空沿用）' : preset.noKey ? '本地模型无需填写' : 'sk-...'}
              onKeyDown={(e) => e.key === 'Enter' && canTest && !testing && void run()}
            />
            {preset.keyUrl && (
              <a className="small link" onClick={() => void window.api.openExternal(preset.keyUrl!)}>
                <Icon name="external-link-line" /> 获取 {preset.name} 的 API Key
              </a>
            )}
          </label>
          <label>
            模型
            <input className="input mono" data-testid="setup-model" value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label className="full">
            Base URL
            <input className="input mono" data-testid="setup-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://.../v1" />
          </label>
        </div>

        <button className="sw-toggle" onClick={() => setShowProxy(!showProxy)} data-testid="setup-proxy-toggle">
          <Icon name={showProxy ? 'arrow-down-s-line' : 'arrow-right-s-line'} /> 网络代理{proxyMode === 'custom' && proxyUrl ? `：${proxyUrl}` : '（访问海外服务时需要）'}
        </button>
        {showProxy && (
          <div className="sw-proxy">
            <div className="segmented">
              {(
                [
                  ['system', '跟随系统'],
                  ['direct', '直连'],
                  ['custom', '自定义']
                ] as [ProxyMode, string][]
              ).map(([k, l]) => (
                <button key={k} className={proxyMode === k ? 'active' : ''} onClick={() => setProxyMode(k)} data-testid={`setup-proxy-${k}`}>
                  {l}
                </button>
              ))}
            </div>
            {proxyMode === 'custom' && (
              <input className="input mono" data-testid="setup-proxy-url" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" />
            )}
          </div>
        )}

        {result && (
          <div className={'sw-result ' + (result.ok ? 'ok' : 'err')} data-testid="setup-result" data-ok={result.ok ? '1' : '0'} data-kind={result.errorKind || ''}>
            <Icon name={result.ok ? 'checkbox-circle-fill' : 'error-warning-fill'} size={18} />
            <div>
              <div>{result.message}</div>
              {caps && (
                <div className="sw-caps" data-testid="setup-caps">
                  <span data-cap="tools" data-value={caps.tools}>
                    <Icon name={capIcon(caps.tools)} /> 工具调用：{capText(caps.tools)}
                  </span>
                  <span data-cap="vision" data-value={caps.vision}>
                    <Icon name={capIcon(caps.vision)} /> 图片 / 电脑控制：{capText(caps.vision)}
                  </span>
                </div>
              )}
              {caps?.vision === 'no' && <div className="small muted">该模型不能看图：对话、文件、命令和网页工具可正常使用；电脑控制将自动改用 OCR 文字描述模式。</div>}
              {caps?.tools === 'no' && <div className="small muted">该模型不支持工具调用：只能聊天，无法执行命令、浏览网页或控制电脑。</div>}
            </div>
          </div>
        )}

        <div className="sw-actions">
          {result?.ok ? (
            <button className="btn primary lg" data-testid="setup-finish" onClick={() => void finish()}>
              开始使用 <Icon name="arrow-right-line" />
            </button>
          ) : (
            <button className="btn primary lg" data-testid="setup-test" disabled={!canTest || testing} onClick={() => void run()}>
              {testing ? (
                <>
                  <Icon name="loader-4-line" className="spin" /> 正在连接并检测能力…
                </>
              ) : result ? (
                <>
                  <Icon name="refresh-line" /> 重试
                </>
              ) : (
                <>
                  <Icon name="plug-line" /> 连接并测试
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

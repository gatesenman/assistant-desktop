import { useState } from 'react'
import { APPROVABLE_TOOLS, type AppState, type TestResult, type ThemeMode } from '../../../shared/types'
import McpSettings from './McpSettings'
import GroundingSettings from './GroundingSettings'
import ComputerSenseSettings from './ComputerSenseSettings'
import Icon from './Icon'
import { PROVIDER_PRESETS } from '../../../shared/providers'
import type { ConnectionTestResult, ProxyMode, UpdateInfo } from '../../../shared/types'
import { useEffect } from 'react'

const PROVIDERS = PROVIDER_PRESETS.filter((p) => p.id !== 'custom')
const ACCENTS = ['#7c83ff', '#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6']
const TOOL_INFO: Record<string, [string, string]> = {
  run_shell: ['执行命令 run_shell', '在本机执行任意 shell 命令（高风险）'],
  read_file: ['读取文件 read_file', '读取本机文本文件'],
  write_file: ['写入文件 write_file', '创建或覆盖本机文件（高风险）'],
  list_dir: ['浏览目录 list_dir', '列出目录内容'],
  web_fetch: ['抓取网页 web_fetch', '访问互联网 URL'],
  browser_open: ['浏览器打开网页 browser_open', '在自动化浏览器中打开网址'],
  browser_get_text: ['浏览器读取文本 browser_get_text', '读取页面文字'],
  browser_screenshot: ['浏览器截图 browser_screenshot', '截取页面图片'],
  browser_click: ['浏览器点击 browser_click', '可能提交表单或触发操作（有风险）'],
  browser_type: ['浏览器输入 browser_type', '在网页中输入/提交内容（有风险）'],
  browser_state: ['浏览器状态 browser_state', '列出可交互元素编号与无障碍信息'],
  browser_click_index: ['按编号点击 browser_click_index', '点击 browser_state 返回的编号元素'],
  browser_type_index: ['按编号输入 browser_type_index', '在编号元素中输入文字'],
  browser_extract: ['结构化提取 browser_extract', '按 schema 从页面提取数据'],
  ask_user: ['询问用户 ask_user', '弹出审批卡片等待用户文字回答（通常无需自动批准）']
}

export default function GlobalSettings({ state, onState, onClose }: { state: AppState; onState(s: AppState): void; onClose(): void }): JSX.Element {
  const s = state.settings
  const [baseUrl, setBaseUrl] = useState(s.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(s.model)
  const [temperature, setTemperature] = useState(s.temperature)
  const [workDir, setWorkDir] = useState(s.workDir)
  const [maxSteps, setMaxSteps] = useState(s.maxToolSteps)
  const [ctxTokens, setCtxTokens] = useState(s.contextTokens)
  const [browserPath, setBrowserPath] = useState(s.browserExecutablePath)
  const [cdpUrl, setCdpUrl] = useState(s.browserCdpUrl || '')
  const [profileDir, setProfileDir] = useState(s.browserProfileDir || '')
  const [compSteps, setCompSteps] = useState(s.computerMaxSteps)
  const [sttModel, setSttModel] = useState(s.transcriptionModel)
  const [maxAgents, setMaxAgents] = useState(s.maxConcurrentAgents)
  const [showKey, setShowKey] = useState(false)
  const [test, setTest] = useState<ConnectionTestResult | null>(null)
  const [proxyMode, setProxyMode] = useState<ProxyMode>(s.proxyMode)
  const [proxyUrl, setProxyUrl] = useState(s.proxyUrl)
  const [proxyRes, setProxyRes] = useState<TestResult | null>(null)
  const [proxyBusy, setProxyBusy] = useState(false)
  const [updateUrl, setUpdateUrl] = useState(s.updateUrl)
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const [exp, setExp] = useState<{ ok: boolean; message: string } | null>(null)
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.api.getVersion().then(setVersion)
  }, [])
  const caps = s.capabilities?.[`${s.baseUrl.replace(/\/+$/, '')}|${s.model}`]
  const capLabel = (v?: string): string => (v === 'yes' ? '支持' : v === 'no' ? '不支持' : '未检测')
  const errMsg = (e: any): string => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  const [testing, setTesting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [install, setInstall] = useState<TestResult | null>(null)
  const [installing, setInstalling] = useState(false)

  const dirty =
    baseUrl !== s.baseUrl ||
    apiKey !== '' ||
    model !== s.model ||
    temperature !== s.temperature ||
    workDir !== s.workDir ||
    maxSteps !== s.maxToolSteps ||
    ctxTokens !== s.contextTokens ||
    browserPath !== s.browserExecutablePath ||
    cdpUrl !== (s.browserCdpUrl || '') ||
    profileDir !== (s.browserProfileDir || '') ||
    compSteps !== s.computerMaxSteps ||
    sttModel !== s.transcriptionModel ||
    maxAgents !== s.maxConcurrentAgents

  const save = async (): Promise<AppState> => {
    const st = await window.api.saveSettings({
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      model: model.trim(),
      temperature,
      workDir: workDir.trim(),
      maxToolSteps: Math.max(1, Math.min(50, maxSteps || 12)),
      contextTokens: Math.max(2000, Math.min(1000000, ctxTokens || 24000)),
      browserExecutablePath: browserPath.trim(),
      browserCdpUrl: cdpUrl.trim(),
      browserProfileDir: profileDir.trim(),
      computerMaxSteps: Math.max(5, Math.min(500, compSteps || 40)),
      transcriptionModel: sttModel.trim() || 'whisper-1',
      maxConcurrentAgents: Math.max(1, Math.min(32, maxAgents || 10))
    })
    onState(st)
    setApiKey('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    return st
  }
  const toggle = async (patch: Parameters<typeof window.api.saveSettings>[0]): Promise<void> => onState(await window.api.saveSettings(patch))

  return (
    <div className="page" data-testid="global-settings">
      <div className="page-inner">
        <div className="page-head">
          <h2>全局设置</h2>
          <button className="btn" data-testid="global-settings-back" onClick={onClose}>
            返回
          </button>
        </div>
        <nav className="settings-nav" data-testid="settings-nav">
          {(
            [
              ['gs-model', '模型接口'],
              ['gs-proxy', '网络代理'],
              ['gs-computer', '电脑控制'],
              ['gs-grounding', '定位模型'],
              ['gs-agents', '多智能体'],
              ['gs-background', '后台运行'],
              ['gs-browser', '浏览器'],
              ['gs-tools', '工具与审批'],
              ['gs-about', '关于与诊断']
            ] as [string, string][]
          ).map(([id, label]) => (
            <button key={id} className="chip" data-testid={`nav-${id}`} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              {label}
            </button>
          ))}
        </nav>

        <section className="card form" id="gs-model">
          <h3>模型接口（OpenAI 兼容）</h3>
          <div className="chips">
            {PROVIDERS.map((p) => (
              <button
                key={p.name}
                className={'chip' + (baseUrl === p.baseUrl ? ' active' : '')}
                onClick={() => {
                  setBaseUrl(p.baseUrl)
                  setModel(p.model)
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          <label>
            Base URL
            <input className="input mono" data-testid="base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            API Key
            <div className="row">
              <input
                className="input mono"
                data-testid="api-key"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                placeholder={s.apiKeySet ? '•••••••• 已保存（输入新值以替换）' : 'sk-...'}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button className="btn sm" onClick={() => setShowKey(!showKey)}>
                {showKey ? '隐藏' : '显示'}
              </button>
              {s.apiKeySet && (
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    if (confirm('清除已保存的 API Key？')) onState(await window.api.saveSettings({ apiKey: '' }))
                  }}
                >
                  清除
                </button>
              )}
            </div>
          </label>
          <div className="muted small" data-testid="key-security">
            {state.security.encryptionAvailable
              ? `API Key 使用系统加密存储（${state.security.backend}），磁盘上不保存明文。`
              : '当前系统不支持安全加密存储，API Key 将以明文保存在本机数据目录中。'}
          </div>
          <label>
            模型名称
            <input className="input mono" data-testid="model" value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            温度 Temperature：{temperature.toFixed(1)}
            <input type="range" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} />
          </label>
          <label>
            上下文预算（估算 token 数，超出时自动丢弃最早的消息）
            <input className="input" data-testid="ctx-tokens" type="number" min={2000} step={1000} value={ctxTokens} onChange={(e) => setCtxTokens(Number(e.target.value))} />
          </label>
          <label className="row">
            <input type="checkbox" checked={s.vision} onChange={(e) => void toggle({ vision: e.target.checked })} />
            向模型发送图片 / 截图（需要视觉模型；DeepSeek 等纯文本模型请关闭）
          </label>
          <div className="form-actions">
            {test && (
              <span className={test.ok ? 'ok-text' : 'err-text'} title={test.message} data-testid="test-result">
                {test.message}
              </span>
            )}
            {saved && <span className="ok-text"><Icon name="check-line" /> 已保存</span>}
            <button
              className="btn"
              disabled={testing}
              onClick={async () => {
                setTesting(true)
                setTest(null)
                if (dirty) await save()
                setTest(await window.api.checkCapabilities(true))
                setTesting(false)
              }}
              data-testid="test-conn"
            >
              {testing ? '检测中…' : '测试连接并检测能力'}
            </button>
            <button className="btn primary" data-testid="settings-save" disabled={!dirty} onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        <div className="cap-row" data-testid="cap-row">
          <span className={'cap-pill ' + (caps?.tools || 'unknown')}>
            <Icon name="tools-line" /> 工具调用：{capLabel(caps?.tools)}
          </span>
          <span className={'cap-pill ' + (caps?.vision || 'unknown')} data-testid="cap-vision" data-value={caps?.vision || ''}>
            <Icon name="eye-line" /> 图片 / 电脑控制：{capLabel(caps?.vision)}
          </span>
          {caps && <span className="muted small">检测于 {new Date(caps.checkedAt).toLocaleString('zh-CN', { hour12: false })}</span>}
        </div>

        <section className="card form" id="gs-proxy" data-testid="proxy-section">
          <h3>
            <Icon name="route-line" /> 网络代理
          </h3>
          <div className="muted small">模型请求、网页抓取、语音转写和自动化浏览器都会使用此代理。中国大陆访问 OpenAI / xAI 等服务通常需要配置。</div>
          <div className="segmented">
            {(
              [
                ['system', '跟随系统'],
                ['direct', '直连（不使用代理）'],
                ['custom', '自定义 HTTP / SOCKS5']
              ] as [ProxyMode, string][]
            ).map(([k, l]) => (
              <button key={k} className={proxyMode === k ? 'active' : ''} data-testid={`proxy-mode-${k}`} onClick={() => setProxyMode(k)}>
                {l}
              </button>
            ))}
          </div>
          {proxyMode === 'custom' && (
            <input className="input mono" data-testid="proxy-url" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" />
          )}
          <div className="form-actions">
            {proxyRes && (
              <span className={proxyRes.ok ? 'ok-text' : 'err-text'} data-testid="proxy-result" title={proxyRes.message}>
                {proxyRes.message}
              </span>
            )}
            <button
              className="btn"
              data-testid="proxy-test"
              disabled={proxyBusy}
              onClick={async () => {
                setProxyBusy(true)
                setProxyRes(null)
                try {
                  setProxyRes(await window.api.testProxy({ proxyMode, proxyUrl }))
                } catch (e) {
                  setProxyRes({ ok: false, message: errMsg(e) })
                }
                setProxyBusy(false)
              }}
            >
              {proxyBusy ? '测试中…' : '测试代理'}
            </button>
            <button
              className="btn primary"
              data-testid="proxy-save"
              disabled={proxyMode === s.proxyMode && proxyUrl === s.proxyUrl}
              onClick={async () => {
                try {
                  onState(await window.api.saveSettings({ proxyMode, proxyUrl: proxyUrl.trim() }))
                  setProxyRes({ ok: true, message: '代理设置已保存并生效' })
                } catch (e) {
                  setProxyRes({ ok: false, message: errMsg(e) })
                }
              }}
            >
              保存
            </button>
          </div>
        </section>

        <section className="card form">
          <h3>外观</h3>
          <label>
            主题
            <div className="segmented">
              {(
                [
                  ['light', '浅色'],
                  ['dark', '深色'],
                  ['system', '跟随系统']
                ] as [ThemeMode, string][]
              ).map(([k, l]) => (
                <button key={k} className={s.theme === k ? 'active' : ''} onClick={() => void toggle({ theme: k })}>
                  {l}
                </button>
              ))}
            </div>
          </label>
          <label>
            强调色
            <div className="swatches">
              {ACCENTS.map((c) => (
                <button key={c} className={'swatch' + (s.accent === c ? ' active' : '')} style={{ background: c }} onClick={() => void toggle({ accent: c })} />
              ))}
              <input type="color" value={s.accent} onChange={(e) => void toggle({ accent: e.target.value })} />
            </div>
          </label>
        </section>

        <section className="card form" id="gs-computer" data-testid="computer-section">
          <h3>
            <Icon name="computer-line" /> 电脑控制
          </h3>
          <p className="muted small">
            允许助手截屏、移动鼠标、点击、输入文字和按快捷键来操作这台电脑。控制期间屏幕顶部会显示悬浮条，随时按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Esc</kbd> 或点「停止」即可紧急停止。
            macOS 需要在「系统设置 → 隐私与安全性」中为本应用授予「屏幕录制」和「辅助功能」权限。
          </p>
          <label className="row">
            <input type="checkbox" data-testid="computer-enabled" checked={s.computerEnabled} onChange={(e) => void toggle({ computerEnabled: e.target.checked })} />
            启用电脑控制工具
          </label>
          <label>
            屏幕感知方式
            <div className="segmented" data-testid="screen-mode">
              {(
                [
                  ['auto', '自动（按模型能力）'],
                  ['image', '截图（视觉模型）'],
                  ['text', '文字描述（OCR，纯文本模型）']
                ] as ['auto' | 'image' | 'text', string][]
              ).map(([k, l]) => (
                <button key={k} className={s.computerScreenMode === k ? 'active' : ''} data-testid={`screen-mode-${k}`} onClick={() => void toggle({ computerScreenMode: k })}>
                  {l}
                </button>
              ))}
            </div>
            <span className="muted small">不能看图的模型（如 DeepSeek）会自动改用 OCR：把屏幕上的文字及坐标发给模型，模型据此点击和输入。</span>
          </label>
          <ComputerSenseSettings state={state} onState={onState} />
          <div className={'trusted-box' + (s.trustedMode ? ' on' : '')}>
            <label className="row">
              <input type="checkbox" data-testid="trusted-mode" checked={s.trustedMode} onChange={(e) => void toggle({ trustedMode: e.target.checked })} />
              <strong>信任模式</strong>：自动批准所有电脑控制操作（无人值守 7×24 运行）
            </label>
            <p className="muted small">关闭时，除截屏和列出窗口外，每一步操作都需要你在聊天中批准。开启后助手可以完全自主地操作电脑，请只在你信任当前任务时开启。</p>
          </div>
          <label className="row">
            <input type="checkbox" checked={s.minimizeOnComputerUse} onChange={(e) => void toggle({ minimizeOnComputerUse: e.target.checked })} />
            控制电脑时自动最小化本窗口（结束后恢复）
          </label>
          <label className="row" data-testid="plan-auto-confirm">
            <input type="checkbox" checked={!!s.planAutoConfirm} onChange={(e) => void toggle({ planAutoConfirm: e.target.checked })} />
            电脑操控计划自动确认（跳过 Plan 卡片）
          </label>
          <label>
            反思校验间隔（每 N 步截图核对，0 关闭）
            <input
              className="input"
              type="number"
              min={0}
              max={50}
              data-testid="reflect-every-n"
              value={s.reflectEveryNSteps ?? 5}
              onChange={(e) => void toggle({ reflectEveryNSteps: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })}
            />
          </label>
          <label>
            电脑控制单轮最多步数
            <input className="input" type="number" min={5} max={500} data-testid="computer-max-steps" value={compSteps} onChange={(e) => setCompSteps(Number(e.target.value))} />
          </label>
          <label>
            语音输入转写模型（调用 /audio/transcriptions）
            <input className="input mono" value={sttModel} onChange={(e) => setSttModel(e.target.value)} />
          </label>
          <div className="form-actions">
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        <GroundingSettings state={state} onState={onState} />

        <section className="card form" id="gs-agents" data-testid="multi-agent-section">
          <h3>
            <Icon name="node-tree" /> 多智能体并行
          </h3>
          <p className="muted small">每个助手都有独立的智能体循环，可同时工作互不阻塞。协调者可以用 delegate_to_agent 把任务拆分给其它助手并行执行；电脑控制共用一块屏幕，会自动排队（屏幕锁），其它工具照常并行。</p>
          <label>
            后台并行智能体上限（子任务 + 委派任务）
            <input className="input" type="number" min={1} max={32} data-testid="max-agents" value={maxAgents} onChange={(e) => setMaxAgents(Number(e.target.value))} />
          </label>
          <div className="form-actions">
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        <section className="card form" id="gs-background">
          <h3>后台运行（7×24）</h3>
          <label className="row">
            <input type="checkbox" checked={s.closeToTray} onChange={(e) => void toggle({ closeToTray: e.target.checked })} />
            关闭窗口时最小化到系统托盘（定时任务继续运行）
          </label>
          <label className="row">
            <input type="checkbox" data-testid="launch-at-login" checked={s.launchAtLogin} onChange={(e) => void toggle({ launchAtLogin: e.target.checked })} />
            开机自动启动（启动后隐藏在托盘）
          </label>
          <label className="row">
            <input type="checkbox" checked={s.routinesPaused} onChange={(e) => void toggle({ routinesPaused: e.target.checked })} />
            暂停所有定时任务
          </label>
          <label className="row">
            <input type="checkbox" data-testid="prevent-sleep" checked={s.preventSleep} onChange={(e) => void toggle({ preventSleep: e.target.checked })} />
            有任务或启用的定时任务时阻止系统休眠
          </label>
          <p className="muted small" data-testid="runtime-info">
            当前：{state.runtime?.powerBlocker === 'prevent-display-sleep' ? '正在控制电脑，保持屏幕常亮' : state.runtime?.powerBlocker ? '已阻止系统休眠' : '未阻止休眠'}
            {' · '}崩溃后自动重启（10 分钟内最多 3 次，日志保存在 crash.log）
          </p>
        </section>

        <section className="card form" id="gs-browser">
          <h3>浏览器自动化</h3>
          <p className="muted small">基于 Playwright，首次使用需下载 Chromium（约 150MB），也可以使用本机已安装的 Chrome / Edge。</p>
          <label className="row">
            <input type="checkbox" checked={s.browserHeadless} onChange={(e) => void toggle({ browserHeadless: e.target.checked })} />
            无头模式（不显示浏览器窗口）
          </label>
          <label className="row" data-testid="browser-persistent">
            <input type="checkbox" checked={!!s.browserPersistentProfile} onChange={(e) => void toggle({ browserPersistentProfile: e.target.checked })} />
            使用持久化 Profile（保留登录态 / Cookie）
          </label>
          <label className="row">
            <input type="checkbox" checked={!!s.browserProfilePerAssistant} onChange={(e) => void toggle({ browserProfilePerAssistant: e.target.checked })} />
            每个助手独立 Profile 目录
          </label>
          <label>
            Profile 目录（可选）
            <input className="input mono" data-testid="browser-profile-dir" value={profileDir} placeholder="留空则使用应用数据目录" onChange={(e) => setProfileDir(e.target.value)} />
          </label>
          <label>
            连接已打开的 Chrome（CDP 地址）
            <input className="input mono" data-testid="browser-cdp-url" value={cdpUrl} placeholder="例如 http://127.0.0.1:9222" onChange={(e) => setCdpUrl(e.target.value)} />
          </label>
          <label>
            浏览器可执行文件路径（可选）
            <input className="input mono" value={browserPath} placeholder="留空自动查找" onChange={(e) => setBrowserPath(e.target.value)} />
          </label>
          <div className="form-actions">
            {install && <span className={install.ok ? 'ok-text' : 'err-text'} title={install.message}>{install.message}</span>}
            <button
              className="btn"
              disabled={installing}
              onClick={async () => {
                setInstalling(true)
                setInstall(null)
                setInstall(await window.api.installBrowser())
                setInstalling(false)
              }}
            >
              {installing ? '下载中…' : '安装 Chromium'}
            </button>
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        <McpSettings state={state} onState={onState} />

        <section className="card form" id="gs-tools">
          <h3>工具与审批</h3>
          <p className="muted">开启「自动批准」后，助手调用该工具时不再弹出审批卡片。save_memory 与 spawn_task 始终自动执行。</p>
          {APPROVABLE_TOOLS.filter((t) => TOOL_INFO[t]).map((t) => (
            <div className="tool-row" key={t}>
              <div>
                <div>{TOOL_INFO[t][0]}</div>
                <div className="muted small">{TOOL_INFO[t][1]}</div>
              </div>
              <label className="switch">
                <input type="checkbox" data-testid={`auto-${t}`} checked={!!s.autoApprove[t]} onChange={(e) => void toggle({ autoApprove: { [t]: e.target.checked } })} />
                <span />
              </label>
            </div>
          ))}
          <label>
            默认工作目录
            <input className="input mono" value={workDir} onChange={(e) => setWorkDir(e.target.value)} />
          </label>
          <label>
            单轮最多工具调用步数
            <input className="input" type="number" min={1} max={50} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} />
          </label>
          <div className="form-actions">
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        <section className="card form" id="gs-about" data-testid="about-section">
          <h3>
            <Icon name="information-line" /> 关于与反馈
          </h3>
          <div className="row">
            <span>当前版本</span>
            <span className="mono" data-testid="app-version">
              {version}
            </span>
          </div>
          <label>
            更新地址（latest.json）
            <div className="row">
              <input className="input mono" data-testid="update-url" value={updateUrl} onChange={(e) => setUpdateUrl(e.target.value)} placeholder="https://example.com/assistant-desktop/latest.json" />
              <button
                className="btn"
                data-testid="update-check"
                onClick={async () => {
                  setUpd(null)
                  if (updateUrl !== s.updateUrl) onState(await window.api.saveSettings({ updateUrl: updateUrl.trim() }))
                  setUpd(await window.api.checkUpdate())
                }}
              >
                <Icon name="refresh-line" /> 检查更新
              </button>
            </div>
          </label>
          {upd && (
            <div className={upd.available ? 'ok-text' : upd.ok ? 'muted' : 'err-text'} data-testid="update-result">
              {upd.message}
              {upd.notes ? ` · ${upd.notes}` : ''}
              {upd.available && upd.url && (
                <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={() => void window.api.openExternal(upd.url!)}>
                  <Icon name="download-2-line" /> 下载
                </button>
              )}
            </div>
          )}
          <div className="row">
            <button
              className="btn"
              data-testid="export-logs"
              onClick={async () => {
                setExp(null)
                setExp(await window.api.exportLogs())
              }}
            >
              <Icon name="file-list-3-line" /> 导出诊断日志
            </button>
            <span className="muted small">用于反馈问题；包含用量摘要、编号标注 / 定位模型状态，API Key 等密钥已自动隐藏。</span>
          </div>
          {exp && (
            <div className={exp.ok ? 'ok-text' : 'err-text'} data-testid="export-result">
              {exp.message}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

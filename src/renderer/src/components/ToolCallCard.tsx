import { useState } from 'react'
import type { ToolCallRecord } from '../../../shared/types'
import Icon from './Icon'

const LABELS: Record<string, string> = {
  run_shell: '执行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  list_dir: '浏览目录',
  web_fetch: '抓取网页',
  save_memory: '保存记忆',
  ask_user: '询问用户',
  spawn_task: '启动后台任务',
  delegate_to_agent: '委派给多个智能体',
  browser_open: '浏览器 · 打开网页',
  browser_click: '浏览器 · 点击',
  browser_type: '浏览器 · 输入',
  browser_screenshot: '浏览器 · 截图',
  browser_get_text: '浏览器 · 读取文本',
  computer_screenshot: '电脑 · 截屏',
  find_text_on_screen: '电脑 · 查找文字',
  mouse_move: '电脑 · 移动鼠标',
  mouse_click: '电脑 · 点击',
  mouse_double_click: '电脑 · 双击',
  mouse_right_click: '电脑 · 右键',
  mouse_drag: '电脑 · 拖动',
  scroll: '电脑 · 滚动',
  type_text: '电脑 · 输入文字',
  key_press: '电脑 · 按键',
  open_app: '电脑 · 打开应用',
  open_url: '电脑 · 打开网址',
  list_windows: '电脑 · 列出窗口',
  focus_window: '电脑 · 切换窗口'
}

export const COMPUTER_TOOLS = new Set([
  'computer_screenshot',
  'find_text_on_screen',
  'mouse_move',
  'mouse_click',
  'mouse_double_click',
  'mouse_right_click',
  'mouse_drag',
  'scroll',
  'type_text',
  'key_press',
  'open_app',
  'open_url',
  'list_windows',
  'focus_window'
])

export function computerSummary(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'mouse_move':
    case 'mouse_click':
    case 'mouse_double_click':
    case 'mouse_right_click':
      return `(${args.x}, ${args.y})`
    case 'mouse_drag':
      return `(${args.x}, ${args.y}) → (${args.to_x}, ${args.to_y})`
    case 'scroll':
      return `${args.direction || 'down'} × ${args.amount || 5}`
    case 'type_text':
      return `"${String(args.text ?? '').slice(0, 40)}"`
    case 'key_press':
      return String(args.keys ?? '')
    case 'open_app':
      return [args.name, ...(Array.isArray(args.args) ? args.args : [])].join(' ').slice(0, 80)
    case 'open_url':
      return String(args.url ?? '')
    case 'focus_window':
      return String(args.title ?? '')
    default:
      return ''
  }
}
const ICONS: Record<string, string> = {
  run_shell: 'terminal-box-line',
  read_file: 'file-text-line',
  write_file: 'file-edit-line',
  list_dir: 'folder-open-line',
  web_fetch: 'global-line',
  save_memory: 'brain-line',
  spawn_task: 'flashlight-line',
  delegate_to_agent: 'node-tree',
  computer_screenshot: 'screenshot-2-line',
  find_text_on_screen: 'search-line',
  mouse_move: 'drag-move-line',
  mouse_click: 'cursor-line',
  mouse_double_click: 'cursor-fill',
  mouse_right_click: 'menu-line',
  mouse_drag: 'drag-drop-line',
  scroll: 'mouse-line',
  type_text: 'keyboard-line',
  key_press: 'keyboard-box-line',
  open_app: 'apps-2-line',
  open_url: 'external-link-line',
  ask_user: 'question-answer-line',
  list_windows: 'window-line',
  focus_window: 'focus-3-line'
}
const STATUS: Record<string, string> = {
  awaiting: '等待审批',
  awaiting_input: '等待你的回答',
  running: '执行中…',
  done: '完成',
  error: '出错',
  denied: '已拒绝',
  cancelled: '已取消'
}

function parse(a: string): Record<string, any> {
  try {
    return JSON.parse(a || '{}')
  } catch {
    return { raw: a }
  }
}

export function toolLabel(name: string): string {
  if (LABELS[name]) return LABELS[name]
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  if (m) return `MCP · ${m[1]} · ${m[2]}`
  return name
}

function summaryLine(call: ToolCallRecord, args: Record<string, any>): string {
  switch (call.name) {
    case 'run_shell':
      return String(args.command ?? '')
    case 'read_file':
    case 'write_file':
    case 'list_dir':
      return String(args.path || '(工作目录)')
    case 'web_fetch':
    case 'browser_open':
      return String(args.url ?? '')
    case 'browser_click':
      return String(args.selector || args.text || '')
    case 'browser_type':
      return `${args.selector} ← "${String(args.text ?? '').slice(0, 40)}"${args.submit ? ' ⏎' : ''}`
    case 'save_memory':
      return String(args.text ?? '')
    case 'spawn_task':
      return String(args.title ?? '')
    case 'delegate_to_agent':
      return Array.isArray(args.tasks) ? args.tasks.map((t: any) => t.agent).join('、') : ''
    default: {
      if (COMPUTER_TOOLS.has(call.name)) return computerSummary(call.name, args)
      const s = JSON.stringify(args)
      return s === '{}' ? '' : s.slice(0, 120)
    }
  }
}

export default function ToolCallCard({
  call,
  onRespond,
  onAlwaysAllow,
  onImage,
  onTrust,
  onAskRespond,
  compact
}: {
  call: ToolCallRecord
  onRespond(approved: boolean): void
  onAlwaysAllow(): void
  onTrust?(): void
  onAskRespond?(answer: string | null): void
  onImage?(src: string): void
  compact?: boolean
}): JSX.Element {
  const args = parse(call.arguments)
  const isComputer = COMPUTER_TOOLS.has(call.name)
  const [askText, setAskText] = useState('')
  // 电脑控制每步都有截图，默认折叠，只在标题栏显示缩略图
  const autoOpen = call.status === 'awaiting' || call.status === 'awaiting_input' || (!isComputer && !!call.images?.length) || (call.name === 'run_shell' && (call.result?.length ?? 0) < 1200)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = call.status === 'awaiting' || call.status === 'awaiting_input' ? true : userOpen ?? autoOpen
  const line = summaryLine(call, args)
  const dur = call.startedAt && call.finishedAt ? `${((call.finishedAt - call.startedAt) / 1000).toFixed(1)}s` : ''

  return (
    <div className={`tool-card status-${call.status}${open ? ' open' : ''}`} data-testid="tool-card" data-tool={call.name} data-status={call.status}>
      <button className="tool-head" onClick={() => setUserOpen(!open)} data-testid="tool-card-toggle">
        <Icon name="arrow-right-s-line" className={'chev' + (open ? ' down' : '')} />
        <Icon name={ICONS[call.name] || (call.name.startsWith('browser_') ? 'compass-3-line' : call.name.startsWith('mcp__') ? 'plug-line' : 'tools-line')} className="tool-icon" />
        <span className="tool-name">{toolLabel(call.name)}</span>
        {line && !open && <span className="tool-line">{line}</span>}
        <span className="spacer" />
        {isComputer && !open && call.images?.[0] && <img className="tool-thumb" src={call.images[0]} alt="" data-testid="tool-thumb" />}
        {dur && <span className="tool-dur">{dur}</span>}
        <span className={`tool-status s-${call.status}`}>
          {call.status === 'running' && <span className="spinner sm" />}
          {STATUS[call.status] || call.status}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {call.name === 'run_shell' ? (
            <pre className="tool-cmd">
              <span className="prompt">$</span> {String(args.command ?? '')}
              {args.cwd ? `\n# 目录: ${args.cwd}` : ''}
            </pre>
          ) : call.name === 'write_file' ? (
            <>
              <div className="tool-arg">
                路径：<code>{String(args.path ?? '')}</code>
              </div>
              <div className="io-label">写入内容</div>
              <pre className="tool-output">{String(args.content ?? '')}</pre>
            </>
          ) : (
            <>
              <div className="io-label">输入</div>
              <pre className="tool-output input">{JSON.stringify(args, null, 2)}</pre>
            </>
          )}
          {call.images && call.images.length > 0 && (
            <div className="tool-images">
              {call.images.map((src, i) => (
                <img key={i} src={src} alt="截图" data-testid="tool-image" onClick={() => onImage?.(src)} />
              ))}
            </div>
          )}
          {call.result && call.status !== 'awaiting' && (
            <>
              <div className="io-label">{call.name === 'run_shell' ? '命令输出' : '输出'}</div>
              <pre className="tool-output" data-testid="tool-output">
                {call.result}
              </pre>
            </>
          )}
        </div>
      )}
      {call.status === 'awaiting_input' && call.name === 'ask_user' && (
        <div className="tool-approval ask-user" data-testid="ask-user-card">
          <span className="hint">
            <Icon name="question-answer-line" className="warn-icon" /> {String(args.question || '助手想问你：')}
          </span>
          <input
            className="input"
            data-testid="ask-user-input"
            placeholder={String(args.placeholder || '输入回答…')}
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onAskRespond?.(askText)
              }
            }}
          />
          <div className="btns">
            <button className="btn" data-testid="ask-user-skip" onClick={() => onAskRespond?.(null)}>
              跳过
            </button>
            <button className="btn primary" data-testid="ask-user-submit" onClick={() => onAskRespond?.(askText)}>
              <Icon name="check-line" /> 提交回答
            </button>
          </div>
        </div>
      )}
      {call.status === 'awaiting' && (
        <div className="tool-approval" data-testid="approval-card">
          <span className="hint">
            <Icon name={isComputer ? 'computer-line' : 'shield-keyhole-line'} className="warn-icon" /> {isComputer ? '助手请求操作你的电脑，是否允许？' : '助手请求执行此操作，是否允许？'}
          </span>
          <div className="btns">
            <button className="btn" data-testid="deny-btn" onClick={() => onRespond(false)}>
              <Icon name="close-line" /> 拒绝
            </button>
            {!compact && isComputer && onTrust && (
              <button className="btn ghost" data-testid="trust-btn" onClick={onTrust} title="自动批准所有电脑控制操作（可在全局设置中关闭）">
                <Icon name="shield-check-line" /> 开启信任模式
              </button>
            )}
            {!compact && (
              <button className="btn ghost" onClick={onAlwaysAllow} title="以后自动允许此类工具（可在全局设置中关闭）">
                <Icon name="check-double-line" /> 始终允许
              </button>
            )}
            <button className="btn primary" data-testid="approve-btn" onClick={() => onRespond(true)}>
              <Icon name="check-line" /> 允许执行
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

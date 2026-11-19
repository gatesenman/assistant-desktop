import type { AppState, Assistant, Settings } from '../../../shared/types'
import Avatar from './Avatar'
import Icon from './Icon'

const PERSONAS: { name: string; icon: string; prompt: string }[] = [
  { name: '编程助手', icon: 'code-s-slash-line', prompt: '你是一名资深全栈工程师。回答简洁、给出可运行的代码，必要时使用工具查看/修改本地文件并运行命令验证。' },
  { name: '写作助手', icon: 'quill-pen-line', prompt: '你是一名中文写作编辑，擅长润色、改写、总结与结构化表达，语言自然流畅。' },
  { name: '研究助手', icon: 'search-eye-line', prompt: '你是一名研究助理。需要时主动使用网页抓取和浏览器工具收集资料，给出带来源链接的结论。耗时调研可放到后台任务中执行。' },
  { name: '生活助手', icon: 'leaf-line', prompt: '你是一位贴心的生活助理，帮助用户安排日程、提醒事项、整理清单，语气温和。' }
]

const SUGGESTIONS = ['帮我列出当前工作目录下的文件', '用 Python 写一个快速排序，并解释原理', '在后台调研一下 Electron 的最新版本特性', '记住：我喜欢简洁的回答']

export default function Onboarding({
  assistant,
  settings,
  onSend,
  onOpenGlobal,
  onOpenRoutines,
  onState
}: {
  assistant: Assistant
  settings: Settings
  onSend(s: string): void
  onOpenGlobal(): void
  onOpenRoutines(): void
  onState(s: AppState): void
}): JSX.Element {
  const keyOk = settings.apiKeySet || /localhost|127\.0\.0\.1/.test(settings.baseUrl)
  const hasPersona = !!assistant.systemPrompt.trim()
  return (
    <div className="onboarding" data-testid="onboarding">
      <div className="ob-hero">
        <Avatar name={assistant.name} color={assistant.color} size={64} />
        <h2>你好，我是 {assistant.name}</h2>
        <p>我可以聊天、执行命令、读写文件、操作浏览器、调用 MCP 工具、在后台跑任务，还能记住你的偏好。</p>
      </div>
      <div className="ob-steps">
        <div className={'ob-step' + (keyOk ? ' done' : '')}>
          <span className="ob-num">{keyOk ? <Icon name="check-line" /> : '1'}</span>
          <div>
            <div className="ob-title">连接模型</div>
            <div className="muted small">{keyOk ? `已配置：${settings.model}` : '填写 OpenAI 兼容接口的 Base URL、API Key 和模型'}</div>
          </div>
          {!keyOk && (
            <button className="btn sm primary" onClick={onOpenGlobal}>
              去设置
            </button>
          )}
        </div>
        <div className={'ob-step' + (hasPersona ? ' done' : '')}>
          <span className="ob-num">{hasPersona ? <Icon name="check-line" /> : '2'}</span>
          <div style={{ flex: 1 }}>
            <div className="ob-title">选择人设</div>
            <div className="persona-row">
              {PERSONAS.map((p) => (
                <button
                  key={p.name}
                  className={'chip' + (assistant.systemPrompt === p.prompt ? ' active' : '')}
                  onClick={async () => onState(await window.api.updateAssistant(assistant.id, { systemPrompt: p.prompt }))}
                >
                  <Icon name={p.icon} /> {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="ob-step">
          <span className="ob-num">3</span>
          <div>
            <div className="ob-title">让它按时工作</div>
            <div className="muted small">添加定时任务，例如每天早上汇总新闻；关闭窗口后仍在托盘中运行。</div>
          </div>
          <button className="btn sm" onClick={onOpenRoutines}>
            添加
          </button>
        </div>
      </div>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="suggestion" onClick={() => onSend(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

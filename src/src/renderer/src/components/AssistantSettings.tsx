import { useEffect, useState } from 'react'
import type { AppState, Assistant, MemoryItem, VmOs } from '../../../shared/types'
import { VM_OS_LIST, VM_PROFILES, vmOsFromMachineId } from '../../../shared/vmProfiles'
import Icon from './Icon'

export default function AssistantSettings({ assistant, onState, state }: { assistant: Assistant; onState(s: AppState): void; state: AppState }): JSX.Element {
  const [name, setName] = useState(assistant.name)
  const [prompt, setPrompt] = useState(assistant.systemPrompt)
  const [model, setModel] = useState(assistant.model || '')
  const [newMem, setNewMem] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [saved, setSaved] = useState(false)
  const [workDir, setWorkDir] = useState(assistant.workDir || '')

  useEffect(() => {
    setName(assistant.name)
    setPrompt(assistant.systemPrompt)
    setModel(assistant.model || '')
    setWorkDir(assistant.workDir || '')
  }, [assistant.id])

  const dirty = name !== assistant.name || prompt !== assistant.systemPrompt || model !== (assistant.model || '')

  const saveBasic = async (): Promise<void> => {
    onState(await window.api.updateAssistant(assistant.id, { name: name.trim() || assistant.name, systemPrompt: prompt, model: model.trim() || undefined }))
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  const saveMemory = async (memory: MemoryItem[]): Promise<void> => {
    onState(await window.api.updateAssistant(assistant.id, { memory }))
  }

  return (
    <div className="page">
      <div className="page-inner">
        <section className="card form">
          <h3>基本信息</h3>
          <label>
            名称
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            模型（可选，留空使用全局模型）
            <input className="input mono" value={model} placeholder="例如 gpt-4o / grok-4 / deepseek-chat" onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            系统提示词（人设与指令）
            <textarea className="input" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <div className="form-actions">
            {saved && <span className="ok-text"><Icon name="check-line" /> 已保存</span>}
            <button className="btn primary" disabled={!dirty} onClick={() => void saveBasic()}>
              保存
            </button>
          </div>
        </section>

        <section className="card form">
          <h3>长期记忆</h3>
          <p className="muted">这些事实会注入到系统提示词中。助手也可以通过 save_memory 工具自动添加。</p>
          {assistant.memory.length === 0 && <div className="empty-card">暂无记忆</div>}
          <ul className="memory-list">
            {assistant.memory.map((m) => (
              <li key={m.id}>
                {editing === m.id ? (
                  <>
                    <input className="input sm" autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} />
                    <button
                      className="btn sm primary"
                      onClick={() => {
                        void saveMemory(assistant.memory.map((x) => (x.id === m.id ? { ...x, text: editText.trim() || x.text } : x)))
                        setEditing(null)
                      }}
                    >
                      保存
                    </button>
                    <button className="btn sm" onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span className="mem-text">{m.text}</span>
                    <span className="muted small">{new Date(m.createdAt).toLocaleDateString('zh-CN')}</span>
                    <button
                      className="mini-btn"
                      title="编辑"
                      onClick={() => {
                        setEditing(m.id)
                        setEditText(m.text)
                      }}
                    >
                      <Icon name="pencil-line" />
                    </button>
                    <button className="mini-btn danger" title="删除" onClick={() => void saveMemory(assistant.memory.filter((x) => x.id !== m.id))}>
                      <Icon name="delete-bin-line" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="row">
            <input
              className="input"
              value={newMem}
              placeholder="手动添加一条记忆，回车保存"
              onChange={(e) => setNewMem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && newMem.trim()) {
                  void saveMemory([...assistant.memory, { id: crypto.randomUUID(), text: newMem.trim(), createdAt: Date.now() }])
                  setNewMem('')
                }
              }}
            />
          </div>
        </section>

        
        <section className="card form" data-testid="bot-workdir-section">
          <h3>工作目录与电脑</h3>
          <p className="muted small">工具默认 cwd 为该目录（空则用全局工作目录）。电脑偏好与右侧「电脑」面板同步。</p>
          <label>
            工作目录
            <input className="input mono" data-testid="bot-workdir" value={workDir} placeholder="例如 /home/user/projects" onChange={(e) => setWorkDir(e.target.value)} />
          </label>
          <div className="form-actions">
            <button
              className="btn primary"
              onClick={async () => {
                onState(await window.api.updateAssistant(assistant.id, { workDir: workDir.trim() || undefined }))
                setSaved(true)
                setTimeout(() => setSaved(false), 1500)
              }}
            >
              保存工作目录
            </button>
          </div>
          <label className="row" style={{ marginTop: 8 }}>
            <span>电脑目标</span>
            <select
              className="input"
              data-testid="bot-computer-mode"
              value={assistant.computerMode || 'this'}
              onChange={async (e) => onState(await window.api.updateAssistant(assistant.id, { computerMode: e.target.value as any, computerEnabled: e.target.value !== 'off' }))}
            >
              <option value="this">本机</option>
              <option value="virtual">本地虚拟电脑</option>
              <option value="remote">远程伴侣</option>
              <option value="off">关闭</option>
            </select>
          </label>
          {(assistant.computerMode || 'this') === 'virtual' && (
            <label className="row" style={{ marginTop: 8 }}>
              <span>虚拟电脑系统</span>
              <select
                className="input"
                data-testid="bot-vm-os"
                value={assistant.vmOs || state.settings.vmLastOs || 'linux'}
                onChange={async (e) => onState(await window.api.vmSetActive(e.target.value as VmOs, assistant.id))}
              >
                {VM_OS_LIST.map((o) => (
                  <option key={o} value={o}>
                    {VM_PROFILES[o].title}
                    {VM_PROFILES[o].agentControl ? '' : '（仅手动操作）'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="muted small" data-testid="bot-active-target" style={{ marginTop: 6 }}>
            当前控制目标：
            {(() => {
              const o = vmOsFromMachineId(state.settings.activeMachineId)
              if (o) return `虚拟电脑 · ${VM_PROFILES[o].title}${VM_PROFILES[o].agentControl ? '' : '（暂不支持自动键鼠）'}`
              return state.settings.activeMachineId === 'local' || !state.settings.activeMachineId ? '本机' : `远程 ${state.settings.activeMachineId}`
            })()}
          </div>
        </section>

<section className="card form danger-zone">
          <h3>危险操作</h3>
          <div className="row">
            <button
              className="btn danger"
              onClick={() => {
                if (confirm('确定清空该助手的全部聊天记录？')) void window.api.clearMessages(assistant.id)
              }}
            >
              清空聊天记录
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (confirm(`确定删除助手「${assistant.name}」？`)) onState(await window.api.deleteAssistant(assistant.id))
              }}
            >
              删除助手
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

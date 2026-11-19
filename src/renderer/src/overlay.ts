import 'remixicon/fonts/remixicon.css'
import './styles/overlay.css'

const keys = new URLSearchParams(location.search).get('keys') || 'Ctrl+Alt+Esc'
document.getElementById('keys')!.textContent = ` · ${keys} 停止`

const stopBtn = document.getElementById('stop')!
const takeBtn = document.getElementById('takeover') as HTMLButtonElement | null
const handBtn = document.getElementById('handback') as HTMLButtonElement | null
const titleEl = document.querySelector('.bar .t') as HTMLElement | null

function setTakeoverUi(active: boolean): void {
  if (takeBtn) takeBtn.hidden = active
  if (handBtn) handBtn.hidden = !active
  if (titleEl) {
    const label = titleEl.childNodes[0]
    if (label && label.nodeType === Node.TEXT_NODE) {
      label.textContent = active ? '你已接管电脑' : '小助手正在控制电脑'
    }
  }
}

stopBtn.addEventListener('click', () => void window.api?.emergencyStop())

takeBtn?.addEventListener('click', () => {
  void window.api.takeover('', '用户从悬浮条接管').catch(() => undefined)
})

handBtn?.addEventListener('click', () => {
  void window.api.handback('', '').catch(() => undefined)
})

window.api?.onEvent?.((ev) => {
  if (ev.type === 'takeover') setTakeoverUi(!!ev.active)
  if (ev.type === 'runtime' && 'runtime' in ev) {
    setTakeoverUi(!!(ev as any).runtime?.takeover)
  }
})

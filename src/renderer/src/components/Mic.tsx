import { useRef, useState } from 'react'
import Icon from './Icon'

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** 语音输入：录音 → 主进程调用 /audio/transcriptions → 文本填入输入框 */
export default function Mic({ onText, onError }: { onText(t: string): void; onError(e: string): void }): JSX.Element {
  const [state, setState] = useState<'idle' | 'rec' | 'busy'>('idle')
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || ''
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunks.current = []
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setState('busy')
        try {
          const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })
          const res = await window.api.transcribe(await blobToBase64(blob), blob.type)
          if (res.ok && res.text) onText(res.text)
          else onError(res.text || '没有识别到语音')
        } catch (e: any) {
          onError('转写失败：' + (e?.message || e))
        } finally {
          setState('idle')
        }
      }
      r.start(250)
      rec.current = r
      setState('rec')
    } catch (e: any) {
      onError('无法使用麦克风：' + (e?.message || e))
      setState('idle')
    }
  }

  return (
    <button
      className={'cp-icon mic' + (state === 'rec' ? ' recording' : '')}
      data-testid="mic-btn"
      data-state={state}
      disabled={state === 'busy'}
      title={state === 'rec' ? '点击结束录音并转写' : '语音输入'}
      onClick={() => {
        if (state === 'rec') rec.current?.stop()
        else if (state === 'idle') void start()
      }}
    >
      {state === 'busy' ? (
        <span className="spinner sm" />
      ) : (
        <Icon name={state === 'rec' ? 'stop-circle-line' : 'mic-line'} size={18} />
      )}
    </button>
  )
}

import Icon from './Icon'
import { memo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

function Pre({ children }: { children?: ReactNode }): JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-wrap">
      <button
        className="copy-btn"
        onClick={() => {
          void navigator.clipboard.writeText(ref.current?.innerText || '')
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        <Icon name={copied ? 'check-line' : 'file-copy-line'} /> {copied ? '已复制' : '复制'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

function Markdown({ text, onImage }: { text: string; onImage?: (src: string) => void }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
        components={{
          pre: Pre,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href) void window.api.openExternal(href)
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img className="md-img" src={src} alt={alt || ''} onClick={() => src && onImage?.(src)} />
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)

/** 图标字体（Remix Icon，随应用打包，离线可用） */
export default function Icon({ name, className, size, title }: { name: string; className?: string; size?: number; title?: string }): JSX.Element {
  return <i className={`ri-${name} icon${className ? ' ' + className : ''}`} style={size ? { fontSize: size } : undefined} aria-hidden={title ? undefined : true} title={title} />
}

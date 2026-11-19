export default function Avatar({ name, color, size = 32 }: { name: string; color: string; size?: number }): JSX.Element {
  const ch = Array.from(name.trim())[0]?.toUpperCase() || '?'
  return (
    <div className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.45 }}>
      {ch}
    </div>
  )
}

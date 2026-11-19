import { randomUUID } from 'crypto'
export const uid = (): string => randomUUID()
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[已截断，共 ${s.length} 字符]`
}

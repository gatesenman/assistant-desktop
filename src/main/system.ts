import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'

/** 开机自启：macOS/Windows 使用系统登录项，Linux 写入 XDG autostart 文件 */
export function setLaunchAtLogin(enabled: boolean): void {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] })
    return
  }
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart')
  const file = path.join(dir, 'assistant-desktop.desktop')
  if (!enabled) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
    return
  }
  const exe = process.env.APPIMAGE || process.execPath
  const args = app.isPackaged ? '--hidden' : `"${app.getAppPath()}" --hidden`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    file,
    ['[Desktop Entry]', 'Type=Application', 'Name=AssistantDesktop', 'Comment=小助手 Desktop', `Exec="${exe}" ${args}`, 'X-GNOME-Autostart-enabled=true', ''].join('\n')
  )
}

export function autostartFile(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'assistant-desktop.desktop')
}

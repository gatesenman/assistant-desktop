#!/bin/bash
# 启动虚拟桌面：Xvfb + fluxbox + 浏览器/终端快捷方式 + x11vnc + noVNC
set -eu
trap 'kill $(jobs -p) 2>/dev/null || true; exit 0' TERM INT

export LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 DISPLAY=:0
GEOMETRY="${GEOMETRY:-1280x800x24}"
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0

# 工作区与桌面快捷方式（每次启动刷新，保证挂载后可用）
mkdir -p /workspace /home/desk/Desktop /home/desk/.config
ln -sfn /workspace /home/desk/Desktop/工作目录
cat > /home/desk/Desktop/Firefox.desktop <<'D'
[Desktop Entry]
Type=Application
Name=Firefox 浏览器
Exec=firefox
Icon=firefox
Terminal=false
D
cat > /home/desk/Desktop/终端.desktop <<'D'
[Desktop Entry]
Type=Application
Name=终端
Exec=xterm -fa 'Noto Sans Mono CJK SC' -fs 12
Icon=utilities-terminal
Terminal=false
D
cat > /home/desk/Desktop/记事本.desktop <<'D'
[Desktop Entry]
Type=Application
Name=记事本
Exec=mousepad
Icon=accessories-text-editor
Terminal=false
D
chmod +x /home/desk/Desktop/*.desktop || true
# v0.6：不再递归 chown 宿主挂载的 /workspace（Linux 宿主上会改掉用户文件的属主）。
# 若宿主传入 HOST_UID/HOST_GID，则让 desk 用户与宿主用户同 uid/gid，从而可直接读写工作目录。
if [ -n "${HOST_UID:-}" ] && [ "${HOST_UID}" != "0" ] && [ "$(id -u desk)" != "${HOST_UID}" ]; then
  other="$(getent passwd "${HOST_UID}" | cut -d: -f1 || true)"
  if [ -n "$other" ] && [ "$other" != "desk" ]; then userdel "$other" 2>/dev/null || true; fi
  if [ -n "${HOST_GID:-}" ] && [ "${HOST_GID}" != "0" ]; then
    og="$(getent group "${HOST_GID}" | cut -d: -f1 || true)"
    if [ -n "$og" ] && [ "$og" != "desk" ]; then groupdel "$og" 2>/dev/null || true; fi
    groupmod -o -g "${HOST_GID}" desk 2>/dev/null || true
    usermod -g "${HOST_GID}" desk 2>/dev/null || true
  fi
  usermod -o -u "${HOST_UID}" desk 2>/dev/null || true
fi
chown -R desk:desk /home/desk 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 "$GEOMETRY" -nolisten tcp &
for i in $(seq 1 80); do [ -e /tmp/.X11-unix/X0 ] && break; sleep 0.1; done

# v0.7：desk 用户的 D-Bus 会话 + AT-SPI 无障碍总线（供智能体读取控件树）；环境写入 /tmp/desk-session.env
su -s /bin/bash desk -c 'export DISPLAY=:0; dbus-launch --sh-syntax > /tmp/desk-session.env 2>/dev/null; . /tmp/desk-session.env; echo "export DISPLAY=:0 LANG=zh_CN.UTF-8 GTK_MODULES=gail:atk-bridge GNOME_ACCESSIBILITY=1 NO_AT_BRIDGE=0" >> /tmp/desk-session.env; (/usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &); true' || true
chmod 644 /tmp/desk-session.env 2>/dev/null || touch /tmp/desk-session.env
# 以 desk 用户跑桌面
su -s /bin/bash desk -c '. /tmp/desk-session.env; export DISPLAY=:0 LANG=zh_CN.UTF-8; fluxbox >/tmp/fluxbox.log 2>&1' &
sleep 0.8
# 默认打开终端指向工作目录 + 欢迎说明
su -s /bin/bash desk -c '. /tmp/desk-session.env; export DISPLAY=:0; xterm -fa "Noto Sans Mono CJK SC" -fs 11 -geometry 90x24+40+40 -T "工作目录 /workspace" -e bash -lc "cd /workspace; echo 本地虚拟电脑已就绪; echo 工作目录已挂载到 /workspace; echo 桌面有 Firefox / 终端 / 记事本; exec bash"' >/tmp/xterm.log 2>&1 &

# VNC（本机环回映射，无密码；由宿主机只绑 127.0.0.1）
(
  while :; do
    x11vnc -display "$DISPLAY" -rfbport 5900 -forever -shared -nopw -quiet -noxdamage >/tmp/x11vnc.log 2>&1 || true
    sleep 1
  done
) &

# noVNC Web 桌面 :6080
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

echo "assistant-vm ready geometry=$GEOMETRY"
wait

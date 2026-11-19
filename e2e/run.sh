#!/usr/bin/env bash
# 在 Linux 无显示环境运行端到端测试：
#   - dbus-run-session + gnome-keyring 提供真实的系统密钥环（safeStorage 使用 libsecret 加密）
#   - xvfb-run 提供虚拟显示
# 用法：bash e2e/run.sh [截图目录]
set -e
cd "$(dirname "$0")/.."
OUT="${1:-$PWD/e2e-screenshots}"
inner() {
  if command -v gnome-keyring-daemon >/dev/null; then
    # 使用临时目录中的独立 login 密钥环，避免弹出创建密钥环的对话框
    export XDG_DATA_HOME="$(mktemp -d)"
    mkdir -p "$XDG_DATA_HOME/keyrings" && echo -n login > "$XDG_DATA_HOME/keyrings/default"
    eval "$(echo -n 'e2e-keyring-pass' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
    export XDG_CURRENT_DESKTOP=GNOME
  fi
  xvfb-run -a -s "-screen 0 ${XVFB_SCREEN:-1400x900x24}" node e2e/${E2E_SCRIPT:-run-e2e.mjs} "$OUT"
}
export -f inner
export OUT
if command -v dbus-run-session >/dev/null; then
  dbus-run-session -- bash -c inner
else
  inner
fi

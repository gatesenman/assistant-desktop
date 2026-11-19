import { parseA11yJson, type A11ySnapshot } from './som'

/**
 * Linux 无障碍树（AT-SPI，python3-pyatspi）。
 * 脚本通过 stdin 交给 `python3 -`，宿主机与本地虚拟电脑（docker exec）共用；
 * 输出与 Windows UIA 助手相同的 JSON 格式，由 parseA11yJson 解析。
 */
export const ATSPI_SCRIPT = String.raw`
import sys, json, time
t0 = time.time()
scope = sys.argv[1] if len(sys.argv) > 1 else 'foreground'
max_n = int(sys.argv[2]) if len(sys.argv) > 2 else 400
max_depth = int(sys.argv[3]) if len(sys.argv) > 3 else 30
budget = float(sys.argv[4]) / 1000.0 if len(sys.argv) > 4 else 2.5
try:
    import pyatspi
except Exception as e:
    print(json.dumps({"ok": False, "engine": "atspi", "error": "未安装 python3-pyatspi：" + str(e)}))
    sys.exit(0)
out = []
fg = ''
try:
    desk = pyatspi.Registry.getDesktop(0)
    wins = []
    for a in desk:
        if a is None:
            continue
        try:
            for w in a:
                if w is None:
                    continue
                st = w.getState()
                if not st.contains(pyatspi.STATE_SHOWING):
                    continue
                wins.append((st.contains(pyatspi.STATE_ACTIVE), a.name or '', w))
        except Exception:
            pass
    active = [x for x in wins if x[0]]
    if scope == 'desktop' or not active:
        chosen = wins
    else:
        chosen = active
    if active:
        fg = active[0][2].name or active[0][1]
    elif wins:
        fg = wins[-1][2].name or wins[-1][1]
    def walk(node, depth, win):
        if len(out) >= max_n or depth > max_depth or time.time() - t0 > budget:
            return
        try:
            n = node.childCount
        except Exception:
            return
        for i in range(min(n, 500)):
            if len(out) >= max_n or time.time() - t0 > budget:
                return
            try:
                c = node.getChildAtIndex(i)
                if c is None:
                    continue
                st = c.getState()
                if not st.contains(pyatspi.STATE_SHOWING):
                    continue
                role = c.getRoleName()
                try:
                    ext = c.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                    x, y, w, h = ext.x, ext.y, ext.width, ext.height
                except Exception:
                    x = y = w = h = 0
                pats = []
                try:
                    act = c.queryAction()
                    if act.nActions > 0:
                        pats.append('invoke')
                except Exception:
                    pass
                v = ''
                try:
                    c.queryEditableText()
                    pats.append('value')
                    t = c.queryText()
                    v = t.getText(0, min(t.characterCount, 120))
                except Exception:
                    pass
                if st.contains(pyatspi.STATE_CHECKABLE):
                    pats.append('toggle')
                if st.contains(pyatspi.STATE_SELECTABLE):
                    pats.append('select')
                if st.contains(pyatspi.STATE_EXPANDABLE):
                    pats.append('expand')
                if w >= 4 and h >= 4 and x > -10000:
                    out.append({"r": role, "n": (c.name or '')[:160], "x": x, "y": y, "w": w, "h": h, "p": pats,
                                "e": 1 if st.contains(pyatspi.STATE_ENABLED) or st.contains(pyatspi.STATE_SENSITIVE) else 0,
                                "f": 1 if st.contains(pyatspi.STATE_FOCUSED) else 0, "v": v, "win": win})
                walk(c, depth + 1, win)
            except Exception:
                pass
    for _, app_name, w in chosen:
        walk(w, 0, w.name or app_name)
    print(json.dumps({"ok": True, "engine": "atspi", "fg": fg, "ms": int((time.time() - t0) * 1000), "els": out}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "engine": "atspi", "error": "AT-SPI 读取失败：" + str(e)}, ensure_ascii=False))
`

/** 运行器：exec(script, args) 把脚本送入 python3 的 stdin，返回 stdout */
export type ScriptRunner = (script: string, args: string[], timeoutMs: number) => Promise<string>

export interface AtspiOptions {
  max?: number
  depth?: number
  budgetMs?: number
  timeoutMs?: number
}

/** 读取 AT-SPI 元素，屏幕尺寸由调用方提供（AT-SPI 坐标即 X 屏幕坐标） */
export async function atspiSnapshot(run: ScriptRunner, screen: { width: number; height: number }, scope: 'foreground' | 'desktop' = 'foreground', opts: AtspiOptions = {}): Promise<A11ySnapshot> {
  const t0 = Date.now()
  try {
    const raw = await run(ATSPI_SCRIPT, [scope, String(opts.max ?? 400), String(opts.depth ?? 30), String(opts.budgetMs ?? 2500)], opts.timeoutMs ?? 6000)
    const snap = parseA11yJson(raw, screen)
    snap.screen = screen
    if (!snap.engine || snap.engine === 'uia') snap.engine = 'atspi'
    snap.ms ??= Date.now() - t0
    return snap
  } catch (e: any) {
    return { elements: [], screen, engine: 'atspi', error: 'AT-SPI 读取失败：' + (e?.message || e) }
  }
}

# 小助手 Desktop —— 能 7×24 操控整台电脑的多智能体桌面 AI 助理

基于 **Electron + Vite + React + TypeScript** 的桌面 AI 助手，界面为简体中文，默认深色极简风格（可切换浅色）。
支持任何 **OpenAI 兼容** 的 Chat Completions 接口（OpenAI、xAI Grok、DeepSeek、Ollama、各类中转服务等）。

所有代码均为从零编写。当前版本：**0.8.0**。

## 0.8.0 新增（竞品对齐 P1）

### 浏览器升级
- 支持 **持久化 Chromium Profile**（保留登录态 / Cookie），可按助手分目录。
- 支持 **connectOverCDP** 连接本机已打开的 Chrome（设置里填 CDP 地址，如 `http://127.0.0.1:9222`）。
- 新工具：`browser_state`（可交互元素编号 + role/name/无障碍信息）、`browser_click_index` / `browser_type_index`、`browser_extract(schema)`。
- 检测到验证码 / 2FA 文案时会提示 **接管**，避免盲点。

### 接管 / 交还 · 运行中引导 · ask_user
- 电脑控制中可点悬浮条或聊天栏「我来接管」：释放屏幕锁并暂停智能体循环；「交还继续」后自动截图并注入「用户刚才做了…」。
- 运行中发来的新消息会入队，在下一次模型请求前作为 user 消息插入。
- 新工具 `ask_user`：聊天内审批卡片，支持文本回答；未回答则暂停等待。

### 轨迹回放 · 示教生成技能
- 「操作日志」按任务分组时间轴（截图 + 动作 + 思考），可逐帧回放。
- 可导出 **GIF / MP4**（优先 ffmpeg；失败则导出帧序列）。
- 日志按任务归档，不再死卡 300 条硬上限（仍有合理裁剪）。
- 「录制示教」：记录键鼠 / 目标，停止后生成 `skills/` 下可审阅的 `SKILL.md` 草稿（启发式模板；接真实 Key 时可由模型润色）。

### 规划 · 反思校验 · 经验记忆
- 电脑操控任务会先出 **Plan 卡片**（可编辑 / 确认后执行）；「信任模式」或设置里「计划自动确认」可跳过。
- 每 N 步（可配置，0 关闭）做截图核对；打开应用 / URL 等阶段切换也会触发反思。
- 成功轨迹摘要写入经验库，按应用 / 关键词检索，注入系统提示。

### 自建评测集
- `evals/tasks/*.json`：至少 8 个任务（init / 指令 / 校验），可在 Linux / 假模型下跑子集。
- `evals/run.mjs` 输出成功率、步数、token、耗时；e2e `run-v08.mjs` 覆盖上述五项能力并截图。

### 需在 Windows 实机验证
- 持久化 Profile 登录态、CDP 连接本机 Chrome、验证码接管流程。
- UIA 示教目标捕获、真实 ffmpeg 导出 MP4、Plan 卡片与 ask_user 在真实 LLM 下的体验。
- NSIS / Portable 安装包在本机构建（Linux box + wine）；签名与杀软误报需在 Windows 上确认。


## 0.4.0 新增

- **连接器**：内置邮箱（IMAP/SMTP、Gmail OAuth）、Google/Microsoft 日历、Slack、Telegram MCP 连接器包；设置页安装/测试/状态；密钥 safeStorage。
- **技能与工作流**：SKILL.md 技能目录 + 浏览器/编辑器；内置中文技能（邮件分拣、日程、调研报告、电脑操作手册）；工作流多步配方可跑编排引擎。
- **远程电脑**：WebSocket 伴侣（本机开启监听或连接远程）；机器列表与电脑控制目标切换；companion/remote-agent.mjs 可拷到其他电脑做连通。
- **消息通道**：Telegram 长轮询收发；Slack Bot 轮询；微信本机 HTTP 桥 stub（DIY）；外发默认草稿审批。
- **任务编排**：大目标拆 DAG、优先级、失败退避重试、暂停/取消；编排时间线面板。

## 0.3.1 新增

- **图标字体**：界面图标全部改为内置离线的 Remix Icon 字体（不依赖网络），尺寸统一、适配深色主题；emoji 只保留在聊天内容里。
- **首次启动向导**：全新安装时必须先连接并测试通过一个模型才能进入；内置 DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI / xAI / Ollama 预设；检测到 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等环境变量会自动预填。只需一个 Key 即可开始使用。
- **清晰的中文错误提示**：Key 无效、余额不足、模型不存在、速率限制、网络 / 代理 / DNS / 超时、上下文超长、模型不支持工具或图片，均给出原因和解决办法；429 / 5xx / 网络错误自动退避重试（遵守 Retry-After），失败的消息带「重试」按钮。
- **网络代理**：跟随系统 / 直连 / 自定义 HTTP、HTTPS、SOCKS5；模型请求、网页抓取、语音转写、自动化浏览器统一走代理；带「测试代理」。
- **模型能力检测**：自动检测工具调用和图片输入能力并缓存；电脑控制前检查。
- **纯文本模型也能控制电脑**：不能看图的模型（如 deepseek-v4-pro）自动切换为「文字描述（OCR）」模式——把屏幕文字（tesseract，chi_sim+eng）及坐标、检测到的输入框 / 按钮矩形、窗口列表发给模型，模型据此按坐标点击和输入；新增 `find_text_on_screen` 工具。系统装有 `tesseract` 时优先使用，否则使用内置的 tesseract.js（WebAssembly，语言包随安装包分发）。
- **鲁棒性**：截断 / 不规范的工具参数 JSON 自动修复；调用不存在的工具时返回可用工具列表；上下文超长时自动裁剪历史重试；兼容推理模型的 `reasoning_content`。
- **自动更新钩子**（占位）：从配置的 `latest.json` 检查新版本并提示下载。
- **导出诊断日志**：一键导出（已自动隐藏 API Key 等密钥），便于反馈问题。

## 功能一览

### 对话与助手
| 功能 | 说明 |
| --- | --- |
| 多助手 | 左侧栏列出所有助手：头像、名称、最后一条消息预览和时间；忙碌时头像右下角有动态指示。支持新建 / 重命名 / 删除、Ctrl/⌘+K 快速切换 |
| 聊天 | 圆角灰色气泡（用户在右、助手在左）、时间分隔线、Markdown（GFM 表格、代码高亮 + 复制）、流式输出、打字指示、停止生成、图片消息（粘贴 / 拖拽 / 选择）、Ctrl/⌘+F 聊天搜索 |
| 胶囊输入框 | 「＋」添加图片、🎤 语音输入（录音后调用 `/audio/transcriptions` 转写，模型可配置，默认 `whisper-1`）、白色圆形 ↑ 发送 / ■ 停止 |
| 引导页 | 新助手首次打开时显示配置步骤和人设模板 |
| 长期记忆 | 模型通过 `save_memory` 保存事实，注入系统提示词；可在助手「设置」页管理 |
| 上下文预算 | 按估算 token 数裁剪历史（中日韩字符≈1 token，其它≈4 字符/token，图片≈800） |

### 工具（均带审批卡片，可按工具设置自动批准）
| 类别 | 工具 |
| --- | --- |
| 本机 | `run_shell`、`read_file`、`write_file`、`list_dir`、`web_fetch`、`save_memory` |
| 浏览器自动化（Playwright） | `browser_open` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_get_text`，以及 v0.8 的 `browser_state` / `browser_click_index` / `browser_type_index` / `browser_extract`；支持持久化 Profile 与 CDP |
| **电脑控制**（新） | `computer_screenshot`、`mouse_move` / `mouse_click` / `mouse_double_click` / `mouse_right_click` / `mouse_drag`、`scroll`、`type_text`（中文通过剪贴板粘贴）、`key_press`（如 `ctrl+c`、`alt+f4`）、`open_app`、`open_url`、`list_windows`、`focus_window` |
| MCP 连接器 | stdio 与 Streamable HTTP 两种传输，工具以 `mcp__服务器__工具` 命名，可逐个服务器启用 / 停用、自动批准 |
| 后台子任务 | `spawn_task`：独立上下文在后台执行，完成后结果回传对话并由主助手总结 |
| **多智能体委派**（新） | `delegate_to_agent`：协调者把大任务拆分给其它助手**并行**执行，全部完成后自动汇总 |

### 电脑控制（Computer Use）
- 截图使用 Electron `desktopCapturer`（主显示器），缩放到约 1280px 宽后发送给视觉模型；模型以截图坐标下指令，应用自动换算为真实屏幕坐标（支持高 DPI）。
- 鼠标 / 键盘使用 `@nut-tree-fork/nut-js`（预编译 N-API 原生模块，无需本地编译，兼容 Electron 33）。
- 智能体循环：截图 → 模型决定动作 → 执行 → 自动再截图 → … 直到完成；单轮最多步数可配置（默认 40）。
- **安全**：
  - 默认逐步审批（截屏和列出窗口除外）；审批卡片上可一键「开启信任模式」。
  - **信任模式**：自动批准所有电脑控制操作，用于无人值守。
  - 控制期间屏幕顶部显示置顶悬浮条「小助手正在控制电脑 · Ctrl+Alt+Esc 停止 [停止]」，聊天中也有红色提示条和「停止控制」按钮。
  - 全局急停快捷键 **Ctrl+Alt+Esc**：立即中止所有正在控制电脑（或排队等待屏幕）的智能体，消息标记「⛔ 已紧急停止」。
  - 可选：控制电脑时自动最小化本窗口，结束后恢复。
- **操作日志**（顶栏「🖥 操作日志」）：每一步的工具、参数、结果、时间、所属助手，以及截图缩略图（点击放大），持久化在 `computer-log.json`（最近 300 条）。
- macOS 需在「系统设置 → 隐私与安全性」为应用授予**屏幕录制**和**辅助功能**权限；Linux 需 X11（Wayland 下截图/输入受限）。

### 多智能体并行
- 每个助手都有独立的智能体循环：多个助手可以同时流式回复、调用工具，互不阻塞，也不阻塞界面。
- 协调者通过 `delegate_to_agent` 把子任务交给指定助手（按名称），每个子任务使用该助手的人设、记忆和模型，在后台并行执行；协调者等待全部完成后拿到汇总结果再回复用户。
- **并发上限**：后台智能体（子任务 + 委派任务）默认最多 **10** 个同时运行，超出的排队，可在「全局设置 → 多智能体并行」调整（1–32）。
- **屏幕锁**：只有一块屏幕，电脑控制会话互斥——第一个开始控制电脑的智能体持有锁直到本轮结束，其它智能体排队（工具卡片显示「⏳ 等待屏幕控制权」）；非 GUI 工具和模型请求照常并行。
- 顶栏「🧩 并行」面板：屏幕控制权持有者与排队情况、所有工作中的智能体（对话 / 后台 / 委派，用时、步数、当前动作、进度条）、最近一次委派的**并行时间线**。

### 7×24 运行
| 功能 | 说明 |
| --- | --- |
| 托盘模式 | 关闭窗口后驻留托盘（打开 / 暂停定时任务 / 退出），定时任务继续运行 |
| 开机自启 | Windows / macOS 使用系统登录项，Linux 写入 `~/.config/autostart/*.desktop`；以 `--hidden` 启动到托盘 |
| 阻止休眠 | 控制电脑时 `prevent-display-sleep`；有运行中的对话 / 任务或启用的定时任务时 `prevent-app-suspension`（可关闭） |
| 崩溃自动恢复 | 渲染进程崩溃自动重建窗口；主进程未捕获异常时写 `crash.log` 并自动重启（10 分钟内最多 3 次，防止重启风暴） |
| 定时任务 | node-cron（支持秒级），结果写入聊天并弹出通知；勾选**无人值守**后自动批准该任务中的所有操作（含电脑控制），可在窗口关闭时自主完成 |

### 安全存储
- API Key 使用 Electron `safeStorage` 加密（Windows DPAPI / macOS Keychain / Linux libsecret），旧版明文自动迁移；渲染进程永远拿不到明文。
- Linux 没有可用密钥环时会回退为明文并在设置页提示。

## 安装与运行

```bash
cd assistant-desktop
npm install          # 国内可设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev          # 开发模式（热更新）
```

首次打开后点击左下角「⚙ 全局设置」，选择预设或填写 Base URL / API Key / 模型，保存并「测试连接」。
电脑控制需要支持视觉 + 工具调用的模型（如 GPT-4o、Grok 4 等）。

### 数据目录
| 系统 | 目录 |
| --- | --- |
| Windows | `%APPDATA%\AssistantDesktop\` |
| macOS | `~/Library/Application Support/AssistantDesktop/` |
| Linux | `~/.config/AssistantDesktop/` |

`state.json`（设置 / 助手 / 定时任务，密钥为密文）、`chats/<助手ID>.json`、`tasks.json`、`computer-log.json`、`crash.log`、`startup.log`。
可用环境变量 `ASSISTANT_USER_DATA=/path` 指定其它目录。

## 构建与测试

```bash
npm run typecheck   # 类型检查
npm run build       # 类型检查 + 构建到 out/
npm test            # 单元测试（vitest，含错误分类、JSON 修复、重试、能力检测、OCR 解析、控件检测、多智能体等）
npm run smoke       # 冒烟测试（需先 build）
npm run e2e         # 完整端到端测试（Linux：xvfb + dbus + gnome-keyring，见 e2e/run.sh）
```

端到端测试使用 Playwright 驱动**真实应用**和一个可编排的假 OpenAI 服务器（`e2e/fake-openai.mjs`），共 24 个场景：
流式对话、命令审批 / 拒绝、工具卡片、后台子任务、浏览器自动化、MCP、引导页与快速切换、搜索、托盘定时任务、
**真实电脑控制**（在虚拟显示器上启动 Chromium 测试页，真实地点击输入框、输入「Hello 电脑」、点击提交并截图确认）、
Ctrl+Alt+Esc 急停（xdotool 发送真实按键）、悬浮条停止按钮、窗口关闭时的无人值守定时任务、
**3 个智能体并行委派**（校验时间段重叠）、**两个智能体争用屏幕锁**、渲染进程 / 主进程崩溃恢复、语音输入、主题、密钥加密、重启持久化。
可用 `E2E_EXECUTABLE=release/linux-unpacked/assistant-desktop` 测试打包后的应用。

另外两套端到端测试：

```bash
E2E_SCRIPT=run-hardening.mjs bash e2e/run.sh   # 产品化：首次向导、错误与重试、畸形工具调用、上下文超长、OCR 模式、真实转发代理、检查更新、导出日志
MODEL_API_KEY=sk-... E2E_SCRIPT=run-real.mjs bash e2e/run.sh   # 真实模型（DeepSeek）：对话、命令审批、读写文件、网页抓取、记忆、子任务、3 智能体并行委派、定时任务、纯文本模型 OCR 电脑控制
```

## 打包发布

```bash
npm run dist:win     # Windows：NSIS 安装包 + 便携版 exe（Linux 上需要 wine，含 32 位 wine 用于 rcedit）
npm run dist:mac     # macOS：dmg + zip（需在 macOS 上构建）
npm run dist:linux   # Linux：AppImage + deb
```

`@nut-tree-fork/nut-js` 已包含 Windows / macOS / Linux 的预编译原生模块，打包时自动解包到 `app.asar.unpacked`。
正式分发建议进行代码签名（Windows 未签名的 exe 会触发 SmartScreen 提示）。

## 项目结构

```
src/main/
  index.ts              窗口、托盘、IPC、通知、悬浮条、急停快捷键、阻止休眠、崩溃恢复
  computerNative.ts     desktopCapturer 截图 + nut-js 鼠标键盘驱动
  overlay.ts            「正在控制电脑」悬浮条页面
  system.ts             开机自启
  core/
    agent.ts            智能体循环（审批、停止、急停、动态步数、屏幕锁）
    computer.ts         电脑控制工具定义与控制器（坐标换算、动作后自动截图）
    screenlock.ts       屏幕锁（FIFO、可重入、可取消）
    tasks.ts            后台任务 / 多智能体委派（并发上限、排队）
    toolhost.ts         工具注册、审批策略、委派工具
    crash.ts            崩溃日志与自动重启（频率限制）
    llm.ts tokens.ts tools.ts browser.ts mcp.ts scheduler.ts store.ts
src/renderer/src/components/
  Sidebar ChatView MessageItem ToolCallCard Mic ParallelPanel ComputerLogPanel TaskPanel GlobalSettings RoutinesView …
tests/                  vitest 单元测试
e2e/                    Playwright 端到端测试 + 假模型服务器
scripts/                冒烟测试、MCP 测试服务器
```

## 安全提示

- 电脑控制、`run_shell`、`write_file` 能完全操作你的电脑。信任模式和无人值守定时任务会跳过审批，请只用于你信任的任务，并记住 **Ctrl+Alt+Esc** 急停。
- 渲染进程启用 `contextIsolation` 与 `sandbox`，所有系统操作都在主进程完成；外部链接用系统浏览器打开。

## v0.7.0 新增：编号控件（Set-of-Mark）· 定位模型 · 用量与费用 · VNC 控制 Windows/macOS 虚拟机

### 1. 编号控件（Set-of-Mark）——点得更准
- **Windows**：内置 PowerShell + `System.Windows.Automation`（UI Automation）常驻助手进程，一次 `CacheRequest` 取前台窗口（或整个桌面）的控件树；有缓存、超时（超时自动重启进程）、深度/数量/时间上限，连续失败 3 次后熔断 60 秒并回退到 OCR。输入框支持 `ValuePattern` 直接设值（中文也可靠）。
- **Linux**：通过 AT-SPI（`python3-pyatspi`）读取控件树；本地 Linux 虚拟电脑镜像已内置 AT-SPI 总线，智能体可直接读到 Mousepad / GTK 程序的菜单、按钮、输入框。没有 AT-SPI 时自动退回「OCR + 矩形控件检测」。
- **合并**：无障碍元素优先，再并入矩形控件检测与 OCR 文字（去重、补名字），按阅读顺序编号（最多 200 个）。
- **给模型**：能看图的模型收到 **带彩色编号框的截图 + 精简元素列表**；纯文本模型（如 DeepSeek）收到元素列表 + OCR 文字。
- **新工具**：`get_ui_elements`、`click_element(编号)`、`type_into_element(编号, 文字)`、`click_target(描述)`；原有坐标工具全部保留。
- 设置 → 电脑控制：开关、范围（前台窗口 / 整个桌面）、当前感知引擎状态，以及「预览编号」（显示标注截图和模型收到的元素列表）。

### 2. 定位模型（grounding）
- 设置 → 定位模型：预设 **UI-TARS-1.5（本地 vLLM）**、**UI-TARS-1.5（OpenRouter，`bytedance/ui-tars-1.5-7b`）**、**UI-TARS v1（0–1000 相对坐标）**、**Fara-7B**、**使用主模型**、自定义。
- 自动换算坐标：UI-TARS-1.5 / Fara 使用 smart_resize 后的绝对像素（如 1280×800 → 1288×812），v1 使用 0–1000 相对坐标；兼容 `start_box`、`<point>`、`<|box_start|>`、Fara `tool_call` 等输出格式。
- 「测试定位」按钮：生成一张随机摆放红色按钮的测试图，检查模型给出的点是否落在目标上，并把结果画出来。
- `click_target`：先问定位模型；未配置或失败时按元素列表名称匹配。定位模型的调用也计入用量。

### 3. 用量与费用
- 请求带 `stream_options.include_usage`，读取 DeepSeek 的 `prompt_cache_hit_tokens / prompt_cache_miss_tokens`；服务商不支持时自动去掉该参数重试，未返回用量时按字数估算并标注。
- 按 **每条回复 / 每个任务（智能体）/ 每个定时任务 / 每天 / 每个模型** 累计，保存在本机 `usage.json`。
- **价格表可编辑**（每百万 token，USD 或 CNY）。默认内置 DeepSeek（已核对官网）：
  - deepseek-v4-flash：低谷 命中 $0.003 / 未命中 $0.15 / 输出 $0.60；高峰翻倍。
  - deepseek-v4-pro：低谷 命中 $0.022 / 未命中 $0.66 / 输出 $1.98；高峰翻倍。
  - 高峰时段：UTC 01:00–04:00、06:00–10:00（北京时间 09:00–12:00、14:00–18:00），周一至周五。
- 显示位置：每条回复下方的用量行（输入 / 缓存命中率 / 输出 / 费用 ≈ 人民币）、「并行」面板今日用量与每个任务费用、定时任务卡片、全新的 **「用量」页**（今天 / 7 天 / 30 天 / 累计、近 30 天每日柱状图、按模型 / 助手 / 定时任务、最近调用）。
- **预算**：单任务美元上限、每日美元上限、单任务 token 上限。超出时智能体在下一次调用模型前暂停，并显示中文提示；提高上限后点「继续」即可接着做。

### 4. VNC 控制 Windows / macOS 虚拟机
- 内置纯 Node 的 VNC（RFB 3.3/3.7/3.8）客户端：无认证或 VNC 密码（内置纯 JS DES，不依赖 OpenSSL 的 legacy 算法），Raw / CopyRect / DesktopSize 编码。
- Windows / macOS 虚拟机通过 dockur 已有 Web 端口上的 `/websockify`（nginx → QEMU 内置 VNC）控制，**无需重建容器**；智能体可截图、点击、输入、按键、使用编号控件。符号自动按美式键盘加 Shift；通过 VNC 无法直接输入中文，会给出明确的中文提示。
- Linux 虚拟电脑可选「docker exec + xdotool」（默认）或「VNC」控制方式。
- **规则不变：选中虚拟机时，VNC 不可用就直接报错，绝不悄悄改为控制本机。** 应用重启后会自动刷新虚拟机的运行状态。

### 其它
- 诊断导出新增：用量摘要、预算、价格表、编号/UIA/AT-SPI 状态、定位模型配置（不含密钥）、VNC 会话信息。
- 修复：Linux 虚拟电脑里 `key_press` 的按键名（enter / escape / 方向键等）现在正确映射为 X keysym。
- 全局设置顶部新增分区导航。

### 已知限制
- Windows UIA 助手只在单元测试中验证了解析与合并逻辑，本版本的测试环境是 Linux，尚未在真实 Windows 上跑过。
- Windows / macOS 虚拟机的完整安装需要 KVM、约 70 GB 磁盘和 4 GB 以上内存；测试中用 dockur 的同源基础镜像 `qemux/qemu`（引导 Alpine）验证了同一条 `/websockify` VNC 通道。
- 通过 VNC 只能输入 ASCII 字符（QEMU 只转发键盘扫描码）。

## v0.6.0 新增：本地虚拟电脑可选 Linux / Windows / macOS 桌面

右侧「电脑 → 虚拟电脑」现在先显示 **选择系统** 卡片（参考 Devin / Grok Bot 的卡片式选择）：每张卡片有系统图标、简介、资源要求和状态徽标（未创建 / 下载中 / 安装中 / 运行中 / 已休眠 / 已停止 / 需要 Docker / 需要 KVM / 出错）。上次选择会被记住。

| 系统 | 后端 | 查看器端口（宿主，仅 127.0.0.1） | 资源 | 是否需要 KVM |
| --- | --- | --- | --- | --- |
| **Linux 桌面** | 本应用自带 Ubuntu 24.04 + XFCE + noVNC 镜像（与 0.5.x 完全兼容，沿用容器 `assistant-desktop-vm`） | 6080（VNC 5900） | 约 2 GB 内存，磁盘 ≥5 GB | 否 |
| **Windows 桌面** | 开源 [dockur/windows](https://github.com/dockur/windows)（镜像 `dockurr/windows`），首次启动自动下载并无人值守安装 | 8006（RDP 13389） | 默认 4 GB 内存 / 2 核 / 64 GB 磁盘，磁盘剩余 ≥70 GB | 是 |
| **macOS 桌面** | 开源 [dockur/macos](https://github.com/dockur/macos)（镜像 `dockurr/macos`），自动下载恢复镜像，在桌面里完成安装 | 8007 → 容器 8006 | 默认 4 GB 内存 / 2 核 / 64 GB 磁盘，磁盘剩余 ≥70 GB，CPU 需支持 AVX2 | 是 |

- **多台共存**：每个系统一台，容器名（`assistant-desktop-vm` / `assistant-desktop-win` / `assistant-desktop-mac`）、磁盘卷（`assistant-desktop-win-storage` / `assistant-desktop-mac-storage`）和端口互不冲突；首选端口被占用时自动顺延（如 8006 → 18006）。
- **版本与资源**：Windows 可选 11 / 11 LTSC / 11 企业版 / 10 / 10 LTSC / 10 企业版 / Server 2025 / 2022 / 2019 / Tiny11（上游 `VERSION`），并可设置内存、CPU、磁盘、语言（默认中文，上游 `LANGUAGE`）；macOS 可选 15 Sequoia / 14 Sonoma / 13 Ventura / 12 Monterey / 11 Big Sur。默认 Windows 账户为 `Docker` / 密码 `admin`（上游默认）。
- **每台虚拟电脑的操作**：打开桌面（应用内嵌查看器）/ 在浏览器打开 / 休眠（`docker pause`，内存状态保留，秒级唤醒）/ 停止（`docker stop`，Windows/macOS 会先发 ACPI 关机，最长约 2 分钟）/ 删除（可选择是否同时删除系统磁盘卷）/ 强制重建（Linux 重新构建镜像；Windows/macOS 重新拉取镜像并重建容器，磁盘保留）。
- **安装进度**：Windows/macOS 首次启动时读取容器日志，显示「下载系统镜像 xx% / 解压 / 启动虚拟机 / 已就绪」。
- **智能体控制目标**：「设为目标」把某台虚拟电脑设为电脑控制目标，助手设置页也可选择「虚拟电脑系统」并显示当前控制目标；系统提示词会告诉模型当前目标是哪台机器。**Linux 桌面支持自动键鼠控制**；Windows / macOS 桌面目前仅支持在内嵌桌面中手动操作——选中它们时电脑控制工具会返回清楚的中文说明，**绝不会回落去操作你的真实桌面**。本机 / 远程控制不受影响。
- **诊断导出**：日志包列出全部三台虚拟电脑的状态、端口、配置、预检结果和容器日志尾部。

### 预检（每个系统分别检查）

启动前会检查：Docker CLI 与引擎是否运行；磁盘剩余（Linux ≥5 GB、Windows ≥70 GB、macOS ≥70 GB；已创建过的虚拟电脑只给警告）；**KVM**（仅 Windows / macOS）；端口冲突（自动改用空闲端口）。KVM 缺失时会直接给出中文原因和修复步骤，而不是让容器报晦涩错误：

**Windows 电脑（宿主）上运行 Windows / macOS 虚拟电脑的要求**
1. 宿主系统必须是 **Windows 11**（Windows 10 上的 Docker Desktop 不向容器提供 KVM，上游明确不支持）；
2. BIOS/UEFI 中开启 Intel VT-x / AMD-V；
3. 管理员 PowerShell：`wsl --update`，然后 `wsl --shutdown`；
4. 在 `%UserProfile%\.wslconfig` 中写入：
   ```ini
   [wsl2]
   nestedVirtualization=true
   ```
5. Docker Desktop → Settings → General 勾选「Use the WSL 2 based engine」，重启 Docker Desktop；
6. 验证：`docker run --rm --device /dev/kvm alpine ls -l /dev/kvm` 能列出设备即可；
7. 若本机本身是云主机/虚拟机，需云厂商开启「嵌套虚拟化」。

**Linux 宿主**：`/dev/kvm` 存在且当前用户可读写（`sudo usermod -aG kvm $USER` 后重新登录）；请使用 Docker Engine（Docker Desktop for Linux 不向容器提供 KVM）。
**Mac 宿主**：Docker Desktop for Mac 不提供 KVM，无法运行 Windows / macOS 虚拟电脑，请使用 Linux 桌面。

容器参数严格按上游 compose：`--device /dev/kvm --device /dev/net/tun --cap-add NET_ADMIN -v <卷>:/storage --stop-timeout 120`，宿主工作目录挂载到 `/shared`（Windows 桌面上显示为 `Shared` 文件夹 / Z: 盘；macOS 需在终端执行 `sudo -S mount_9p shared`）。`docker run` 参数由纯函数 `buildDockerRunArgs()`（`src/shared/vmProfiles.ts`）生成并有单元测试。

### 许可说明
- **macOS**：Apple 的最终用户许可协议只允许在 **Apple 硬件** 上安装运行 macOS。dockur/macos 本身是开源代码、不分发 macOS，但在非 Apple 硬件上运行违反 Apple 条款——是否使用请自行判断（卡片上有同样提示）。
- **Windows**：由 dockur 从微软官方服务器下载安装介质；激活与授权需你自行拥有合法许可证。
- dockur/windows、dockur/macos 为第三方开源项目（MIT），本应用仅调用其公开镜像，未修改或分发其代码。

## v0.5.2 变更

### 第 1 轮（VM 体验 + 去掉假按钮）
- **启动 Docker Desktop**：Windows 检测到已安装但未运行时，可一键启动常见路径下的 Docker Desktop.exe，并轮询引擎就绪（约 90 秒）。
- **一键打开 Docker 官网下载**：需要 Docker 时提供官网下载按钮。
- **去掉假按钮**：本机「打开桌面 / 休眠」改为清晰内联提示；虚拟电脑就绪时打开 noVNC，休眠调用容器 stop。
- **Slack 默认频道**：ChannelsView 输入真正写入通道设置。
- **docker build 进度**：构建 stderr/stdout 尾部摘要刷到状态进度。

### 第 2 轮（预检与硬化）
- **启动预检**：build/run 前检查 Docker CLI+引擎、磁盘剩余、配方目录（非 asar）、端口 6080（冲突仅警告）。
- **智能恢复**：镜像已有且容器停止时 `docker start`，不强制 rebuild；提供「强制重建镜像」。
- **诊断导出**：日志包附带 localVm status、detectDocker、preflight 摘要（脱敏）。
- 安装包缺配方提示改为「请重装最新安装包」（不再写死 0.5.1）。

## v0.5.1 修复

- **Windows 虚拟电脑构建**：不再把 `app.asar` 内路径交给 `docker build`；优先使用 `extraResources` 的 `resources/local-vm`，并在构建前复制到 `userData/local-vm-context`。
- **Docker Desktop 检测**：Windows 检查 `docker version`、Desktop 进程与 WSL；缺少 CLI 时停留在「需要 Docker」，不尝试构建。
- 安装包缺配方时提示：安装包缺少虚拟电脑配方，请重装最新安装包。

## v0.5.0 要点

- 自有消息壳 UI（能力对齐公开 OpenMausBot 文档，**不**克隆其界面/源码）
- **一键本地虚拟电脑**：检测 Docker → 构建/启动 Linux 桌面容器 → 自动中文/Firefox/工作目录挂载 → 电脑控制指向 VM → 打开桌面 / 休眠
- Ask/Auto、模型选择器、连接器市场、自动化入口、电脑面板实时预览

### Out of MVP（相对完整 OpenMausBot）
无云端 Box / Composio 五百应用 / 公网 Webhook 隧道；本机「打开桌面/休眠」为系统提示，虚拟电脑侧为实装。

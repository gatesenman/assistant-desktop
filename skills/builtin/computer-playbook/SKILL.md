---
id: builtin/computer-playbook
name: 电脑操作手册
description: 安全地使用电脑控制：先截屏/OCR 理解界面，再小步点击输入，每步确认；纯文本模型走 OCR 模式。
triggers: 电脑, 点击, 桌面, 操作屏幕
tools: computer_screenshot, find_text_on_screen, mouse_click, type_text, open_app, open_url, list_windows
---

# 电脑操作手册

1. 先 `computer_screenshot`（或 OCR 文字描述）弄清当前界面。
2. 优先 `find_text_on_screen` 定位按钮/输入框，再点击；避免盲点坐标。
3. 每次只做一小步，观察返回的新截图/描述再继续。
4. 涉及支付、删除、发送消息等不可逆操作前必须停下来问用户。
5. 远程机器时说明当前目标机器，不要假设本机。

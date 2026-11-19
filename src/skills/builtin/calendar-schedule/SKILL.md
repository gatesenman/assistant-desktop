---
id: builtin/calendar-schedule
name: 日程安排
description: 查看未来日程、检测冲突、提议可开会时段并创建事件（需确认）。
triggers: 日历, 日程, 开会, 预约
tools: gcal_list, gcal_create, mscal_list, mscal_create
---

# 日程安排技能

1. 列出未来 7 天日程。
2. 若用户要约时间：找出空闲块（默认工作日 10:00–18:00，时区 Asia/Shanghai）。
3. 提出 2–3 个候选时段，用户选定后再创建日历事件。
4. 创建时使用 RFC3339，并写清会议主题与参与者备注。

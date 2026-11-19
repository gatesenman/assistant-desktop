---
id: builtin/research-report
name: 调研报告
description: 针对主题做网页检索与抓取，汇总成带出处的中文简报；耗时可拆后台子任务。
triggers: 调研, 报告, 研究, 竞品
tools: web_fetch, browser_open, browser_get_text, spawn_task, delegate_to_agent
---

# 调研与报告技能

1. 澄清范围（市场/竞品/技术）与输出长度。
2. 用 web_fetch / 浏览器打开 3–8 个权威来源，记录 URL。
3. 结构：背景 → 关键发现（条目+来源）→ 风险/机会 → 建议下一步。
4. 长任务用 spawn_task 或 delegate_to_agent 并行搜集，最后汇总。

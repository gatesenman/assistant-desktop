---
id: builtin/email-triage
name: 邮件分拣
description: 阅读最近邮件，按紧急/待办/可归档分类，并起草回复草稿（不直接发送除非用户确认）。
triggers: 邮件, 邮箱, 收件箱, 分拣
tools: email_list, email_read, gmail_list, email_send, gmail_send
---

# 邮件分拣技能

1. 用邮箱连接器工具拉取最近 10–20 封邮件标题。
2. 分类为：紧急（今天必须处理）、待办（本周）、可归档、垃圾/订阅。
3. 对「紧急」和「待办」各起草一条简短中文回复草稿，**先展示给用户确认**，未确认不要调用发送工具。
4. 输出一张 Markdown 表格：分类 | 发件人 | 主题 | 建议动作。

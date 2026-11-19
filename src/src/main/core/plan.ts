/** 电脑操控计划：从用户目标启发式拆步，也可由模型返回后覆盖 */
export function heuristicPlan(goal: string): string {
  const g = String(goal || '').trim() || '完成用户电脑操作请求'
  const lines = [
    '## 执行计划',
    `目标：${g}`,
    '',
    '1. 截图并识别当前窗口 / 关键控件（优先编号元素）',
    '2. 按目标定位入口（应用、菜单、页面）',
    '3. 逐步执行操作，每步后核对截图',
    '4. 遇到登录 / 验证码 / 付款时调用 ask_user 或请求用户接管',
    '5. 完成后用简短文字汇报结果',
    '',
    '（可编辑此计划后点「确认执行」；设置中可开启自动确认）'
  ]
  return lines.join('\n')
}

/**
 * 每 everyN 步做一次截图核对。everyN<=0 关闭。
 * 打开应用 / URL 等「阶段切换」动作额外触发一次（不按点击逐步打断）。
 */
export function shouldReflect(step: number, everyN: number, toolName: string): boolean {
  if (!everyN || everyN <= 0) return false
  if (step > 0 && step % everyN === 0) return true
  return /^(open_app|open_url)$/.test(toolName)
}

export const REFLECT_PROMPT =
  '请根据最新截图核对：上一步是否达到预期？若未达到，简要说明原因并给出修正计划（仍用工具继续）；若已达到，继续下一步。'

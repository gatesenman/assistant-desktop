import type { ProviderPreset } from './types'

/** 常用服务商预设（OpenAI 兼容接口），中国大陆可直连的放在前面 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys', envKey: 'DEEPSEEK_API_KEY' },
  { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1', envKey: 'DASHSCOPE_API_KEY' },
  { id: 'moonshot', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k-vision-preview', keyUrl: 'https://platform.moonshot.cn/console/api-keys', envKey: 'MOONSHOT_API_KEY' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', envKey: 'ZHIPUAI_API_KEY' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', keyUrl: 'https://platform.openai.com/api-keys', needsProxy: true, envKey: 'OPENAI_API_KEY' },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', keyUrl: 'https://console.x.ai', needsProxy: true, envKey: 'XAI_API_KEY' },
  { id: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', noKey: true },
  { id: 'custom', name: '其他 OpenAI 兼容接口', baseUrl: '', model: '' }
]


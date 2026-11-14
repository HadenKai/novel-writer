import type { ModelConfig } from '../types'

/**
 * 思考强度档位（模型选择器的滑杆用）。
 * 取值与 server/models.mjs 的 normalizeModel 白名单一致：
 *  - Gemini：thinkingLevel = LOW / MEDIUM / HIGH（缺省 MEDIUM）
 *  - OpenAI 兼容：reasoningEffort = default / low / medium / high（default 表示不发该参数，交给服务端决定）
 *  - 本地部署：本机推理服务基本不认这些参数，滑杆停用
 */
export interface ThinkingStep {
  value: string
  label: string
}

const GEMINI_STEPS: ThinkingStep[] = [
  { value: 'LOW', label: '低' },
  { value: 'MEDIUM', label: '中' },
  { value: 'HIGH', label: '高' }
]

const EFFORT_STEPS: ThinkingStep[] = [
  { value: 'default', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' }
]

export function thinkingSteps(m?: ModelConfig | null): ThinkingStep[] {
  if (!m || m.local) return []
  return m.provider === 'gemini' ? GEMINI_STEPS : EFFORT_STEPS
}

export function thinkingValue(m?: ModelConfig | null): string {
  if (!m) return ''
  return m.provider === 'gemini' ? m.thinkingLevel || 'MEDIUM' : m.reasoningEffort || 'default'
}

export function thinkingLabelOf(m?: ModelConfig | null, value = thinkingValue(m)): string {
  return thinkingSteps(m).find(s => s.value === value)?.label || ''
}

/** 只改思考档位的 PUT 载荷：后端整条替换，必须带全字段；掩码密钥原样回传，后端会沿用原密钥 */
export function withThinking(m: ModelConfig, value: string): Partial<ModelConfig> {
  // stationName / hasKey 是列表接口的展示字段，不属于模型本身，别写回 models.json
  const { stationName: _s, hasKey: _h, ...rest } = m
  return m.provider === 'gemini'
    ? { ...rest, thinkingLevel: value as ModelConfig['thinkingLevel'] }
    : { ...rest, reasoningEffort: value as ModelConfig['reasoningEffort'] }
}

/** 某页改了模型配置后广播出去，其余页面的 useModels 就地合并，不必重新进页面 */
export const MODEL_UPDATED_EVENT = 'writer-model-updated'

export function broadcastModelUpdate(m: ModelConfig) {
  window.dispatchEvent(new CustomEvent<ModelConfig>(MODEL_UPDATED_EVENT, { detail: m }))
}

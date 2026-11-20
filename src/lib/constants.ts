import { thinkingValue } from './thinking'

export const GENRES = ['玄幻', '仙侠', '都市', '言情', '历史', '科幻', '悬疑', '奇幻', '游戏', '现实', '军事', '轻小说']

export const WORD_OPTIONS = [1500, 2000, 2500, 3000, 4000]

/**
 * 思考档位短标签（唯一口径，与模型设置页一致）：
 * Gemini 用 thinkingLevel，其他模型使用 reasoningEffort。
 * 与 server/models.mjs 的实际发参逻辑对应，改动需同步。
 */
export function thinkingShortLabel(m: Parameters<typeof thinkingValue>[0]): string {
  const r = thinkingValue(m)
  if (r === 'xhigh') return '极高 (Xhigh)'
  if (r === 'max') return '最高 (Max)'
  return r === 'default' ? 'Default' : r
}

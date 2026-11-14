export const GENRES = ['玄幻', '仙侠', '都市', '言情', '历史', '科幻', '悬疑', '奇幻', '游戏', '现实', '军事', '轻小说']

export const WORD_OPTIONS = [1500, 2000, 2500, 3000, 4000]

/**
 * 思考档位短标签（唯一口径，与模型设置页一致）：
 * gemini 系用 thinkingLevel（LOW/MEDIUM/HIGH），其它用 reasoningEffort（Default/low/medium/high）。
 * 与 server/models.mjs 的实际发参逻辑对应，改动需同步。
 */
export function thinkingShortLabel(
  m?: { provider?: string; reasoningEffort?: string; thinkingLevel?: string } | null
): string {
  if (!m) return ''
  if (m.provider === 'gemini') return m.thinkingLevel || 'MEDIUM'
  const r = m.reasoningEffort || 'default'
  return r === 'default' ? 'Default' : r
}

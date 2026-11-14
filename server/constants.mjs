// 生成任务的统一参数。
// 原先 maxTokens 在 app.mjs 里硬编码 6 处（195 / 941 / 972 / 1055 / 2914 / 3610），
// 调整时极易漏改，这里收口成一个来源。
export const MAX_TOKENS = 16384

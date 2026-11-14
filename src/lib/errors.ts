/**
 * 错误文案的单一真源。
 *
 * 原先同一套 HTTP 状态码在前后端各维护一份（server/app.mjs 的 upstreamFailHint、
 * 前端 pages/butler/constants.tsx 的 describeModelError），改一处忘一处就会给出
 * 误导性提示（例如模型 403 被说成「本地服务授权失效」）。
 *
 * 这里把两档错误分开：
 *  - 上游模型错误：按状态码给出作者能照着做的动作，并保留原始信息便于反馈；
 *  - 本地服务错误：401 多为多实例并存导致的授权不一致，需要重启应用。
 */
import type { GenJob } from '../types'

/** 上游模型错误（按 HTTP 状态码）→ 可照做的中文提示 */
const UPSTREAM_HINT: Record<number, string> = {
  401: '模型服务鉴权失败（401）。请到「模型设置」检查该中转站的 API Key 是否有效、是否过期。',
  403: '模型服务拒绝访问（403）。API Key 有效但没有该模型的权限，请检查账号权限或用其它模型。',
  404: '模型不存在（404）。该中转站没有这个模型名，请在「模型设置」核对模型名与接口地址。',
  400: '模型服务拒绝请求（400）。通常是模型名不对、参数不被该模型支持，或提示词超出上下文长度。',
  429: '请求过于频繁或额度不足（429）。请稍后重试，或检查中转站余额。'
}

/**
 * 把任务失败翻译成作者能照着排查的一句话。
 *
 * 按 errorStatus 分开说明，未知情况回落到原始错误文本。
 */
export function describeModelError(job: Pick<GenJob, 'error' | 'errorStatus'>): string {
  const hint = job.errorStatus ? UPSTREAM_HINT[job.errorStatus] : undefined
  return hint ? `${hint}\n\n原始信息：${job.error}` : job.error
}

/** 本地服务返回非 2xx 时的提示（raw 为服务端 body 里的 error 字段或默认文案） */
export function describeHttpError(status: number, raw: string): string {
  if (status === 401) return '本地服务授权失效：请完全退出当前应用后重新启动，不要同时打开旧版本。'
  if (status === 403) return `本地服务拒绝了请求：${raw}`
  return raw
}

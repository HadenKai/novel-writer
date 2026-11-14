// 研讨页状态驻留：输入草稿 + 选段 + 滚动位置，按「书 + 会话」保存。
// 组件会因路由切换被卸载，靠模块内存 + sessionStorage 保持「离开再回来」时的页面状态；
// 多会话下每会话各存一份草稿，互不干扰。
export interface ChatDraft {
  input: string
  selChapter: number
  selParas: number[]
}

const KEY = (id: string, sid?: string) => `chatDraft:${id}:${sid || '_'}`
const SK = (id: string, sid?: string) => `chatScroll:${id}:${sid || '_'}`
const LK = (id: string) => `chatLastSession:${id}`
const mem = new Map<string, ChatDraft>()

export function getChatDraft(id: string, sid?: string): ChatDraft {
  const k = KEY(id, sid)
  const hit = mem.get(k)
  if (hit) return hit
  try {
    const raw = sessionStorage.getItem(k)
    if (raw) {
      const d = JSON.parse(raw) as ChatDraft
      if (d && typeof d.input === 'string' && typeof d.selChapter === 'number') {
        const norm: ChatDraft = {
          input: d.input,
          selChapter: d.selChapter > 0 ? Math.floor(d.selChapter) : 0,
          selParas: Array.isArray(d.selParas) ? [...new Set(d.selParas.map(Number).filter(n => n > 0))] : []
        }
        mem.set(k, norm)
        return norm
      }
    }
  } catch {
    /* 忽略损坏数据 */
  }
  const empty: ChatDraft = { input: '', selChapter: 0, selParas: [] }
  mem.set(k, empty)
  return empty
}

export function setChatDraft(id: string, patch: Partial<ChatDraft>, sid?: string): void {
  const k = KEY(id, sid)
  const d = { ...getChatDraft(id, sid), ...patch }
  mem.set(k, d)
  try {
    sessionStorage.setItem(k, JSON.stringify(d))
  } catch {
    /* 忽略 */
  }
}

export function setChatScroll(id: string, top: number, sid?: string): void {
  try {
    sessionStorage.setItem(SK(id, sid), String(Math.round(top)))
  } catch {
    /* 忽略 */
  }
}

export function getChatScroll(id: string, sid?: string): number {
  try {
    const v = Number(sessionStorage.getItem(SK(id, sid)))
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch {
    return 0
  }
}

// ── 记住每本书最后停留的会话，重新进入时直接续上 ──
export function getLastSession(id: string): string {
  try {
    return sessionStorage.getItem(LK(id)) || ''
  } catch {
    return ''
  }
}

export function setLastSession(id: string, sid: string): void {
  try {
    sessionStorage.setItem(LK(id), sid)
  } catch {
    /* 忽略 */
  }
}

// ── 管家授权开关：跨页面 / 跨会话驻留 ──
// 组件会随路由切换卸载，这组开关必须落在 localStorage，否则「切页回来又变回未勾选」。
export interface AgentFlags {
  /** 允许管家代改与执行 */
  butler: boolean
  /** 允许危险操作（删书/删章/清空正文等） */
  allowDangerous: boolean
}

const FK = 'chatAgentFlags'
const DEFAULT_FLAGS: AgentFlags = { butler: true, allowDangerous: false }
let flagsMem: AgentFlags | null = null

export function getAgentFlags(): AgentFlags {
  if (flagsMem) return flagsMem
  try {
    const raw = localStorage.getItem(FK)
    if (raw) {
      const d = JSON.parse(raw) as Partial<AgentFlags>
      flagsMem = {
        butler: typeof d.butler === 'boolean' ? d.butler : DEFAULT_FLAGS.butler,
        allowDangerous: typeof d.allowDangerous === 'boolean' ? d.allowDangerous : DEFAULT_FLAGS.allowDangerous
      }
      return flagsMem
    }
  } catch {
    /* 忽略损坏数据 */
  }
  flagsMem = { ...DEFAULT_FLAGS }
  return flagsMem
}

export function setAgentFlags(patch: Partial<AgentFlags>): void {
  const next = { ...getAgentFlags(), ...patch }
  flagsMem = next
  try {
    localStorage.setItem(FK, JSON.stringify(next))
  } catch {
    /* 忽略 */
  }
}

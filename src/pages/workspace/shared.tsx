// Workspace 各子组件共用的样式常量、图标与剧情线枚举。
// 从 Workspace.tsx 拆出，避免每个组件各写一份 className 字符串。
// 墨金：表面与输入直接用 ui.css 的原语（.ink-card / .ink-input），不再各写一套。
import type { Plotline } from '../../types'

export const inputCls = 'ink-input'
export const labelCls = 'plan-label'
export const cardCls = 'ink-card'

/**
 * 图标按钮的统一样式。
 *
 * 两点考虑：
 * 1) 命中区——纯图标按钮视觉上只有 24px，但鼠标很难精确点中。这里统一给到
 *    `h-7 w-7`（28px），并在图标外留出内边距，接近移动端 32px 的可点标准；
 * 2) 无障碍——纯图标按钮没有文本内容，屏幕阅读器只会念出「按钮」。
 *    调用方必须补 `aria-label`（见下方 iconBtn 的使用约定）。
 */
export const iconBtn =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]'
/** 图标按钮的危险态（删除）：hover 时染朱砂 */
export const iconBtnDanger = `${iconBtn} hover:bg-[color-mix(in_srgb,var(--seal-fill)_12%,transparent)] hover:!text-[var(--seal)]`

export const PLOT_TYPES = ['主线', '感情线', '成长线', '事业线', '悬念线', '阴谋线', '支线']
export const PLOT_STATUS: { key: Plotline['status']; label: string }[] = [
  { key: 'pending', label: '待开始' },
  { key: 'active', label: '进行中' },
  { key: 'paused', label: '暂停' },
  { key: 'done', label: '已收束' }
]
export const STATUS_COLOR: Record<Plotline['status'], string> = {
  pending: 'text-[var(--text-faint)]',
  active: 'text-[var(--jade)]',
  paused: 'text-[var(--gold)]',
  done: 'text-[var(--text-faint)] line-through'
}
/** 剧情线状态胶囊（.ink-status 变体）：进行中竹青、暂停鎏金，其余中性 */
export const STATUS_TONE: Record<Plotline['status'], string> = {
  pending: '',
  active: 'ink-status--jade',
  paused: 'ink-status--gold',
  done: ''
}

/** 泳道色条：主线鎏金、感情线竹青、悬念线朱砂，其余中性 */
export function plotTone(type: string): 'gold' | 'jade' | 'seal' | 'neutral' {
  if (type === '主线') return 'gold'
  if (type === '感情线') return 'jade'
  if (type === '悬念线') return 'seal'
  return 'neutral'
}

/** 把「坚韧、聪慧，孤傲」拆成性格标签（顿号 / 逗号 / 空格分隔），最多 max 个 */
export function splitTraits(text: string, max = 3): string[] {
  return (text || '')
    .split(/[、，,；;\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, max)
}

/** 生成一个本地唯一 id（剧情线节点用） */
export function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

/** 小号描边图标：1.5 线宽，用在行内操作（上移、删除、加号） */
export function SIcon({
  name,
  size = 13,
  className = ''
}: {
  name: 'x' | 'check' | 'chevron' | 'pencil' | 'up' | 'down' | 'plus'
  size?: number
  className?: string
}) {
  const paths: Record<string, string> = {
    x: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    chevron: 'M9 6l6 6-6 6',
    pencil: 'M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20z',
    up: 'M18 14l-6-6-6 6',
    down: 'M6 10l6 6 6-6',
    plus: 'M12 5v14M5 12h14'
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  )
}

const ICONS = {
  doc: ['M7 3.5h7l4 4v13H7z', 'M14 3.5v4h4', 'M9.5 12h6M9.5 15.5h6'],
  user: ['M12 4.5a3.75 3.75 0 1 1 0 7.5a3.75 3.75 0 1 1 0-7.5z', 'M5 20c.8-3.7 3.6-5.6 7-5.6s6.2 1.9 7 5.6'],
  globe: [
    'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17z',
    'M3.5 12h17',
    'M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z'
  ],
  brush: ['M20 4c-7.5.3-12.4 5-13.6 12.2L4.5 20', 'M6.4 16.2c5 .2 8.9-2.8 10.4-7.4', 'M9.6 12.6h4.6'],
  book: [
    'M4 5.5c2.8-1 5.5-.7 8 1.1v13c-2.5-1.8-5.2-2.1-8-1.1z',
    'M20 5.5c-2.8-1-5.5-.7-8 1.1v13c2.5-1.8 5.2-2.1 8-1.1z'
  ],
  sparkle: [
    'M11 3.5l1.7 5.3 5.3 1.7-5.3 1.7L11 17.5l-1.7-5.3L4 10.5l5.3-1.7z',
    'M18 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'
  ],
  send: ['M4 11.5L20 4l-6 16-2.8-6.7z', 'M11.2 13.3L20 4'],
  clipboard: ['M9 4h6v3H9z', 'M9 5.5H6v15h12v-15h-3', 'M9 11h6M9 14.5h6M9 18h3.5'],
  mountain: ['M2.5 19.5h19', 'M4 19.5l5-8.2 3.2 4.8 2.6-3.7 5.2 7.1', 'M17 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z'],
  flame: ['M12 3.5c.6 3.2-4 5.3-4 9.6a4 4 0 0 0 8 0c0-1.7-.7-2.9-1.7-3.9.1 1.6-.6 2.7-1.7 3 1-3 .3-6.2-.6-8.7z'],
  rules: ['M5.5 5.5h13M5.5 10h13M5.5 14.5h6.5', 'M14.5 17l2 2 3.5-3.8'],
  minus: ['M6 12h12'],
  expand: ['M14 4.5h5.5V10', 'M19.5 4.5L13.5 10.5', 'M10 19.5H4.5V14', 'M4.5 19.5l6-6'],
  chevronDown: ['M6 9.5l6 6 6-6'],
  edit: ['M4.5 19.5l1-4.2L15.6 5.2l3.2 3.2L8.7 18.5z', 'M13.6 7.2l3.2 3.2'],
  open: ['M13.5 4.5h6v6', 'M19.5 4.5l-8 8', 'M17.5 14v5.5h-13v-13H10'],
  search: ['M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13z', 'M15.5 15.5l4.5 4.5'],
  trash: ['M4.5 7h15', 'M9.5 4h5', 'M6.5 7l.9 13h9.2l.9-13', 'M10.2 10.5v6M13.8 10.5v6'],
  camera: ['M4 8.5h3.2l1.6-2.5h6.4l1.6 2.5H20v10.5H4z', 'M12 10.5a3.2 3.2 0 1 1 0 6.4a3.2 3.2 0 1 1 0-6.4z']
} satisfies Record<string, string[]>

export type IconName = keyof typeof ICONS

/** 墨金线性图标：1.5 线宽、currentColor，16–18px；纯装饰，一律 aria-hidden */
export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      {ICONS[name].map(d => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

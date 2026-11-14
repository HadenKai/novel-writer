import type { SVGProps } from 'react'

/** 写作页（书稿目录、稿面工具栏、AI 写作抽屉）共用的线性图标：1.5px 描边、currentColor、纯装饰 */
function Icon({ size = 17, children, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 目录 / 专注 / 资料 三个视图开关 */
export function PanelIcon({ side }: { side: 'left' | 'right' | 'focus' }) {
  return (
    <Icon size={16}>
      {side === 'focus' ? (
        <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
      ) : (
        <>
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
          <path d={side === 'left' ? 'M7.5 4v12' : 'M12.5 4v12'} />
        </>
      )}
    </Icon>
  )
}

export function SearchIcon() {
  return (
    <Icon size={16}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.2 13.2 3.8 3.8" />
    </Icon>
  )
}

export function CloseIcon() {
  return (
    <Icon size={16}>
      <path d="M5 5l10 10M15 5 5 15" />
    </Icon>
  )
}

/** AI 写作的「✦」：四角星 + 一点星芒 */
export function SparkIcon({ size = 16 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M8.5 2.5c.5 3.6 2.4 5.5 6 6-3.6.5-5.5 2.4-6 6-.5-3.6-2.4-5.5-6-6 3.6-.5 5.5-2.4 6-6Z" />
      <path d="M15.5 13v4M13.5 15h4" />
    </Icon>
  )
}

/** 起草：笔尖落在纸上 */
export function QuillIcon() {
  return (
    <Icon size={18}>
      <path d="m12.5 3.5 4 4-8 8H4.5v-4l8-8Z" />
      <path d="m10.5 5.5 4 4" />
      <path d="M11 17.5h6" />
    </Icon>
  )
}

/** 续写：已有的行 + 往下接的箭头 */
export function ContinueIcon() {
  return (
    <Icon size={18}>
      <path d="M3.5 5h13M3.5 9h13M3.5 13h6" />
      <path d="M12.5 13h4m-1.8-2 2 2-2 2" />
    </Icon>
  )
}

/** 润色：毛笔一抹 */
export function PolishIcon() {
  return (
    <Icon size={18}>
      <path d="M16.5 3.5c-3.2 1.6-6 4.4-7.6 7.4l1.7 1.7c3-1.6 5.8-4.4 7.4-7.6" />
      <path d="M8.9 10.9c-2.2-.2-3.6 1.2-3.8 3-.2 1.4-.9 2.2-1.6 2.6 2.4.6 5.6.2 6.9-2.5.4-.9.4-1.7.2-2.3" />
    </Icon>
  )
}

/** 改写：两股交叉的箭头 */
export function ReviseIcon() {
  return (
    <Icon size={18}>
      <path d="M3 6h3.2c1.6 0 3 .8 3.8 2.1l1.6 2.6c.8 1.3 2.2 2.1 3.8 2.1H17" />
      <path d="M3 13.5h3.2c1 0 1.9-.3 2.6-.9M11.6 6.9c.7-.6 1.6-.9 2.6-.9H17" />
      <path d="m15 4 2 2-2 2M15 11.5l2 2-2 2" />
    </Icon>
  )
}

export function CopyIcon() {
  return (
    <Icon size={15}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </Icon>
  )
}

export function StopIcon() {
  return (
    <Icon size={15}>
      <rect x="5" y="5" width="10" height="10" rx="1.5" />
    </Icon>
  )
}

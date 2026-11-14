import { useId, type CSSProperties, type ReactNode } from 'react'

/**
 * 水墨装饰：远山、月、楼阁、祥云、印章、徽记与生成式封面。
 *
 * 全部是内联 SVG，不依赖任何图片资源（离线可用、深浅主题都能用 currentColor 着色）。
 * 只做氛围：一律 aria-hidden 且不接收指针事件，不承载信息。
 */

/** useId 生成的 id 含冒号，放进 url(#…) 前要去掉 */
function useSvgId(prefix: string) {
  return `${prefix}${useId().replace(/:/g, '')}`
}

const FAR =
  'M0 132 C 60 118 104 96 152 104 C 196 111 222 82 268 86 C 318 90 344 118 398 112 C 452 106 486 74 540 80 C 600 87 628 116 690 110 C 742 105 770 90 800 94 L800 200 L0 200 Z'
const MID =
  'M0 156 C 48 150 82 128 120 132 C 150 135 170 112 196 116 C 236 122 252 150 300 146 C 352 142 380 104 430 108 C 476 112 496 146 548 142 C 600 138 626 120 664 124 C 716 130 748 150 800 146 L800 200 L0 200 Z'
const NEAR =
  'M0 178 C 70 172 120 160 186 166 C 250 172 300 186 372 180 C 446 174 498 160 566 166 C 640 172 700 186 800 178 L800 200 L0 200 Z'

/** 楼阁剪影：三重檐，宽约 60 */
function Pagoda({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path d="M30 0 L31 6 L29 6 Z" />
      <path d="M14 14 Q30 4 46 14 Q40 13 38 15 L22 15 Q20 13 14 14 Z" />
      <rect x="23" y="15" width="14" height="7" />
      <path d="M8 26 Q30 14 52 26 Q45 25 42 27 L18 27 Q15 25 8 26 Z" />
      <rect x="20" y="27" width="20" height="8" />
      <path d="M2 40 Q30 26 58 40 Q50 39 46 41 L14 41 Q10 39 2 40 Z" />
      <rect x="16" y="41" width="28" height="11" />
      <rect x="10" y="52" width="40" height="4" />
    </g>
  )
}

/**
 * 远山长卷：作品库页头、侧栏底部、空态横幅。
 * 颜色跟随 currentColor（建议用 --text 或 --gold），透明度由各层自己控制。
 */
export function InkLandscape({
  className,
  style,
  moon = true,
  pagoda = false,
  moonTone = 'pale'
}: {
  className?: string
  style?: CSSProperties
  moon?: boolean
  pagoda?: boolean
  moonTone?: 'pale' | 'red'
}) {
  const fade = useSvgId('ink-fade-')
  const glow = useSvgId('ink-glow-')
  return (
    <svg
      className={`ink-art ${className || ''}`}
      style={style}
      viewBox="0 0 800 200"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.55" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.9" />
        </linearGradient>
        <radialGradient id={glow}>
          <stop offset="0" stopColor={moonTone === 'red' ? '#c4513b' : '#f3ead6'} stopOpacity="0.95" />
          <stop offset="0.55" stopColor={moonTone === 'red' ? '#a33a28' : '#e9dcc0'} stopOpacity="0.55" />
          <stop offset="1" stopColor={moonTone === 'red' ? '#a33a28' : '#e9dcc0'} stopOpacity="0" />
        </radialGradient>
      </defs>
      {moon && (
        <g>
          <circle cx="612" cy="58" r="46" fill={`url(#${glow})`} opacity="0.35" />
          <circle
            className={moonTone === 'red' ? undefined : 'ink-moon__disc'}
            cx="612"
            cy="58"
            r="17"
            fill={moonTone === 'red' ? '#b8412f' : '#efe5cf'}
            opacity="0.82"
          />
        </g>
      )}
      <path d={FAR} fill="currentColor" opacity="0.1" />
      {pagoda && (
        <g fill="currentColor" opacity="0.22">
          <Pagoda x={500} y={64} scale={0.9} />
        </g>
      )}
      <path d={MID} fill="currentColor" opacity="0.16" />
      <path d={NEAR} fill={`url(#${fade})`} opacity="0.5" />
    </svg>
  )
}

/** 鎏金线描群山：统计卡、导出页角落的装饰 */
export function MountainLine({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={`ink-art ${className || ''}`}
      style={style}
      viewBox="0 0 240 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 62 L46 34 L62 44 L96 14 L124 38 L140 28 L176 50 L200 40 L238 62" opacity="0.85" />
      <path d="M40 62 L72 42 L88 50 L112 32 L134 48 L160 40 L196 62" opacity="0.45" />
      <path d="M96 14 L100 24 M96 14 L91 26 M140 28 L143 36" opacity="0.6" />
    </svg>
  )
}

/** 祥云：页头、卡片角的细线装饰 */
export function CloudScroll({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={`ink-art ${className || ''}`}
      style={style}
      viewBox="0 0 96 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 24 H58 C66 24 70 18 66 13 C62 8 54 10 55 16 C56 20 61 20 62 17" />
      <path d="M30 18 H76 C84 18 88 12 84 7 C80 3 73 5 74 10 C75 13 79 13 80 11" />
      <path d="M50 30 H92" opacity="0.5" />
    </svg>
  )
}

/** 朱砂方印：品牌标记、章首小印 */
export function Seal({
  text = '稿',
  size = 22,
  className,
  title
}: {
  text?: string
  size?: number
  className?: string
  title?: string
}) {
  const multi = text.length > 1
  return (
    <span
      className={`ink-seal ${className || ''}`}
      style={{ width: size, height: size, fontSize: multi ? size * 0.36 : size * 0.52 }}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      {multi ? (
        <span style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', lineHeight: 1.05 }}>
          {Array.from(text.slice(0, 4)).map((c, i) => (
            <span key={i}>{c}</span>
          ))}
        </span>
      ) : (
        text
      )}
    </span>
  )
}

/** 鎏金圆徽：作品标识（书名首字）、AI 头像 */
export function Emblem({
  char,
  size = 36,
  className,
  children
}: {
  char?: string
  size?: number
  className?: string
  children?: ReactNode
}) {
  return (
    <span
      className={`ink-emblem ${className || ''}`}
      style={{ width: size, height: size, fontSize: size * 0.44 }}
      aria-hidden="true"
    >
      {children ?? char}
    </span>
  )
}

const COVER_TONES = [
  // 夜墨 · 白月
  { bg: ['#1b1d22', '#0c0d10'], ink: '#e9e0cb', hill: '#7f8590', moon: '#eee3cb', light: false },
  // 烟雨 · 青山
  { bg: ['#d9d6cc', '#b9b6ac'], ink: '#2b2a26', hill: '#5f6260', moon: '#f4f0e6', light: true },
  // 赤月 · 夜城
  { bg: ['#1d1715', '#0d0a0a'], ink: '#efe1cf', hill: '#5e4a43', moon: '#b8412f', light: false },
  // 竹青 · 寒江
  { bg: ['#17201e', '#0b1110'], ink: '#e6e4d6', hill: '#5f7a6f', moon: '#e8e2cf', light: false }
]

/**
 * 生成式书封：没有上传封面时，用书名 + 水墨山月画一张竖版封面。
 * tone 由作品 id 推出，同一本书始终是同一种颜色。
 */
export function CoverArt({ title, genre, tone = 0 }: { title: string; genre?: string; tone?: number }) {
  const t = COVER_TONES[Math.abs(tone) % COVER_TONES.length]
  const bg = useSvgId('cover-bg-')
  const chars = Array.from(title || '未命名').slice(0, 6)
  return (
    <span
      className={`ink-cover${t.light ? ' ink-cover--light' : ''}`}
      style={{ color: t.ink, background: `linear-gradient(170deg, ${t.bg[0]}, ${t.bg[1]})` }}
    >
      <svg
        className="ink-art ink-cover__art"
        viewBox="0 0 120 160"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={t.hill} stopOpacity="0" />
            <stop offset="1" stopColor={t.hill} stopOpacity="0.85" />
          </linearGradient>
        </defs>
        {/* 月在左上，书名竖排在右，互不遮挡 */}
        <circle cx="40" cy="38" r="12" fill={t.moon} opacity={t.light ? 0.9 : 0.85} />
        <circle cx="40" cy="38" r="21" fill={t.moon} opacity="0.08" />
        <path
          d="M0 118 C 18 108 30 96 44 100 C 56 103 62 88 76 90 C 92 92 100 108 120 104 L120 160 L0 160 Z"
          fill={t.hill}
          opacity="0.45"
        />
        <path d="M0 134 C 22 126 40 130 58 124 C 78 118 96 128 120 122 L120 160 L0 160 Z" fill={`url(#${bg})`} />
        <g fill={t.ink} opacity="0.5">
          <circle cx="18" cy="40" r="0.9" />
          <circle cx="34" cy="62" r="0.7" />
          <circle cx="62" cy="22" r="0.8" />
          <circle cx="100" cy="70" r="0.7" />
          <circle cx="12" cy="88" r="0.6" />
        </g>
      </svg>
      <span className={`ink-cover__title${chars.length > 4 ? ' ink-cover__title--long' : ''}`}>
        {chars.map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </span>
      {genre && <span className="ink-cover__genre">{genre}</span>}
      <span className="ink-cover__seal" aria-hidden="true" />
    </span>
  )
}

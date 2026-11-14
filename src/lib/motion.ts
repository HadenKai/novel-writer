import type { CSSProperties } from 'react'
import { flushSync } from 'react-dom'

/**
 * 全局动效工具：页面切换的退场 / 进场。
 *
 * 两档，按机器实际表现自动选择（「适配」）：
 *  - full：View Transitions。只截内容区（app-content），侧栏与工具栏不截图、不参与动画、全程可点；
 *    转场层 pointer-events: none，动画播放期间点击直接落到真实页面上，不会被吞。
 *  - lite：不截图，内容区用 CSS 关键帧进场（.route-enter-*）。给低配机器、或实测截图过慢时用。
 *  系统开启「减少动态效果」时两档都不做，直接切换。
 *
 * 2026-11-01 实测（生产包）：旧实现每次切页 530–710ms 才能再操作——截了整窗 + 侧栏 + 工具栏三份快照，
 * 更新回调里还固定等两帧（转场期间 rAF 被挂起，实际总是等满 80ms 兜底定时器），动画里带全屏模糊滤镜，
 * 播放期间点击全部被转场层吞掉。现在改为：只截内容区、flushSync 同步提交新页面（不再等帧）、
 * 去掉模糊滤镜、转场层不挡点击。
 */

export type MotionTier = 'full' | 'lite'
export const MOTION_TIER_EVENT = 'writer-motion-tier'

/** 系统是否要求减少动态效果 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// 起步档位：核心数或内存明显偏低的机器直接用 lite，其余先用 full、按实测再降
function initialTier(): MotionTier {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return 'lite'
  const nav = navigator as Navigator & { deviceMemory?: number }
  if ((nav.hardwareConcurrency || 8) <= 2 || (nav.deviceMemory || 8) <= 2) return 'lite'
  return 'full'
}
let tier: MotionTier = initialTier()

export function motionTier(): MotionTier {
  return tier
}

/** full 档才走 View Transitions；App 据此决定是否给内容区挂 CSS 进场类 */
export function supportsViewTransitions(): boolean {
  return tier === 'full'
}

// 截图开销 = 转场就绪耗时 − 渲染新页面本身的耗时。只按截图开销降档，页面本身渲染慢不算在动画头上
const SLOW_CAPTURE_MS = 120
let slowStreak = 0
function noteCapture(ms: number) {
  slowStreak = ms > SLOW_CAPTURE_MS ? slowStreak + 1 : 0
  if (slowStreak >= 3 && tier === 'full') {
    tier = 'lite'
    window.dispatchEvent(new CustomEvent<MotionTier>(MOTION_TIER_EVENT, { detail: tier }))
  }
}

type Transition = ReturnType<Document['startViewTransition']>
let active: Transition | null = null

/**
 * 用页面转场包住一次状态更新（通常是路由跳转）。
 * full 档：View Transitions + flushSync；lite 档或不支持：直接更新，进场动画交给 CSS。
 */
export function withViewTransition(update: () => void): void {
  if (tier !== 'full' || prefersReducedMotion() || typeof document.startViewTransition !== 'function') {
    update()
    return
  }
  // 上一段还没播完又点了：跳到终态直接切，不叠第二次截图
  if (active) {
    active.skipTransition()
    update()
    return
  }
  try {
    const t0 = performance.now()
    let renderMs = 0
    const transition = document.startViewTransition(() => {
      const r0 = performance.now()
      // 同步提交新页面：旧实现在这里等两帧，而转场期间 rAF 不触发，每次都白等 80ms
      flushSync(update)
      renderMs = performance.now() - r0
    })
    active = transition
    transition.ready.then(() => noteCapture(performance.now() - t0 - renderMs)).catch(() => {})
    transition.finished
      .catch(() => {})
      .finally(() => {
        if (active === transition) active = null
      })
  } catch {
    active = null
    update()
  }
}

/**
 * 接管站内链接点击：统一走页面转场。返回卸载函数。
 *
 * 说明：在捕获阶段拦截并 preventDefault，React Router 的 <Link> 会因为
 * defaultPrevented 而跳过自己的跳转，最终只由这里发起一次导航。
 */
export function installLinkTransitions(navigate: (to: string) => void): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    if (anchor.target && anchor.target !== '_self') return
    if (anchor.hasAttribute('download')) return
    if (anchor.dataset.noTransition === 'true') return
    const href = anchor.getAttribute('href') || ''
    // 只接管站内绝对路径；hash、协议相对地址与外链交给浏览器
    if (!href.startsWith('/') || href.startsWith('//')) return
    event.preventDefault()
    withViewTransition(() => navigate(href))
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

/** 让一组元素依次入场：给子元素写入 --stagger-index 供 CSS 使用 */
export function staggerIndex(index: number): CSSProperties {
  return { '--stagger-index': index } as unknown as CSSProperties
}

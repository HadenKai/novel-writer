import { useCallback, useEffect, useState } from 'react'

/**
 * 定高行虚拟滚动：只把视口附近（±overscan）的行挂进 DOM，上下用等高占位撑出真实滚动高度。
 *
 * 行高必须恒定，由调用方自己保证（行元素写死 height，间距用固定 margin）。
 * ref 用回调形式挂载，容器随条件渲染挂上/卸掉时监听会正确跟随。
 */
export function useFixedSizeWindow(itemCount: number, rowHeight: number, overscan = 8) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(640)

  useEffect(() => {
    if (!el) return
    // 滚动时顺带校准视口高度：ResizeObserver 在部分环境（隐藏窗口）不派发，滚动路径自己兜底
    const onScroll = () => {
      setScrollTop(el.scrollTop)
      setViewH(h => (h === el.clientHeight ? h : el.clientHeight))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [el])

  const windowRows = Math.ceil(viewH / rowHeight) + overscan * 2
  // itemCount 骤减（如搜索过滤）时旧 scrollTop 会把窗口推出列表——夹回最后一段，
  // 否则要等浏览器多轮 clamp scrollTop 才收敛，期间列表整段空白
  const start = Math.max(0, Math.min(Math.floor(scrollTop / rowHeight) - overscan, itemCount - windowRows))
  const end = Math.min(itemCount, start + windowRows)

  const scrollToIndex = useCallback(
    (index: number) => {
      if (!el) return
      el.scrollTo({ top: Math.max(0, index * rowHeight - (el.clientHeight - rowHeight) / 2) })
    },
    [el, rowHeight]
  )

  return {
    ref: setEl,
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (itemCount - end) * rowHeight),
    scrollToIndex
  }
}

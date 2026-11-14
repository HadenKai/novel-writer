import { useEffect, useRef, useState } from 'react'

/**
 * 把「分批到达」的流式文本平滑成逐字显示。
 *
 * 模型/中转站常把几十上百字攒成一块发过来，直接渲染就是一蹦一大段。
 * 这里只记录「已显示到第几个字」，每 50ms 向目标长度逼近一次：
 * 欠账越多追得越快（上限 2400 字/秒），欠账少时就是正常的逐字速度，
 * 整体延迟通常不超过半秒；任务结束时外部会换成正式消息，不会一直拖尾。
 */
export function useSmoothText(text: string, active: boolean): string {
  const [shown, setShown] = useState(0)
  const textRef = useRef(text)
  textRef.current = text

  // 文本变短（任务重置 / 换会话）时把显示位置夹回边界
  useEffect(() => {
    setShown(prev => Math.min(prev, text.length))
  }, [text.length])

  useEffect(() => {
    if (!active) return
    let last = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      const dt = Math.max(16, now - last)
      last = now
      setShown(prev => {
        const target = textRef.current.length
        if (prev >= target) return prev
        const backlog = target - prev
        // 欠账按 0.4 秒追平：少时约 90 字/秒（正常打字速度），多时加速但不瞬移
        const rate = Math.min(2400, Math.max(90, backlog / 0.4))
        return Math.min(target, prev + Math.max(1, Math.round((rate * dt) / 1000)))
      })
    }, 40)
    return () => window.clearInterval(timer)
  }, [active])

  return text.slice(0, shown)
}

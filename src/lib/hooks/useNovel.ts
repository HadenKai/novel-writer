import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { api } from '../api'
import type { Novel } from '../../types'

export interface UseNovelResult {
  novel: Novel | null
  /** 首屏加载中；重载（reload）不会置为 true，避免页面闪烁 */
  loading: boolean
  /** 拉取失败的原因；reload 成功后自动清空 */
  loadError: string
  /**
   * 重新拉取整本数据，用于 AI 后台写入后的同步。
   * 不清空当前内容、不触发 loading，失败时静默回落（保留旧数据）。
   */
  reload: () => Promise<Novel | null>
  /** 本地立即更新（保存回写 / 乐观更新），不发请求 */
  setNovel: Dispatch<SetStateAction<Novel | null>>
}

/**
 * 单一作品数据源。
 *
 * 原先 Workspace / Butler / Refine / Library / ProjectDetail / ChapterEditor 各自
 * 写一遍「getNovel + loading + error + reload」，彼此还不知道对方改过数据。
 * 收口到这里之后，页面只需要关心「我用 novel 的哪几个字段」。
 *
 * 注意：这里只管**加载**错误。页面自身的操作错误（如「请选择要处理的章节」）
 * 应当用页面本地的 state，两者在渲染时合并展示。
 */
export function useNovel(id: string | undefined, onLoaded?: (novel: Novel) => void): UseNovelResult {
  const [novel, setNovel] = useState<Novel | null>(null)
  const [loading, setLoading] = useState(!!id)
  const [loadError, setLoadError] = useState('')

  // onLoaded 走 ref：调用方常传内联函数，直接进依赖会让 effect 反复重启
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  // 卸载后不再 setState；切书时由 effect 重新装载
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 代际计数：快速 A→B→C 换书时，A 的在途响应可能最后到达，
  // 会把 B/C 的书盖成 A 的正文（aliveRef 只防卸载，不防换书）。只有最新一代的响应可以落地。
  const genRef = useRef(0)

  const fetchNovel = useCallback(async (): Promise<Novel | null> => {
    if (!id) return null
    const gen = ++genRef.current
    try {
      const n = await api.getNovel(id)
      if (!aliveRef.current || gen !== genRef.current) return null
      setNovel(n)
      setLoadError('')
      onLoadedRef.current?.(n)
      return n
    } catch (e) {
      if (aliveRef.current && gen === genRef.current) setLoadError((e as Error).message)
      return null
    } finally {
      if (aliveRef.current && gen === genRef.current) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (!id) {
      setNovel(null)
      setLoading(false)
      return
    }
    // 换书：先清空再拉，避免短暂显示上一本书的正文
    setNovel(null)
    setLoading(true)
    void fetchNovel()
  }, [id, fetchNovel])

  return { novel, loading, loadError, reload: fetchNovel, setNovel }
}

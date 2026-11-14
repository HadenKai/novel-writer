import { useEffect, useState } from 'react'
import { api } from '../api'
import { MODEL_UPDATED_EVENT } from '../thinking'
import type { ModelConfig } from '../../types'

/**
 * 模型列表。
 *
 * 每次挂载都重新拉一次（本地服务，开销可忽略），刻意不做跨页面缓存——
 * 用户在「模型设置」里新增/删除模型后，回到其它页面必须立刻看到最新列表。
 * 选择器里调了思考强度会广播 MODEL_UPDATED_EVENT，这里就地合并那一条。
 */
export function useModels(): ModelConfig[] {
  const [models, setModels] = useState<ModelConfig[]>([])
  useEffect(() => {
    let alive = true
    api
      .getModels()
      .then(list => {
        if (alive) setModels(list)
      })
      .catch(() => {})
    const onUpdated = (e: Event) => {
      const next = (e as CustomEvent<ModelConfig>).detail
      if (!next?.id) return
      setModels(list => list.map(m => (m.id === next.id ? { ...m, ...next } : m)))
    }
    window.addEventListener(MODEL_UPDATED_EVENT, onUpdated)
    return () => {
      alive = false
      window.removeEventListener(MODEL_UPDATED_EVENT, onUpdated)
    }
  }, [])
  return models
}

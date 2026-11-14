import { useEffect, useRef } from 'react'
import { api, NotFoundError } from './api'
import type { GenJob } from '../types'

type JobMeta = Omit<GenJob, 'stream' | 'reasoning'>

/**
 * 任务进度：优先走 SSE 实时增量（约 100ms 一拍，正文接近逐字出现），
 * 连接失败或中断时退回 ?since= 轮询（见 api.getJobDelta）。
 *
 * 两条路径共用同一组游标（streamRef / reasoningRef），切换不会重复或丢字：
 *   - 首帧 meta 只带任务元信息，正文/思考都走增量；
 *   - 服务端长度回退（任务被重建）时发 reset，清空本地游标后从头接；
 *   - 结束帧带完整 job，交给调用方的 onSettled 收尾。
 */
export function useJobPoll(
  jobId: string | null | undefined,
  status: string | undefined,
  setJob: (j: GenJob | null) => void,
  onSettled?: (j: GenJob) => void
) {
  const streamRef = useRef('')
  const reasoningRef = useRef('')
  const metaRef = useRef<JobMeta | null>(null)
  const settledRef = useRef(false)

  // 任务换了 → 重置游标，避免把上一章的正文接到这一章后面
  useEffect(() => {
    streamRef.current = ''
    reasoningRef.current = ''
    metaRef.current = null
    settledRef.current = false
  }, [jobId])

  // onSettled 走 ref，避免调用方传内联箭头导致轮询被反复重启
  const settleRef = useRef(onSettled)
  settleRef.current = onSettled
  const setJobRef = useRef(setJob)
  setJobRef.current = setJob

  useEffect(() => {
    if (!jobId || status !== 'running') return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let sseCtrl: AbortController | null = null
    let fellBack = false

    const settle = (j: GenJob) => {
      if (settledRef.current) return
      settledRef.current = true
      settleRef.current?.(j)
    }

    const publish = () => {
      const meta = metaRef.current
      if (!meta) return
      setJobRef.current({ ...meta, stream: streamRef.current, reasoning: reasoningRef.current })
    }

    // ---------- 兜底轮询（SSE 不可用 / 中途断开时接管） ----------
    const tick = async () => {
      try {
        const d = await api.getJobDelta(jobId, streamRef.current.length, reasoningRef.current.length)
        if (!alive) return
        // 服务端长度比本地短 → 任务被重建过，丢弃本地缓存重新全量拿一次
        if (d.delta.streamLen < streamRef.current.length || d.delta.reasoningLen < reasoningRef.current.length) {
          const full = await api.getJob(jobId)
          if (!alive) return
          streamRef.current = full.stream || ''
          reasoningRef.current = full.reasoning || ''
          setJobRef.current(full)
          if (full.status !== 'running') settle(full)
          return
        }
        streamRef.current += d.delta.stream
        reasoningRef.current += d.delta.reasoning
        const merged: GenJob = {
          ...(d as unknown as GenJob),
          stream: streamRef.current,
          reasoning: reasoningRef.current
        }
        setJobRef.current(merged)
        if (merged.status !== 'running') settle(merged)
      } catch (e) {
        if (!alive) return
        if (e instanceof NotFoundError) setJobRef.current(null)
      } finally {
        if (alive) timer = setTimeout(tick, 1200)
      }
    }
    const startPolling = () => {
      if (!alive || fellBack) return
      fellBack = true
      sseCtrl = null
      tick()
    }

    // ---------- 实时通道 ----------
    const runSse = async () => {
      sseCtrl = new AbortController()
      const ctrl = sseCtrl
      try {
        const res = await fetch(
          `/api/jobs/${jobId}/events?sl=${streamRef.current.length}&rl=${reasoningRef.current.length}`,
          { signal: ctrl.signal }
        )
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done || !alive) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '').trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            let evt: Record<string, unknown>
            try {
              evt = JSON.parse(line.slice(5).trim())
            } catch {
              continue
            }
            if (!alive || ctrl.signal.aborted) return
            if (evt.meta) {
              metaRef.current = evt.meta as JobMeta
              publish()
            } else if (evt.reset) {
              streamRef.current = ''
              reasoningRef.current = ''
              publish()
            } else if (typeof evt.stream === 'string') {
              streamRef.current += evt.stream
              publish()
            } else if (typeof evt.reasoning === 'string') {
              reasoningRef.current += evt.reasoning
              publish()
            } else if (evt.done && evt.job) {
              const full = evt.job as GenJob
              streamRef.current = full.stream || ''
              reasoningRef.current = full.reasoning || ''
              setJobRef.current(full)
              settle(full)
              return
            }
          }
        }
        // 没有收到结束帧就断了（网络抖动 / 代理超时）：交给轮询确认最终状态
        if (alive) startPolling()
      } catch {
        if (alive && !ctrl.signal.aborted) startPolling()
      }
    }

    runSse()
    return () => {
      alive = false
      sseCtrl?.abort()
      if (timer) clearTimeout(timer)
    }
  }, [jobId, status])
}

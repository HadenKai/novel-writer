import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { api } from '../api'
import { useJobPoll } from '../useJobPoll'
import type { GenJob } from '../../types'

/** startJob 的结果：失败不抛异常，交由调用方决定怎么提示 */
export type StartJobResult = { ok: true; job: GenJob; error: '' } | { ok: false; job: null; error: string }

export interface UseJobOptions {
  /**
   * 判断一个后台任务是否归属本页（用于刷新/重进页面时认领正在跑的任务）。
   * 不传则不认领。
   */
  claim?: (job: GenJob) => boolean
  /** 任务结束（done / stopped / error）时回调一次，用于页面收尾（重载数据、提示文案） */
  onSettled?: (job: GenJob) => void
}

export interface UseJobResult {
  job: GenJob | null
  setJob: Dispatch<SetStateAction<GenJob | null>>
  /** 是否有任务正在运行 */
  running: boolean
  /** 从服务端认领归属本页的任务（页面挂载 / 换书时调用一次） */
  claimRunning: (novelId: string) => Promise<void>
  /** 启动任务：拿到 jobId → 拉一次全量 → 交给轮询接管 */
  startJob: (run: () => Promise<{ jobId: string }>) => Promise<StartJobResult>
  /** 请求停笔（失败静默；任务状态由轮询收尾） */
  stop: () => Promise<void>
}

/**
 * 后台任务的统一入口：认领 → 启动 → 轮询 → 收尾。
 *
 * 原先 Butler / Library / Refine 各抄一份「getNovelJobs 找自己那份 + 启动后
 * getJob 拿全量 + 用 useJobPoll 轮询 + 结束回调」，三份逻辑还不完全一致。
 * 这里把生命周期收口，页面只提供两件事：怎么认领、结束了做什么。
 *
 * 轮询本身仍由 useJobPoll 负责（增量拉取，避免整包重传正文）。
 */
export function useJob(options: UseJobOptions = {}): UseJobResult {
  const [job, setJob] = useState<GenJob | null>(null)

  // 两个回调都走 ref：调用方通常传内联箭头，直接进依赖会让轮询被反复重启
  const claimRef = useRef(options.claim)
  claimRef.current = options.claim
  const settleRef = useRef(options.onSettled)
  settleRef.current = options.onSettled

  useJobPoll(job?.id, job?.status, setJob, j => settleRef.current?.(j))

  // stop 需要读到最新的 job，但不能把 job 放进 useCallback 依赖（会让 stop 每次渲染都换新）
  const jobRef = useRef(job)
  jobRef.current = job

  const claimRunning = useCallback(async (novelId: string) => {
    if (!claimRef.current) return
    try {
      const jobs = await api.getNovelJobs(novelId)
      const mine = jobs.find(j => claimRef.current?.(j))
      if (mine) setJob(mine)
    } catch {
      // 认领失败不影响新任务启动，静默即可
    }
  }, [])

  const startJob = useCallback(async (run: () => Promise<{ jobId: string }>): Promise<StartJobResult> => {
    try {
      const { jobId } = await run()
      const j = await api.getJob(jobId)
      setJob(j)
      return { ok: true, job: j, error: '' }
    } catch (e) {
      return { ok: false, job: null, error: (e as Error).message }
    }
  }, [])

  const stop = useCallback(async () => {
    const cur = jobRef.current
    if (!cur) return
    await api.stopJob(cur.id).catch(() => {})
  }, [])

  return { job, setJob, running: job?.status === 'running', claimRunning, startJob, stop }
}

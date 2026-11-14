// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { desktop } from '../../lib/desktop'
import { alertDialog, confirmDialog } from '../../components/Dialog'
import { toast } from '../../components/Toast'
import ModalShell from '../../components/ModalShell'
import { useJobPoll } from '../../lib/useJobPoll'
import { inputCls } from './shared'
import type { GenJob, ReferenceAnalysis, RefFile } from '../../types'
export default function ReferenceAnalysisModal({
  novelId,
  initialFolder,
  modelId,
  onClose,
  onSpread
}: {
  novelId: string
  initialFolder: string
  modelId: string
  onClose: () => void
  onSpread: (a: ReferenceAnalysis, folder?: string) => void
}) {
  const [folder, setFolder] = useState(initialFolder || '')
  const [files, setFiles] = useState<RefFile[]>([])
  const [scanning, setScanning] = useState(false)
  const [hasNew, setHasNew] = useState(0)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState<ReferenceAnalysis | null>(null)
  // 拆书走后台任务：decJob 为 null = 没在跑；stream 显示逐块进度，result 是最终报告
  const [decJob, setDecJob] = useState<GenJob | null>(null)
  const deconstructing = decJob?.status === 'running'
  const [decStarting, setDecStarting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ chunks: number; text: string; file: string } | null>(null)
  const [err, setErr] = useState('')

  // 打开弹窗时接回正在跑的拆书任务（关弹窗 / 刷新不丢进度）
  useEffect(() => {
    let alive = true
    api
      .getNovelJobs(novelId)
      .then(jobs => {
        if (!alive) return
        const dec = (jobs || []).find(x => x.type === 'deconstruct' && x.status === 'running')
        if (dec) setDecJob(dec)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [novelId])

  useJobPoll(decJob?.id, decJob?.status, setDecJob, j => {
    if (j.status === 'done') {
      const r = (j.result || {}) as { chunks?: number; report?: string; file?: string }
      setReport({ chunks: r.chunks ?? 0, text: r.report || '', file: r.file || '' })
      setErr('')
    } else if (j.status === 'error') {
      setErr(j.error || '拆书失败，请重试。')
    } else {
      setErr('已停止拆书。')
    }
    setDecJob(null)
  })

  // 外部路径变化时同步弹窗输入，避免显示旧路径
  useEffect(() => {
    setFolder(initialFolder || '')
  }, [initialFolder])

  const pickFolder = async () => {
    const shell = desktop()
    if (shell?.pickFolder) {
      const p = await shell.pickFolder().catch(() => null)
      if (p) setFolder(p)
    } else {
      alertDialog({
        title: '当前无法选择文件夹',
        body: '浏览器模式下没有文件夹选择能力，请手动输入路径，或改用桌面版应用。',
        tone: 'warning'
      })
    }
  }

  const scan = async () => {
    if (!folder.trim()) return setErr('请先填写参考小说文件夹路径')
    setScanning(true)
    setErr('')
    setFiles([])
    try {
      const r = await api.scanFolder(novelId, folder.trim())
      setFiles(r.files)
      setHasNew(r.newCount || 0)
      if (r.count === 0) setErr('文件夹中没有找到有效的参考小说（.txt / .md / .text 文件）')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setScanning(false)
    }
  }

  const analyze = async () => {
    if (!folder.trim()) return setErr('请先填写参考小说文件夹路径')
    setAnalyzing(true)
    setErr('')
    setAnalysis(null)
    try {
      const r = await api.analyzeReferences(novelId, { folderPath: folder.trim(), modelId: modelId || undefined })
      if (!r?.analysis) throw new Error('分析结果为空')
      setAnalysis(r.analysis)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }

  const deconstruct = async () => {
    if (!folder.trim()) return setErr('请先填写参考小说文件夹路径')
    // 启动期间（两个 await）按钮尚未进入「停止拆书」形态，不加锁双击会起两个拆书任务
    if (decStarting || deconstructing) return
    setDecStarting(true)
    setErr('')
    setReport(null)
    try {
      const { jobId } = await api.startDeconstructJob(novelId, {
        folderPath: folder.trim(),
        modelId: modelId || undefined
      })
      setDecJob(await api.getJob(jobId))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setDecStarting(false)
    }
  }

  const applyReport = async () => {
    if (!report) return
    const ok = await confirmDialog({
      title: '把这份拆书报告写进本书风格档案？',
      body: '写入后，后续所有正文生成都会以它校准；可到「文风与指令」里查看或手动删改。',
      confirmText: '写入'
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.applyDeconstruct(novelId, report.text)
      toast.success('拆书技法已写进本书风格档案，后续正文会以它校准。')
    } catch (e) {
      alertDialog({ title: '写入失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const summary = (a: ReferenceAnalysis) => {
    const s = (v: string) => (v || '').trim()
    const charNames = (a.characters || [])
      .map(c => c.name)
      .filter(Boolean)
      .join('、')
    return (
      [
        a.characters?.length ? `人物 ${a.characters.length} 位${charNames ? `（${charNames}）` : ''}` : '',
        s(a.plotEvents) ? `事件已提取` : '',
        s(a.worldBuilding) ? `世界观已提取` : '',
        s(a.writingStyle) ? `文风已提取` : ''
      ]
        .filter(Boolean)
        .join(' · ') || '分析结果为空'
    )
  }

  return (
    <ModalShell title="参考作品分析" width={640} onClose={onClose} busy={analyzing || scanning} maxHeight="88vh">
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-[var(--text-dim)]">
          把想参考的小说（.txt / .md 文件）放进指定文件夹，AI
          会阅读并分析其中的人物设定、剧情事件、世界观、写作风格与人物关系。分析结果可一键补充进本书的人物、世界观、剧情元素等设定栏，方便创作同人文。
          <br />
          <span className="text-[var(--text-faint)]">
            「拆书报告」是另一条线：逐块逆向它的<b>结构、节奏、爽点分布与钩子手法</b>，产出一份可直接照着模仿的报告
            （只落盘存档，<b>不会</b>写进本书设定，避免参考信息污染自己的档案）。
          </span>
        </p>

        <div>
          <label className="mb-1.5 block text-[12px] text-[var(--text-dim)]" htmlFor="ref-folder">
            参考小说文件夹
          </label>
          <div className="flex gap-2">
            <input
              id="ref-folder"
              value={folder}
              onChange={e => setFolder(e.target.value)}
              placeholder="例：D:\同人文素材\某原著"
              className={inputCls}
            />
            <button
              onClick={pickFolder}
              type="button"
              title="选择文件夹"
              aria-label="选择参考小说文件夹"
              className="btn btn--ghost btn--md shrink-0"
            >
              浏览…
            </button>
          </div>
        </div>

        {files.length > 0 && (
          <div className="rounded-[9px] border border-transparent bg-[var(--panel2)] p-3">
            <div className="mb-2 text-[11px] text-[var(--text-faint)]">
              检测到 {files.length} 部参考小说
              {hasNew > 0 && (
                <span className="ml-2 rounded-[7px] border border-[color-mix(in_srgb,var(--gold)_35%,var(--line))] px-1.5 py-px text-[10px] text-[var(--gold)]">
                  新增 / 变化 {hasNew} 部，未重新分析
                </span>
              )}
            </div>
            <div className="max-h-40 space-y-1.5 overflow-y-auto">
              {files.map(f => (
                <div key={f.path} className="rounded-[9px] bg-[var(--panel)] px-3 py-2 text-[12px]">
                  <div className="flex justify-between">
                    <span className="flex items-center gap-1.5 text-[var(--text)]">
                      {f.name}
                      {f.status === 'new' && (
                        <span className="rounded-[7px] bg-[color-mix(in_srgb,var(--gold)_12%,var(--panel))] px-1.5 py-px text-[10px] text-[var(--gold)]">
                          新增
                        </span>
                      )}
                      {f.status === 'changed' && (
                        <span className="rounded-[7px] bg-[color-mix(in_srgb,var(--seal)_12%,var(--panel))] px-1.5 py-px text-[10px] text-[var(--seal)]">
                          有变化
                        </span>
                      )}
                    </span>
                    <span className="text-[var(--text-faint)]">约 {f.words} 字</span>
                  </div>
                  <div className="mt-1 truncate text-[var(--text-faint)]">{f.preview}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {analysis && (
          <div className="space-y-3">
            <div className="rounded-[9px] border border-[color-mix(in_srgb,var(--jade)_25%,var(--line))] bg-[color-mix(in_srgb,var(--jade)_5%,var(--panel))] px-4 py-3">
              <div className="mb-1.5 text-[12px] font-medium text-[var(--jade)]">分析完成</div>
              <div className="text-[12px] leading-[1.7] text-[var(--text-dim)]">{summary(analysis)}</div>
            </div>
            <div className="rounded-[9px] border border-transparent bg-[var(--panel2)] p-4">
              <div className="mb-2 text-[11px] text-[var(--text-faint)]">分析详情</div>
              <div className="space-y-3 text-[12px] leading-[1.7] text-[var(--text)]">
                {(analysis.characters || []).length > 0 && (
                  <div>
                    <div className="mb-1 text-[var(--gold)]">人物设定</div>
                    {analysis.characters.map((c, i) => (
                      <div key={i} className="mb-1.5 border-l-2 border-[var(--line)] pl-2.5">
                        <b>{c.name}</b>
                        {c.role && <span className="text-[var(--text-faint)]"> · {c.role}</span>}
                        {c.personality && <div className="text-[var(--text-dim)]">{c.personality}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {analysis.plotSummary && (
                  <div>
                    <div className="mb-1 text-[var(--gold)]">剧情走向</div>
                    <div className="text-[var(--text-dim)]">{analysis.plotSummary}</div>
                  </div>
                )}
                {analysis.plotEvents && (
                  <div>
                    <div className="mb-1 text-[var(--gold)]">核心事件</div>
                    <div className="whitespace-pre-wrap text-[var(--text-dim)]">{analysis.plotEvents}</div>
                  </div>
                )}
                {analysis.worldBuilding && (
                  <div>
                    <div className="mb-1 text-[var(--gold)]">世界观</div>
                    <div className="whitespace-pre-wrap text-[var(--text-dim)]">{analysis.worldBuilding}</div>
                  </div>
                )}
                {analysis.writingStyle && (
                  <div>
                    <div className="mb-1 text-[var(--gold)]">写作风格</div>
                    <div className="whitespace-pre-wrap text-[var(--text-dim)]">{analysis.writingStyle}</div>
                  </div>
                )}
                {analysis.keyRelationships && (
                  <div>
                    <div className="mb-1 text-[var(--gold)]">核心关系</div>
                    <div className="whitespace-pre-wrap text-[var(--text-dim)]">{analysis.keyRelationships}</div>
                  </div>
                )}
                {analysis.themes && (
                  <div>
                    <div className="mb-1 text-[var(--gold)]">主题</div>
                    <div className="whitespace-pre-wrap text-[var(--text-dim)]">{analysis.themes}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {err && (
          <p className="rounded-[9px] bg-[color-mix(in_srgb,var(--seal)_8%,var(--panel))] px-3 py-2 text-[12px] leading-[1.7] text-[var(--seal)]">
            {err}
          </p>
        )}

        {report && (
          <button onClick={applyReport} disabled={busy} className="btn btn--primary btn--md w-full">
            把这份报告写进本书风格档案
          </button>
        )}

        {report && (
          <details className="rounded-[9px] border border-transparent bg-[var(--panel2)]/60 p-3" open>
            <summary className="cursor-pointer text-[12px] font-medium text-[var(--text)]">
              拆书报告（共拆 {report.chunks} 块 · 已存到 data/refbooks/）
            </summary>
            <pre className="reader-scroll mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[12px] leading-[1.8] text-[var(--text-dim)]">
              {report.text}
            </pre>
          </details>
        )}

        {deconstructing && decJob?.stream && (
          <pre className="reader-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-[9px] bg-[var(--panel2)] p-3 text-[11.5px] leading-[1.8] text-[var(--text-dim)]">
            {decJob.stream}
          </pre>
        )}

        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-faint)]" role="status" aria-live="polite">
            {deconstructing
              ? `AI 正在逐块拆解（${decJob?.chunkDone ?? 0}/${decJob?.chunkTotal ?? '?'} 块）· 关掉弹窗也会继续`
              : analyzing
                ? 'AI 正在阅读参考小说并提取信息，约需 30~120 秒……'
                : scanning
                  ? '正在扫描文件夹……'
                  : '一次分析可提取人物、事件、世界观、文风与主题'}
          </span>
          <div className="flex gap-2">
            {analysis && (
              <button
                onClick={() => onSpread(analysis, folder.trim() || undefined)}
                className="btn btn--primary btn--md"
              >
                应用进本书设定
              </button>
            )}
            {deconstructing && decJob ? (
              <button onClick={() => void api.stopJob(decJob.id).catch(() => {})} className="btn btn--danger btn--md">
                停止拆书
              </button>
            ) : (
              <button
                onClick={deconstruct}
                disabled={analyzing || decStarting || !folder.trim()}
                className="btn btn--outline btn--md"
                title="逐块拆解结构 / 节奏 / 爽点 / 钩子，生成可照着模仿的拆书报告（不写进本书设定）"
              >
                {decStarting ? '启动中…' : '拆书报告'}
              </button>
            )}
            <button
              onClick={analyze}
              disabled={analyzing || deconstructing || !folder.trim()}
              className="btn btn--outline btn--md"
            >
              {analyzing ? '分析中……' : analysis ? '重新分析' : '开始分析'}
            </button>
            <button onClick={scan} disabled={scanning || deconstructing} className="btn btn--ghost btn--md">
              {scanning ? '扫描中……' : '扫描文件夹'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

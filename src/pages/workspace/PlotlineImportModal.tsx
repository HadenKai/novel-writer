// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import ModalShell from '../../components/ModalShell'
import type { Plotline } from '../../types'
export default function PlotlineImportModal({
  masterReady,
  onClose,
  onApply
}: {
  masterReady: boolean
  onClose: () => void
  onApply: (lines: Plotline[], mode: 'replace' | 'append') => void
}) {
  const { id } = useParams()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [parsed, setParsed] = useState<Plotline[] | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const run = async (mode: 'replace' | 'append') => {
    if (!id || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await api.generatePlotlines(id, mode)
      if (!r?.plotlines?.length) throw new Error('AI 未返回有效的剧情线')
      setParsed(r.plotlines)
      setExcluded(new Set())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (lid: string) =>
    setExcluded(prev => {
      const next = new Set(prev)
      if (next.has(lid)) next.delete(lid)
      else next.add(lid)
      return next
    })

  const picked = (parsed || []).filter(l => !excluded.has(l.id))

  return (
    <ModalShell title="AI 规划剧情线" width={640} onClose={onClose} busy={busy}>
      {!parsed ? (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-[var(--text-dim)]">
            AI 将通读设定与总纲，把核心冲突、成长线与伏笔拆成 4~8
            条并行剧情线（主线、感情线、悬念线……），每条线带推进节点与大致章号。生成后可挑选应用：覆盖现有，或追加保留。
          </p>
          {!masterReady && (
            <p className="rounded-[9px] bg-[color-mix(in_srgb,var(--gold)_9%,var(--panel))] px-3 py-2 text-[12px] leading-[1.7] text-[var(--gold)]">
              提示：本书还没有总纲。先在「总纲」页生成总纲，剧情线会更贴合全书规划。
            </p>
          )}
          {err && (
            <p className="rounded-[9px] bg-[color-mix(in_srgb,var(--seal)_8%,var(--panel))] px-3 py-2 text-[12px] leading-[1.7] text-[var(--seal)]">
              {err}
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-faint)]" role="status" aria-live="polite">
              {busy ? 'AI 正在通读总纲拆解剧情线，约需 30~60 秒……' : ''}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => run('append')}
                disabled={busy}
                className="btn btn--ghost btn--md text-[var(--jade)]"
              >
                追加规划
              </button>
              <button onClick={() => run('replace')} disabled={busy} className="btn btn--primary btn--md">
                重新规划全部
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-[var(--text-dim)]">
            共 {parsed.length} 条，已选 {picked.length} 条（点击卡片可排除）。确认后可选择追加到现有剧情线，或替换全部。
          </p>
          <div className="space-y-2">
            {parsed.map(l => {
              const off = excluded.has(l.id)
              return (
                <button
                  key={l.id}
                  onClick={() => toggle(l.id)}
                  aria-pressed={!off}
                  aria-label={`${off ? '选择' : '排除'}剧情线「${l.name}」`}
                  className={`w-full rounded-[9px] border p-3 text-left transition ${off ? 'border-[var(--line)] opacity-40' : 'border-[color-mix(in_srgb,var(--jade)_30%,var(--line))] bg-[color-mix(in_srgb,var(--jade)_5%,var(--panel))]'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded-[7px] bg-[var(--panel3)] px-1.5 py-px text-[10px] text-[var(--text-dim)]">
                      {l.type}
                    </span>
                    <span className="text-[13px] font-medium text-[var(--text)]">{l.name}</span>
                    <span className="ml-auto text-[10px] text-[var(--text-faint)]">
                      {off ? '已排除' : `${l.beats.length} 个节点`}
                    </span>
                  </div>
                  {l.goal && <div className="mt-1 text-[11px] text-[var(--text-dim)]">目标：{l.goal}</div>}
                  <div className="mt-1 text-[11px] leading-relaxed text-[var(--text-faint)]">
                    {l.beats
                      .slice(0, 5)
                      .map(b => `「${b.title}」${b.chapter ? `(${b.chapter}章)` : ''}`)
                      .join(' → ')}
                    {l.beats.length > 5 ? ' …' : ''}
                  </div>
                </button>
              )
            })}
          </div>
          {err && (
            <p className="rounded-[9px] bg-[color-mix(in_srgb,var(--seal)_8%,var(--panel))] px-3 py-2 text-[12px] leading-[1.7] text-[var(--seal)]">
              {err}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setParsed(null)
                setErr('')
              }}
              className="btn btn--ghost btn--md"
            >
              重新规划
            </button>
            <button
              onClick={() => onApply(picked, 'append')}
              disabled={!picked.length}
              className="btn btn--ghost btn--md text-[var(--jade)]"
            >
              追加到现有
            </button>
            <button
              onClick={() => onApply(picked, 'replace')}
              disabled={!picked.length}
              className="btn btn--primary btn--md"
            >
              替换现有（{picked.length} 条）
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  )
}

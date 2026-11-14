// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
import { memo, useState } from 'react'
import { inputCls, cardCls, SIcon, iconBtn, iconBtnDanger } from './shared'
import type { ChapterOutline } from '../../types'

type OutlineRowProps = {
  item: ChapterOutline
  total: number
  onChange: (patch: Partial<ChapterOutline>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}

// 章节可能上百条，逐条 memo 掉：只有自身 item 或回调引用变化时才重渲染。
// 回调须由父级用 useCallback(id) 稳定化，否则 memo 无效（见 Workspace.tsx）。
function OutlineRow({ item, total, onChange, onMove, onRemove }: OutlineRowProps) {
  const [open, setOpen] = useState(!!item.customPrompt)
  return (
    <div className={`${cardCls} card-lift p-4`}>
      <div className="flex items-center gap-2">
        <span className="mono w-14 shrink-0 text-[12px] font-medium text-[var(--text-dim)]">第 {item.index} 章</span>
        <input
          className="flex-1 rounded-[9px] border border-transparent bg-transparent px-2 py-1.5 text-[13px] font-medium text-[var(--text)] outline-none transition focus:border-[var(--line)] focus:bg-[var(--panel2)]"
          value={item.title}
          onChange={e => onChange({ title: e.target.value })}
          placeholder="章节标题"
          aria-label={`第 ${item.index} 章标题`}
        />
        <div className="flex shrink-0 items-center gap-0.5 text-[var(--text-faint)]">
          <button
            onClick={() => onMove(-1)}
            disabled={item.index <= 1}
            className={`${iconBtn} hover:!bg-[var(--panel3)] hover:!text-[var(--gold)] disabled:pointer-events-none disabled:opacity-30`}
            aria-label={`把第 ${item.index} 章上移`}
            title="上移"
          >
            <SIcon name="up" size={12} />
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={item.index >= total}
            className={`${iconBtn} hover:!bg-[var(--panel3)] hover:!text-[var(--gold)] disabled:pointer-events-none disabled:opacity-30`}
            aria-label={`把第 ${item.index} 章下移`}
            title="下移"
          >
            <SIcon name="down" size={12} />
          </button>
          <button onClick={onRemove} className={iconBtnDanger} aria-label={`删除第 ${item.index} 章`} title="删除本章">
            <SIcon name="x" size={11} />
          </button>
        </div>
      </div>
      <textarea
        className={`${inputCls} mt-3 leading-relaxed`}
        rows={8}
        value={item.summary}
        onChange={e => onChange({ summary: e.target.value })}
        placeholder={
          '本章框架：\n【开场】场景、氛围、切入画面\n【事件】1. … 2. … 3. …\n【交锋】人物互动与冲突\n【情感】主角情感弧线\n【钩子】结尾悬念'
        }
        aria-label={`第 ${item.index} 章内容框架`}
      />
      <button
        onClick={() => setOpen(o => !o)}
        className={`mt-2.5 text-[12px] transition-colors ${item.customPrompt ? 'text-[var(--gold)]' : 'text-[var(--text-faint)] hover:text-[var(--text-dim)]'}`}
        aria-expanded={open}
      >
        {open ? '— 收起本章指令' : `+ 本章专属指令${item.customPrompt ? '（已填写）' : ''}`}
      </button>
      {open && (
        <textarea
          className={`${inputCls} mt-2 border-[var(--gold)]/30`}
          rows={4}
          value={item.customPrompt}
          onChange={e => onChange({ customPrompt: e.target.value })}
          placeholder={
            '本章优先级最高的写作指令，将原样交给 AI。例如：\n· 以雨夜追逐战开场，节奏要快\n· 重点刻画反派出场，先礼后兵\n· 结尾让主角捡到半块玉佩，埋下身世伏笔'
          }
          aria-label={`第 ${item.index} 章专属指令`}
        />
      )}
    </div>
  )
}

export default memo(OutlineRow)

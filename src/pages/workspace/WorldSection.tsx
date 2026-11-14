// 世界观分区：世界观设定 / 剧情元素 / 额外要求三栏做成折叠行（图标 + 名称 + 一行预览），展开即编辑。
import { useId, useState } from 'react'
import './sections.css'
import { inputCls, Icon, type IconName } from './shared'
import type { Novel } from '../../types'

type WorldKey = 'worldview' | 'elements' | 'extraRequirements'

const ROWS: { key: WorldKey; label: string; hint: string; icon: IconName; rows: number; placeholder: string }[] = [
  {
    key: 'worldview',
    label: '世界观设定',
    hint: '力量体系、势力、地理、规则等',
    icon: 'globe',
    rows: 7,
    placeholder: '例如：修炼等级分为炼气、筑基、金丹……；大陆分为四大帝国……'
  },
  {
    key: 'elements',
    label: '剧情元素',
    hint: '爽点、感情线、禁忌、梗等',
    icon: 'flame',
    rows: 5,
    placeholder: '例如：扮猪吃虎、打脸逆袭、双强联手；前期埋下身世之谜伏笔'
  },
  {
    key: 'extraRequirements',
    label: '额外要求',
    hint: '每一章生成时都会遵守',
    icon: 'rules',
    rows: 4,
    placeholder: '例如：每章至少一次打斗；对话口语化；禁止出现现代词汇'
  }
]

function WorldRow({
  row,
  value,
  onChange
}: {
  row: (typeof ROWS)[number]
  value: string
  onChange: (v: string) => void
}) {
  // 空栏默认展开（新书直接能填），已有内容的栏先收起成一行预览
  const [open, setOpen] = useState(() => !value.trim())
  const bodyId = useId()
  const preview = value.replace(/\s+/g, ' ').trim().slice(0, 160)

  return (
    <div className={`ink-card plan-world__row${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="plan-world__toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        aria-label={row.label}
      >
        <Icon name={row.icon} size={18} className="plan-world__icon" />
        <span className="plan-world__label">{row.label}</span>
        <span className={`plan-world__preview${preview ? '' : ' is-empty'}`} aria-hidden="true">
          {preview || `未填写 · ${row.hint}`}
        </span>
        <Icon name="chevronDown" size={16} className="plan-world__chev" />
      </button>
      {open && (
        <div id={bodyId} className="plan-world__body">
          <p className="plan-world__hint">{row.hint}</p>
          <textarea
            className={inputCls}
            rows={row.rows}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={row.placeholder}
            aria-label={`${row.label}（${row.hint}）`}
          />
        </div>
      )}
    </div>
  )
}

export default function WorldSection({
  draft,
  update
}: {
  draft: Pick<Novel, WorldKey>
  update: (patch: Partial<Novel>) => void
}) {
  return (
    <div className="plan-world">
      {ROWS.map(r => (
        <WorldRow key={r.key} row={r} value={draft[r.key] || ''} onChange={v => update({ [r.key]: v })} />
      ))}
    </div>
  )
}

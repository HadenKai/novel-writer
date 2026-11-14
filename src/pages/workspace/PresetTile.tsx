// 文风 / 写作模板 / 写作技能的选择块：选中为鎏金框 + 淡金底（技能启用用竹青）；自建项带「编辑 / 删除」。
import type { ReactNode } from 'react'
import './sections.css'
import { SIcon } from './shared'

export default function PresetTile({
  name,
  selected,
  tone = 'gold',
  title,
  custom,
  onSelect,
  onEdit,
  onDelete,
  children
}: {
  name: string
  selected: boolean
  tone?: 'gold' | 'jade'
  title?: string
  /** 名称后的小字标记（「自建」「内置」） */
  custom?: ReactNode
  onSelect: () => void
  onEdit?: () => void
  onDelete?: () => void
  children?: ReactNode
}) {
  return (
    <div className={`plan-tile${tone === 'jade' ? ' plan-tile--jade' : ''}${selected ? ' is-selected' : ''}`}>
      <button type="button" className="plan-tile__main" aria-pressed={selected} onClick={onSelect} title={title}>
        <span className="plan-tile__name">
          {name}
          {custom}
        </span>
        {children}
      </button>
      {selected && (
        <span className="plan-tile__check" aria-hidden="true">
          <SIcon name="check" size={12} />
        </span>
      )}
      {(onEdit || onDelete) && (
        <div className="plan-tile__ops">
          {onEdit && (
            <button type="button" className="plan-tile__op" onClick={onEdit} aria-label={`编辑「${name}」`}>
              编辑
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="plan-tile__op plan-tile__op--danger"
              onClick={onDelete}
              aria-label={`删除「${name}」`}
            >
              删除
            </button>
          )}
        </div>
      )}
    </div>
  )
}

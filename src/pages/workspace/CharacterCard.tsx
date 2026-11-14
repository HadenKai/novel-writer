// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
// 墨金人物卡：宣纸画像 + 姓名 / 身份 / 性格标签 / 一句话小传；「查看 / 编辑」在卡内展开全部字段。
import { memo, useRef, useState } from 'react'
import './character-card.css'
import { inputCls, Icon, SIcon, iconBtnDanger, splitTraits } from './shared'
import Field from './Field'
import { InkLandscape, Seal } from '../../components/InkArt'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import type { Character } from '../../types'

const PORTRAIT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const PORTRAIT_MAX = 5 * 1024 * 1024

type CharacterCardProps = {
  title: string
  char: Character
  onChange: (patch: Partial<Character>) => void
  onRemove?: () => void
  /** 主角卡：画像角上加一枚「主」字朱砂印 */
  lead?: boolean
}

// 配角列表可能很长，逐卡 memo：只有本卡数据/回调变化才重渲染。
function CharacterCard({ title, char, onChange, onRemove, lead }: CharacterCardProps) {
  // 刚添加的空白角色直接展开编辑；已有内容的角色先看卡片
  const [open, setOpen] = useState(() => !(char.name || '').trim() && !(char.role || '').trim())
  const name = (char.name || '').trim()
  const role = (char.role || '').trim()
  const traits = splitTraits(char.personality)
  const bio = (char.background || char.notes || '').replace(/\s+/g, ' ').trim()
  const initial = Array.from(name)[0]
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  // 文件被回收或手动删掉时不显示破图，退回墨色占位
  const [broken, setBroken] = useState('')
  const photo = char.portrait && broken !== char.portrait ? api.portraitUrl(char.portrait) : ''

  const upload = async (file?: File | null) => {
    if (!file || uploading) return
    if (!PORTRAIT_TYPES.includes(file.type)) return toast.error('只支持 PNG / JPG / WebP / GIF 图片')
    if (file.size > PORTRAIT_MAX) return toast.error('图片过大，请压缩到 5MB 以内')
    setUploading(true)
    try {
      const { file: saved } = await api.uploadPortrait(file)
      onChange({ portrait: saved })
    } catch (e) {
      toast.error(`照片上传失败：${(e as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <article className={`ink-card plan-char${open ? ' is-open' : ''}`} aria-label={title}>
      <div className="plan-char__summary">
        <button
          type="button"
          className={`plan-char__portrait${photo ? ' has-photo' : ''}${dragging ? ' is-dragging' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            void upload(e.dataTransfer.files?.[0])
          }}
          disabled={uploading}
          aria-label={`${photo ? '更换' : '上传'}${name || title}的照片`}
          title="点击或拖入图片，作为人物照片"
        >
          {photo ? (
            <img src={photo} alt="" className="plan-char__photo" onError={() => setBroken(char.portrait || '')} />
          ) : (
            <>
              <InkLandscape className="plan-char__hills" moon={false} />
              {initial ? (
                <span className="plan-char__glyph">{initial}</span>
              ) : (
                <Icon name="user" size={34} className="plan-char__glyph-icon" />
              )}
            </>
          )}
          <span className="plan-char__upload" aria-hidden="true">
            <Icon name="camera" size={18} />
            <span>{uploading ? '上传中…' : photo ? '更换照片' : '上传照片'}</span>
          </span>
          {lead && <Seal text="主" size={20} className="plan-char__seal" />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={PORTRAIT_TYPES.join(',')}
          className="hidden"
          aria-label={`选择${name || title}的照片`}
          onChange={e => {
            void upload(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <div className="plan-char__body">
          <h3 className={`plan-char__name${name ? '' : ' is-empty'}`}>{name || '未命名角色'}</h3>
          <p className="plan-char__role">{role || (lead ? '主角' : '配角')}</p>
          {traits.length > 0 && (
            <ul className="plan-char__traits" aria-label="性格">
              {traits.map((t, i) => (
                <li key={`${t}-${i}`} className="ink-pill ink-pill--gold" title={t}>
                  {t}
                </li>
              ))}
            </ul>
          )}
          <hr className="ink-rule plan-char__rule" />
          <p className={`plan-char__bio${bio ? '' : ' is-empty'}`}>{bio || '还没有背景经历，展开后补充。'}</p>
          <div className="plan-char__foot">
            <button
              type="button"
              className="plan-char__toggle"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-label={`${open ? '收起' : '查看 / 编辑'}${title}`}
            >
              <Icon name="edit" size={15} />
              <span>{open ? '收起' : '查看 / 编辑'}</span>
              <SIcon name="chevron" size={14} className="plan-char__chev" />
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className={iconBtnDanger}
                aria-label={`删除${title}`}
                title={`删除${title}`}
              >
                <Icon name="trash" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {open && (
        <div className="plan-char__editor">
          <div className="plan-char__photo-row">
            <span className="plan-char__photo-label">人物照片</span>
            <span className="plan-char__photo-hint">
              {photo ? '已设置，随设定一起保存' : '支持 PNG / JPG / WebP / GIF，5MB 以内，也可以直接拖到左侧画像上'}
            </span>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="camera" size={14} />
              {uploading ? '上传中…' : photo ? '更换' : '上传'}
            </button>
            {char.portrait && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange({ portrait: '' })}>
                移除
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="姓名">
              <input
                className={inputCls}
                value={char.name}
                onChange={e => onChange({ name: e.target.value })}
                placeholder="角色名"
              />
            </Field>
            <Field label="身份 / 定位">
              <input
                className={inputCls}
                value={char.role}
                onChange={e => onChange({ role: e.target.value })}
                placeholder="例如：青梅竹马 / 反派宗主"
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="性格">
              <textarea
                className={inputCls}
                rows={2}
                value={char.personality}
                onChange={e => onChange({ personality: e.target.value })}
                placeholder="例如：外冷内热，杀伐果断，重视承诺"
              />
            </Field>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="外貌">
              <textarea
                className={inputCls}
                rows={2}
                value={char.appearance}
                onChange={e => onChange({ appearance: e.target.value })}
                placeholder="外貌特征"
              />
            </Field>
            <Field label="背景经历">
              <textarea
                className={inputCls}
                rows={2}
                value={char.background}
                onChange={e => onChange({ background: e.target.value })}
                placeholder="出身、经历、目标"
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="补充说明（可选）">
              <input
                className={inputCls}
                value={char.notes}
                onChange={e => onChange({ notes: e.target.value })}
                placeholder="口头禅、禁忌、特殊能力等"
              />
            </Field>
          </div>
        </div>
      )}
    </article>
  )
}

export default memo(CharacterCard)

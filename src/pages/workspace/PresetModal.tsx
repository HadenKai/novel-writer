// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
import { useId, useState } from 'react'
import { api } from '../../lib/api'
import { alertDialog } from '../../components/Dialog'
import ModalShell from '../../components/ModalShell'
import { inputCls, labelCls } from './shared'
export type EditTarget =
  | { type: 'style'; item: { id?: string; name: string; tag: string; desc: string; prompt: string } }
  | { type: 'template'; item: { id?: string; name: string; desc: string; rules: string } }
  | { type: 'skill'; item: { id?: string; name: string; description: string; tags: string[]; content: string } }

export default function PresetModal({
  target,
  onClose,
  onSaved
}: {
  target: EditTarget
  onClose: () => void
  onSaved: () => void
}) {
  const isStyle = target.type === 'style'
  const isTemplate = target.type === 'template'
  const isSkill = target.type === 'skill'
  const [form, setForm] = useState<Record<string, string>>({
    name: target.item.name || '',
    tag: 'tag' in target.item ? target.item.tag || '' : '',
    desc: 'desc' in target.item ? target.item.desc || '' : '',
    description: 'description' in target.item ? target.item.description || '' : '',
    prompt: 'prompt' in target.item ? target.item.prompt || '' : '',
    rules: 'rules' in target.item ? target.item.rules || '' : '',
    tags: 'tags' in target.item ? (target.item.tags || []).join('、') : '',
    content: 'content' in target.item ? target.item.content || '' : ''
  })
  const [saving, setSaving] = useState(false)
  const patch = (p: Record<string, string>) => setForm(f => ({ ...f, ...p }))

  const save = async () => {
    if (!form.name?.trim()) return void alertDialog({ title: '名称不能为空', body: '请先填写名称。', tone: 'warning' })
    setSaving(true)
    try {
      if (isSkill) {
        const body = {
          name: form.name.trim(),
          description: form.description?.trim() || '',
          tags: (form.tags || '')
            .split(/[、,\s]+/)
            .map(s => s.trim())
            .filter(Boolean),
          content: form.content?.trim() || ''
        }
        if (!body.content) return void alertDialog({ title: '内容不能为空', body: '请填写技能内容。', tone: 'warning' })
        if (target.item.id) await api.updateCustomSkill(target.item.id, body)
        else await api.saveCustomSkill(body)
      } else {
        const body = isStyle
          ? {
              name: form.name.trim(),
              tag: (form.tag || '自定义').trim(),
              desc: form.desc?.trim() || form.prompt?.slice(0, 40),
              prompt: form.prompt?.trim() || ''
            }
          : { name: form.name.trim(), desc: form.desc?.trim() || '', rules: form.rules?.trim() || '' }
        if (isStyle && !body.prompt)
          return void alertDialog({ title: '提示词不能为空', body: '请填写文风提示词内容。', tone: 'warning' })
        if (isTemplate && !body.rules)
          return void alertDialog({ title: '规则不能为空', body: '请填写规则内容（每行一条）。', tone: 'warning' })
        if (target.item.id) {
          if (isStyle)
            await api.updateCustomStyle(
              target.item.id,
              body as { name: string; tag: string; desc: string; prompt: string }
            )
          else await api.updateCustomTemplate(target.item.id, body as { name: string; desc: string; rules: string })
        } else {
          if (isStyle) await api.saveCustomStyle(body as { name: string; tag: string; desc: string; prompt: string })
          else await api.saveCustomTemplate(body as { name: string; desc: string; rules: string })
        }
      }
      onSaved()
      onClose()
    } catch (e) {
      alertDialog({ title: '保存失败', body: (e as Error).message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const title = target.item.id ? '编辑' : '新建'
  const typeName = isStyle ? '文风' : isTemplate ? '模板' : '技能'
  const uid = useId()

  return (
    <ModalShell title={`${title}${typeName}`} width={560} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls} htmlFor={`${uid}-name`}>
              名称
            </label>
            <input
              id={`${uid}-name`}
              className={inputCls}
              value={form.name || ''}
              onChange={e => patch({ name: e.target.value })}
              placeholder={typeName}
            />
          </div>
          {isStyle && (
            <div>
              <label className={labelCls} htmlFor={`${uid}-tag`}>
                标签（流派一句话）
              </label>
              <input
                id={`${uid}-tag`}
                className={inputCls}
                value={form.tag || ''}
                onChange={e => patch({ tag: e.target.value })}
                placeholder="例如：冷峻 · 悬疑"
              />
            </div>
          )}
          {isSkill && (
            <div>
              <label className={labelCls} htmlFor={`${uid}-tags`}>
                标签（用顿号分隔）
              </label>
              <input
                id={`${uid}-tags`}
                className={inputCls}
                value={form.tags || ''}
                onChange={e => patch({ tags: e.target.value })}
                placeholder="例如：节奏、技法"
              />
            </div>
          )}
        </div>
        <div>
          <label className={labelCls} htmlFor={`${uid}-desc`}>
            简介
          </label>
          <input
            id={`${uid}-desc`}
            className={inputCls}
            value={form.desc || form.description || ''}
            onChange={e => patch({ desc: e.target.value, description: e.target.value })}
            placeholder="一句话说明这种写法的气质"
          />
        </div>
        {isStyle ? (
          <div>
            <label className={labelCls} htmlFor={`${uid}-prompt`}>
              文风提示词（写给 AI 的模仿规则，一条一行）
            </label>
            <textarea
              id={`${uid}-prompt`}
              className={inputCls}
              rows={9}
              value={form.prompt || ''}
              onChange={e => patch({ prompt: e.target.value })}
              placeholder={
                '例如：\n多写天气与光线的变化\n对话简短，每句不超过十五个字\n情绪靠动作侧写，禁止直接抒情\n每章结尾用一句景物描写收束'
              }
            />
          </div>
        ) : isTemplate ? (
          <div>
            <label className={labelCls} htmlFor={`${uid}-rules`}>
              写作规则（每行一条，将注入每章生成指令）
            </label>
            <textarea
              id={`${uid}-rules`}
              className={inputCls}
              rows={9}
              value={form.rules || ''}
              onChange={e => patch({ rules: e.target.value })}
              placeholder={'例如：\n每章以一个具体动作开场\n每八百字安排一次小冲突\n关键道具至少出现两次'}
            />
          </div>
        ) : (
          <div>
            <label className={labelCls} htmlFor={`${uid}-content`}>
              技能内容（将原样注入每章生成提示词）
            </label>
            <textarea
              id={`${uid}-content`}
              className={inputCls}
              rows={9}
              value={form.content || ''}
              onChange={e => patch({ content: e.target.value })}
              placeholder={'例如：\n本章必须在一句话内进入冲突\n结尾用未落地的动作做钩子\n每三百字安排一次信息增量'}
            />
          </div>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} className="btn btn--ghost btn--md">
          取消
        </button>
        <button onClick={save} disabled={saving} className="btn btn--primary btn--md">
          {saving ? '保存中……' : '保存'}
        </button>
      </div>
    </ModalShell>
  )
}

// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
import { useState } from 'react'
import { api } from '../../lib/api'
import ModalShell from '../../components/ModalShell'
import { inputCls, labelCls } from './shared'
export default function SkillImportModal({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: (count: number, failed: string[], skipped: string[]) => void
}) {
  const [text, setText] = useState('')
  const [fileNames, setFileNames] = useState<string[]>([])
  const [files, setFiles] = useState<{ name: string; text: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const pickFiles = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
    input.multiple = true
    input.onchange = async () => {
      const list = Array.from(input.files || [])
      if (!list.length) return
      const items = await Promise.all(list.map(async f => ({ name: f.name, text: await f.text() })))
      setFiles(items)
      setFileNames(items.map(i => i.name))
      setErr('')
    }
    input.click()
  }

  const doImport = async () => {
    const items = [...files, ...(text.trim() ? [{ name: '粘贴的技能', text: text.trim() }] : [])]
    if (!items.length) return setErr('请先选择 .md 文件或粘贴技能内容')
    setBusy(true)
    setErr('')
    try {
      const r = await api.importSkills(items)
      onImported(r.saved.length, r.failed || [], r.skipped || [])
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell title="导入技能" width={560} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-[var(--text-dim)]">
          支持两种方式：<b>① 选择 .md 文件</b>（可多选，frontmatter 里的 name/description/tags 会被识别）；
          <b>② 直接粘贴 Markdown</b>。没有 frontmatter 也能导入——文件名会作为技能名。
        </p>
        <div className="flex items-center gap-3">
          <button onClick={pickFiles} className="btn btn--ghost btn--md">
            选择 .md 文件…
          </button>
          {fileNames.length > 0 && (
            <span
              className="min-w-0 flex-1 truncate text-[11px] text-[var(--jade)]"
              title={fileNames.join('、')}
              role="status"
              aria-live="polite"
            >
              已选 {fileNames.length} 个：{fileNames.join('、')}
            </span>
          )}
        </div>
        <div>
          <label className={labelCls} htmlFor="skill-import-md">
            或粘贴技能 Markdown
          </label>
          <textarea
            id="skill-import-md"
            className={`${inputCls} leading-relaxed`}
            rows={10}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={
              '---\nname: 反派登场\ndescription: 反派出场的压迫感写法\ntags: 人物、氛围\n---\n\n反派首次出场不得直接写外貌，先用环境异动与旁观者反应垫压迫感……'
            }
          />
        </div>
        {err && (
          <p className="rounded-[9px] bg-[color-mix(in_srgb,var(--seal)_8%,var(--panel))] px-3 py-2 text-[12px] leading-[1.7] text-[var(--seal)]">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn btn--ghost btn--md">
            取消
          </button>
          <button onClick={doImport} disabled={busy} className="btn btn--primary btn--md">
            {busy ? '导入中……' : '导入'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

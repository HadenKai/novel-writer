// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
import { useState } from 'react'
import { api } from '../../lib/api'
import ModalShell from '../../components/ModalShell'
import { inputCls } from './shared'
import type { ParsedSettings } from '../../types'
export default function SmartImportModal({
  novelId,
  modelId,
  onClose,
  onApply
}: {
  novelId: string
  modelId: string
  onClose: () => void
  onApply: (p: ParsedSettings, replaceChars: boolean) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [parsed, setParsed] = useState<ParsedSettings | null>(null)
  const [replaceChars, setReplaceChars] = useState(false)

  const run = async () => {
    if (!text.trim()) return setErr('请先粘贴设定内容')
    setBusy(true)
    setErr('')
    try {
      const r = await api.parseSettings(novelId, modelId, text.trim())
      if (!r?.parsed) throw new Error('解析结果为空')
      setParsed(r.parsed)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const hasNothing =
    !!parsed &&
    !parsed.title &&
    !parsed.genre &&
    !parsed.pov &&
    !parsed.synopsis &&
    !parsed.worldview &&
    !parsed.elements &&
    !parsed.extraRequirements &&
    !Object.values(parsed.protagonist).some(v => !!v) &&
    parsed.characters.length === 0

  const row = (label: string, value: string) =>
    value ? (
      <div key={label} className="flex gap-3 text-xs leading-relaxed">
        <span className="w-16 shrink-0 pt-px text-[var(--text-faint)]">{label}</span>
        <span className="min-w-0 flex-1 break-words text-[var(--text)]">{value}</span>
      </div>
    ) : null

  return (
    <ModalShell title="AI 智能分配设定" width={620} onClose={onClose} busy={busy}>
      {!parsed ? (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-[var(--text-dim)]">
            把手头的设定一股脑粘进来——主角配角、世界观力量体系、爽点伏笔、硬性要求……格式随意，AI
            会自动分拣到各栏目（书名 / 类型 / 视角 / 简介 / 主角 / 配角 / 世界观 / 剧情元素 / 额外要求）。
          </p>
          <textarea
            className={`${inputCls} leading-relaxed`}
            rows={12}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={
              '例如：\n主角叫林晚，女，26 岁，法医，性格冷静毒舌但心软……\n男二沈修言，刑警队长，外冷内热……\n世界观：现代都市，存在一种「共感」能力……\n爽点：单元案件 + 主线阴谋双线并进\n要求：推理要严谨，禁止恋爱脑'
            }
            aria-label="待分拣的设定文本"
          />
          {err && (
            <p className="rounded-[9px] bg-[color-mix(in_srgb,var(--seal)_8%,var(--panel))] px-3 py-2 text-[12px] leading-[1.7] text-[var(--seal)]">
              {err}
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-faint)]" role="status" aria-live="polite">
              {busy ? 'AI 正在分拣设定，约需 10~30 秒……' : `使用本书所选模型${modelId ? '' : '（默认）'}`}
            </span>
            <button onClick={run} disabled={busy} className="btn btn--primary btn--md">
              {busy ? '分拣中……' : '开始分拣'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {hasNothing ? (
            <p className="rounded-[9px] bg-[color-mix(in_srgb,var(--seal)_8%,var(--panel))] px-3 py-3 text-[12px] leading-[1.7] text-[var(--seal)]">
              没有从这段文字里识别出可用设定——请检查内容后重新分拣；内容太简短时手动填写反而更快。
            </p>
          ) : (
            <>
              <div className="space-y-2 rounded-[9px] border border-transparent bg-[var(--panel2)] p-4">
                {row('书名', parsed.title)}
                {row('类型', parsed.genre)}
                {row('视角', parsed.pov === 'first' ? '第一人称' : parsed.pov === 'third' ? '第三人称' : '')}
                {row('简介', parsed.synopsis.length > 120 ? parsed.synopsis.slice(0, 120) + '……' : parsed.synopsis)}
                {row(
                  '主角',
                  [parsed.protagonist.name, parsed.protagonist.role, parsed.protagonist.personality]
                    .filter(Boolean)
                    .join(' · ')
                )}
                {row(
                  '世界观',
                  parsed.worldview.length > 120 ? parsed.worldview.slice(0, 120) + '……' : parsed.worldview
                )}
                {row('剧情元素', parsed.elements)}
                {row('额外要求', parsed.extraRequirements)}
                {parsed.characters.length > 0 && (
                  <div className="flex gap-3 text-xs leading-relaxed">
                    <span className="w-16 shrink-0 pt-px text-[var(--text-faint)]">
                      配角 ×{parsed.characters.length}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-[var(--text)]">
                      {parsed.characters.map(c => `${c.name}${c.role ? `（${c.role}）` : ''}`).join('、')}
                    </span>
                  </div>
                )}
              </div>
              {parsed.characters.length > 0 && (
                <fieldset className="flex flex-wrap items-center gap-4 text-xs">
                  <legend className="sr-only">配角导入方式</legend>
                  <span className="text-[var(--text-dim)]" aria-hidden>
                    配角导入方式：
                  </span>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[var(--text)]">
                    <input
                      type="radio"
                      name="replaceChars"
                      className="accent-[var(--gold)]"
                      checked={!replaceChars}
                      onChange={() => setReplaceChars(false)}
                    />
                    追加（同名跳过）
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[var(--text)]">
                    <input
                      type="radio"
                      name="replaceChars"
                      className="accent-[var(--gold)]"
                      checked={replaceChars}
                      onChange={() => setReplaceChars(true)}
                    />
                    替换全部现有配角
                  </label>
                </fieldset>
              )}
              <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">
                空缺字段不会覆盖你已填写的内容；应用后可到各标签页检查微调，Ctrl+S 保存。
              </p>
            </>
          )}
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
              返回修改
            </button>
            <button
              onClick={() => onApply(parsed, replaceChars)}
              disabled={!!hasNothing}
              className="btn btn--primary btn--md"
            >
              应用到设定表
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  )
}

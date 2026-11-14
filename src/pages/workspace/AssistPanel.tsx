// AI 设定助手（设定工作台右栏）。这里不直接调用模型：问题交给「与 AI 讨论」，
// 由 Workspace 先保存设定、把问题写进讨论页的输入框草稿，再跳过去，作者确认后自己发送。
import { useRef, useState } from 'react'
import './assist.css'
import { Icon, SIcon } from './shared'
import { Emblem } from '../../components/InkArt'

const SUGGESTIONS = [
  {
    label: '补全人物弧光',
    text: '请根据本书现有的人物设定，为主要角色补全成长弧光：起点状态、关键转折、终点状态，并指出与主线剧情的呼应点。'
  },
  {
    label: '检查设定冲突',
    text: '请通读本书的人物、世界观与剧情元素，找出互相矛盾或前后不一致的设定，逐条列出并给出修改建议。'
  },
  {
    label: '丰富世界观',
    text: '请在不改动已有设定的前提下，为本书世界观补充势力、地理与力量体系的细节，标出可以埋伏笔的地方。'
  },
  {
    label: '梳理人物关系',
    text: '请梳理本书主要人物之间的关系与潜在冲突点，并建议两三处可以加深人物张力的情节。'
  }
]

export default function AssistPanel({
  onAsk,
  onCollapse
}: {
  /** 交给「与 AI 讨论」；成功时页面会跳走，失败时返回错误文案 */
  onAsk: (text: string) => Promise<string | void>
  onCollapse: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 点建议：填进输入框（已有内容时另起一行追加），由作者确认后再发送
  const pick = (s: string) => {
    const next = text.trim() ? `${text.trimEnd()}\n${s}` : s
    setText(next)
    setErr('')
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.length, next.length)
    })
  }

  const submit = async () => {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true)
    setErr('')
    try {
      const msg = await onAsk(q)
      if (msg) setErr(msg)
    } catch (e) {
      setErr((e as Error).message || '没能打开「与 AI 讨论」，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="ink-card plan-assist" aria-label="AI 设定助手">
      <div className="plan-assist__head">
        <h2 className="plan-assist__title">
          <Icon name="sparkle" size={17} />
          AI 设定助手
        </h2>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-faint)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          onClick={onCollapse}
          aria-label="收起 AI 设定助手"
          title="收起"
        >
          <Icon name="minus" size={16} />
        </button>
      </div>

      <div className="plan-assist__body">
        <div className="plan-assist__intro">
          <Emblem size={34}>
            <Icon name="book" size={17} />
          </Emblem>
          <div className="ink-paper ink-on-paper plan-assist__bubble">
            <p>想补人物、查矛盾、扩世界观，都可以在这里提问。</p>
            <ul>
              <li>先保存当前设定</li>
              <li>问题带到「与 AI 讨论」</li>
              <li>AI 结合本书设定作答</li>
            </ul>
          </div>
        </div>
        <div className="plan-assist__chips" role="group" aria-label="常用问题">
          {SUGGESTIONS.map(s => (
            <button
              key={s.label}
              type="button"
              className="plan-assist__chip"
              onClick={() => pick(s.text)}
              title={s.text}
            >
              <SIcon name="plus" size={12} />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <form
        className="plan-assist__form"
        onSubmit={e => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="plan-assist__box">
          <textarea
            ref={inputRef}
            className="plan-assist__input"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="请输入你的问题或需求……"
            aria-label="向 AI 设定助手提问"
            disabled={busy}
          />
          <button
            type="submit"
            className="plan-assist__send"
            disabled={busy || !text.trim()}
            aria-label="带到「与 AI 讨论」"
            title="保存设定并带到「与 AI 讨论」（Ctrl+Enter）"
          >
            <Icon name="send" size={18} />
          </button>
        </div>
        <p className={`plan-assist__note${err ? ' is-error' : ''}`} role="status" aria-live="polite">
          {err || (busy ? '正在保存设定……' : '发送后会先保存设定，再在「与 AI 讨论」里带上问题，确认后发送。')}
        </p>
      </form>
    </aside>
  )
}

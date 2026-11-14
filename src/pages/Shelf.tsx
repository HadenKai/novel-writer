import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { confirmDialog, alertDialog } from '../components/Dialog'
import { toast } from '../components/Toast'
import ModalShell from '../components/ModalShell'
import type { ShelfItem } from '../types'
import './resources.css'
import './resources-ink.css'

export default function Shelf() {
  const [kind, setKind] = useState<'material' | 'draft'>('material')
  const [items, setItems] = useState<ShelfItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ShelfItem | 'new' | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [deleting, setDeleting] = useState('')
  const [fullView, setFullView] = useState<ShelfItem | null>(null)
  const [copyError, setCopyError] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const [quick, setQuick] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const loadGen = useRef(0)
  const live = useRef(true)
  const saveLock = useRef(false)
  const deleteLock = useRef(false)
  const kindRef = useRef(kind)
  kindRef.current = kind

  // 切换类目或离开页面后，旧响应不可覆盖当前列表。
  const load = () => {
    if (!live.current) return
    const gen = ++loadGen.current
    setLoading(true)
    setError('')
    api
      .getShelf(kindRef.current)
      .then(list => {
        if (live.current && gen === loadGen.current) setItems(list)
      })
      .catch(e => {
        if (live.current && gen === loadGen.current) setError(e.message)
      })
      .finally(() => {
        if (live.current && gen === loadGen.current) setLoading(false)
      })
  }
  useEffect(() => {
    live.current = true
    const generation = loadGen
    return () => {
      live.current = false
      generation.current++
    }
  }, [])
  useEffect(() => {
    const generation = loadGen
    load()
    return () => {
      generation.current++
    }
  }, [kind])

  const openNew = () => {
    setTitle('')
    setContent('')
    setTags('')
    setSaveError('')
    setEditing('new')
  }
  const openEdit = (item: ShelfItem) => {
    setTitle(item.title)
    setContent(item.content)
    setTags((item.tags || []).join('、'))
    setSaveError('')
    setEditing(item)
  }
  const save = async () => {
    if (!editing || saveLock.current) return
    if (!title.trim()) return setSaveError('请先填写标题。')
    const isNew = editing === 'new'
    const savedKind = kind
    const data = {
      title: title.trim(),
      content,
      tags: tags
        .split(/[、,，\s]+/)
        .map(s => s.trim())
        .filter(Boolean)
    }
    saveLock.current = true
    setSaving(true)
    setSaveError('')
    try {
      if (isNew) await api.createShelf({ ...data, kind: savedKind })
      else await api.updateShelf(editing.id, data)
      if (!live.current) return
      setEditing(null)
      toast(isNew ? `已存入${savedKind === 'draft' ? '草稿箱' : '素材库'}，其他作品也能调用。` : '已保存。')
      load()
    } catch (e) {
      if (live.current) setSaveError((e as Error).message)
    } finally {
      saveLock.current = false
      if (live.current) setSaving(false)
    }
  }
  const remove = async (item: ShelfItem) => {
    if (deleteLock.current) return
    deleteLock.current = true
    try {
      const ok = await confirmDialog({
        title: `删除「${item.title}」？`,
        body: '此操作不可恢复。',
        confirmText: '删除',
        danger: true
      })
      if (!ok || !live.current) return
      setDeleting(item.id)
      await api.deleteShelf(item.id)
      if (live.current) {
        toast('已删除。')
        load()
      }
    } catch (e) {
      if (live.current) void alertDialog({ title: '删除失败', body: (e as Error).message, tone: 'error' })
    } finally {
      deleteLock.current = false
      if (live.current) setDeleting('')
    }
  }
  const copy = async (item: ShelfItem) => {
    setCopyError('')
    try {
      await navigator.clipboard.writeText(item.content)
      if (live.current) {
        setCopiedId(item.id)
        toast(`已复制「${item.title}」全文，可粘贴到任意作品。`)
      }
    } catch {
      if (live.current) setCopyError('复制失败，请打开全文后选中文字手动复制。')
    }
  }
  /** 随手记：第一条非空行当标题（截 20 字），全文存内容；不弹窗、不打断写作 */
  const quickSave = async () => {
    const text = quick.trim()
    if (!text || quickBusy) return
    setQuickBusy(true)
    try {
      const first = text.split(/\n/).find(line => line.trim()) || text
      await api.createShelf({
        kind,
        title: first.trim().slice(0, 20),
        content: text,
        tags: []
      })
      setQuick('')
      toast.success(`已存入${kind === 'draft' ? '草稿箱' : '素材库'}。`)
      load()
    } catch (e) {
      void alertDialog({ title: '保存失败', body: (e as Error).message, tone: 'error' })
    } finally {
      if (live.current) setQuickBusy(false)
    }
  }

  const needle = query.trim().toLocaleLowerCase()
  const filtered = items.filter(
    item =>
      !needle ||
      [item.title, item.content, ...(item.tags || [])].some(text => text.toLocaleLowerCase().includes(needle))
  )
  const actionLabel = kind === 'draft' ? '记录草稿' : '添加素材'

  return (
    <div className="resources-scope resources-page resources-shelf">
      <header className="resources-page-header">
        <div>
          <h1>素材与草稿</h1>
          <p>收藏灵感、人物与段落，在不同作品之间自由取用。</p>
        </div>
        <button className="resources-button resources-button--primary" onClick={openNew}>
          {actionLabel}
        </button>
      </header>
      <form
        className="shelf-quick"
        onSubmit={e => {
          e.preventDefault()
          void quickSave()
        }}
      >
        <label className="shelf-quick-field">
          <span className="resources-visually-hidden">随手记一条灵感</span>
          <input
            value={quick}
            onChange={e => setQuick(e.target.value)}
            placeholder="随手记一条灵感…"
            disabled={quickBusy}
          />
        </label>
        <button
          type="submit"
          className="resources-button resources-button--primary"
          disabled={!quick.trim() || quickBusy}
        >
          {quickBusy ? '记录中…' : '记录'}
        </button>
      </form>
      <div className="resources-toolbar">
        <div className="resources-segmented" role="group" aria-label="资料类型">
          <button
            aria-pressed={kind === 'material'}
            onClick={() => {
              setKind('material')
              setCopiedId('')
              setCopyError('')
            }}
          >
            素材
          </button>
          <button
            aria-pressed={kind === 'draft'}
            onClick={() => {
              setKind('draft')
              setCopiedId('')
              setCopyError('')
            }}
          >
            草稿
          </button>
        </div>
        <label className="resources-search">
          <span className="resources-visually-hidden">搜索标题、内容或标签</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索标题、内容或标签"
          />
        </label>
      </div>
      <div className="resources-shelf-meta">
        <span>
          {loading
            ? '正在读取…'
            : needle
              ? `${filtered.length} 条结果 / 共 ${items.length} 条`
              : `${items.length} 条${kind === 'draft' ? '草稿' : '素材'}`}
        </span>
        <span>跨作品共享 · 无需 AI 模型</span>
      </div>
      {error && (
        <div className="resources-notice resources-notice--error" role="alert">
          <span>读取失败：{error}</span>
          <button className="resources-button" onClick={load}>
            重新加载
          </button>
        </div>
      )}
      {copyError && (
        <p className="resources-notice resources-notice--error" role="alert">
          {copyError}
        </p>
      )}
      {loading ? (
        <div className="resources-empty" role="status">
          <h3>正在整理你的资料…</h3>
          <p>稍后即可查看素材与草稿。</p>
        </div>
      ) : error ? null : items.length === 0 ? (
        <div className="resources-empty">
          <span className="resources-empty-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M5 4h10l4 4v12H5zM15 4v5h4M8 13h8M8 16h5" />
            </svg>
          </span>
          <h2>{kind === 'draft' ? '让未完成的段落有个去处' : '从一条灵感开始'}</h2>
          <p>
            {kind === 'draft'
              ? '保存半成品开篇、待用情节或暂时搁置的段落，准备好时再继续。'
              : '人物小传、氛围描写、故事桥段，都可以保存在这里。复制全文，或让管家在写作时调用。'}
          </p>
          <button className="resources-button resources-button--primary" onClick={openNew}>
            {actionLabel}
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="resources-empty">
          <h3>没有找到匹配的资料</h3>
          <p>试试其他关键词，或清除搜索查看全部内容。</p>
          <button className="resources-button" onClick={() => setQuery('')}>
            清除搜索
          </button>
        </div>
      ) : (
        <div className="resources-card-grid">
          {filtered.map(item => (
            <article key={item.id} className="resources-reading-card">
              <div className="resources-card-meta">
                <span>
                  {kind === 'draft' ? '草稿' : '素材'} · {item.content.length.toLocaleString()} 字
                </span>
                <time dateTime={new Date(item.updatedAt).toISOString()}>
                  {new Date(item.updatedAt).toLocaleDateString('zh-CN')}
                </time>
              </div>
              <h2>
                <button
                  className="resources-card-title"
                  onClick={() => {
                    setFullView(item)
                    setCopyError('')
                  }}
                >
                  {item.title}
                </button>
              </h2>
              <p className="resources-card-excerpt">{item.content || '还没有正文，点击编辑补充内容。'}</p>
              {!!item.tags?.length && (
                <div className="resources-tags" aria-label="标签">
                  {item.tags.map((tag, index) => (
                    <span key={`${tag}-${index}`}>{tag}</span>
                  ))}
                </div>
              )}
              <div className="resources-card-actions">
                <button
                  className="resources-button resources-button--quiet resources-button--accent"
                  onClick={() => {
                    setFullView(item)
                    setCopyError('')
                  }}
                >
                  阅读全文
                </button>
                <button className="resources-button resources-button--quiet" onClick={() => copy(item)}>
                  {copiedId === item.id ? '已复制' : '复制'}
                </button>
                <button className="resources-button resources-button--quiet" onClick={() => openEdit(item)}>
                  编辑
                </button>
                <button
                  className="resources-button resources-button--quiet resources-button--danger"
                  disabled={!!deleting}
                  onClick={() => remove(item)}
                >
                  {deleting === item.id ? '删除中…' : '删除'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && (
        <ModalShell
          title={<span className="resources-scope">{editing === 'new' ? actionLabel : '编辑资料'}</span>}
          width={660}
          onClose={() => setEditing(null)}
          busy={saving}
        >
          <form
            className="resources-scope resources-form"
            onSubmit={e => {
              e.preventDefault()
              void save()
            }}
          >
            <fieldset className="resources-fields" disabled={saving}>
              <label className="resources-field">
                标题
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder={kind === 'draft' ? '例如：第五章的另一种开篇' : '例如：寒夜宅邸场景'}
                />
              </label>
              <label className="resources-field">
                内容
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  rows={12}
                  placeholder="记下灵感或段落。支持 Markdown，管家也能读取这些资料。"
                />
              </label>
              <label className="resources-field">
                标签<span className="resources-hint">用顿号、逗号或空格分隔，便于搜索。</span>
                <input value={tags} onChange={e => setTags(e.target.value)} placeholder="氛围、人物、城市" />
              </label>
            </fieldset>
            {saveError && (
              <p className="resources-notice resources-notice--error" role="alert">
                {saveError}
              </p>
            )}
            <div className="resources-modal-footer">
              <button
                type="button"
                className="resources-button resources-button--quiet"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button type="submit" className="resources-button resources-button--primary" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </ModalShell>
      )}
      {fullView && (
        <ModalShell
          title={<span className="resources-scope">{fullView.title}</span>}
          width={720}
          onClose={() => setFullView(null)}
        >
          <div className="resources-scope resources-reader">
            <div className="resources-card-meta">
              <span>{fullView.content.length.toLocaleString()} 字</span>
              <span>更新于 {new Date(fullView.updatedAt).toLocaleDateString('zh-CN')}</span>
            </div>
            {!!fullView.tags?.length && (
              <div className="resources-tags">
                {fullView.tags.map((tag, index) => (
                  <span key={`${tag}-${index}`}>{tag}</span>
                ))}
              </div>
            )}
            <div className="resources-reader-content">{fullView.content || '这条资料还没有正文。'}</div>
            {copyError && (
              <p className="resources-notice resources-notice--error" role="alert">
                {copyError}
              </p>
            )}
            <div className="resources-modal-footer">
              <button
                className="resources-button"
                onClick={() => {
                  setFullView(null)
                  openEdit(fullView)
                }}
              >
                编辑
              </button>
              <button className="resources-button resources-button--primary" onClick={() => copy(fullView)}>
                {copiedId === fullView.id ? '已复制全文' : '复制全文'}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  )
}

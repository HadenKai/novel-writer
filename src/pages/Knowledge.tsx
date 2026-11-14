import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { alertDialog, confirmDialog } from '../components/Dialog'
import { toast } from '../components/Toast'
import ModalShell from '../components/ModalShell'
import ModelSelect from '../components/ModelSelect'
import Composer from '../components/Composer'
import Markdown from '../components/Markdown'
import { Emblem } from '../components/InkArt'
import { useJobPoll } from '../lib/useJobPoll'
import { MODEL_UPDATED_EVENT } from '../lib/thinking'
import type { GenJob, KbHit, KbMeta, KbQaEntry, ModelConfig } from '../types'
import './resources.css'
import './resources-ink.css'
// 问答区复用「与 AI 讨论」的对话排版（消息流、思考折叠、输入框与模型胶囊）
import './collab-ink.css'
import './butler-agent.css'
import './kb-qa.css'

/** 资料库问答的起手问题：点一下直接发问 */
const KB_SUGGESTIONS = ['梳理这些资料里的人物关系', '总结每篇文档的要点', '找出资料之间互相矛盾的地方']

const fmtClock = (ts: number) =>
  ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
const fmtElapsed = (sec: number) =>
  sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`

const ACCEPT_EXT = ['.txt', '.md', '.text', '.markdown']
const isAccept = (name: string) => ACCEPT_EXT.includes(name.slice(name.lastIndexOf('.')).toLowerCase())
const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result || '')
      resolve(value.slice(value.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error(`读取 ${f.name} 失败`))
    reader.readAsDataURL(f)
  })
const fmtDate = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''

function Icon({ name, size = 16 }: { name: 'book' | 'file' | 'search' | 'upload'; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'book' ? (
        <>
          <path d="M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1z" />
          <path d="M12 6v14" />
        </>
      ) : name === 'file' ? (
        <>
          <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" />
        </>
      ) : name === 'search' ? (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </>
      ) : (
        <>
          <path d="M12 16V4M8 8l4-4 4 4M5 15v5h14v-5" />
        </>
      )}
    </svg>
  )
}

export default function Knowledge() {
  const [kbs, setKbs] = useState<KbMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selId, setSelId] = useState('')
  const sel = useMemo(() => kbs.find(k => k.id === selId) || null, [kbs, selId])
  const [pane, setPane] = useState<'libraries' | 'documents' | 'qa'>('libraries')
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [docName, setDocName] = useState('')
  const [docText, setDocText] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyText, setBusyText] = useState('')
  const [deleting, setDeleting] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KbHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState('')
  const [modelId, setModelId] = useState('')
  const [qa, setQa] = useState<KbQaEntry[]>([])
  const [qaLoading, setQaLoading] = useState(false)
  const [qaLoadError, setQaLoadError] = useState('')
  const [question, setQuestion] = useState('')
  const [qaJob, setQaJob] = useState<GenJob | null>(null)
  const [asking, setAsking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [qaError, setQaError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const qaScrollRef = useRef<HTMLDivElement>(null)
  const live = useRef(true)
  const loadGen = useRef(0)
  const modelGen = useRef(0)
  const qaLoadGen = useRef(0)
  const searchSeq = useRef(0)
  const askScope = useRef('')
  const askLock = useRef(false)
  const mutationLock = useRef(false)
  const clearLock = useRef(false)
  const selRef = useRef(selId)
  selRef.current = selId

  const loadModels = async () => {
    const gen = ++modelGen.current
    setModelsLoading(true)
    setModelsError('')
    try {
      const list = await api.getModels()
      if (live.current && gen === modelGen.current) {
        setModels(list)
        setModelId(prev =>
          list.some(m => m.id === prev) ? prev : list.find(m => m.isDefault)?.id || list[0]?.id || ''
        )
      }
    } catch (e) {
      if (live.current && gen === modelGen.current) setModelsError((e as Error).message)
    } finally {
      if (live.current && gen === modelGen.current) setModelsLoading(false)
    }
  }
  const loadQa = async (id: string) => {
    if (!live.current || id !== selRef.current) return
    const gen = ++qaLoadGen.current
    setQaLoading(true)
    setQaLoadError('')
    try {
      const list = await api.getKbQa(id)
      if (live.current && gen === qaLoadGen.current && id === selRef.current) setQa(list)
    } catch (e) {
      if (live.current && gen === qaLoadGen.current && id === selRef.current) setQaLoadError((e as Error).message)
    } finally {
      if (live.current && gen === qaLoadGen.current && id === selRef.current) setQaLoading(false)
    }
  }
  const load = async () => {
    if (!live.current) return
    const gen = ++loadGen.current
    setLoading(true)
    setError('')
    try {
      const list = await api.listKb()
      if (live.current && gen === loadGen.current) {
        setKbs(list)
        setSelId(prev => (list.some(k => k.id === prev) ? prev : list[0]?.id || ''))
      }
    } catch (e) {
      if (live.current && gen === loadGen.current) setError((e as Error).message || '本地服务暂时不可用')
    } finally {
      if (live.current && gen === loadGen.current) setLoading(false)
    }
  }
  useEffect(() => {
    live.current = true
    const generations = [loadGen, modelGen, qaLoadGen, searchSeq]
    void load()
    void loadModels()
    return () => {
      live.current = false
      generations.forEach(generation => {
        generation.current++
      })
    }
  }, [])
  useEffect(() => {
    const generations = [qaLoadGen, searchSeq]
    setQa([])
    setQaError('')
    setQaLoadError('')
    setQaLoading(false)
    setHits(null)
    setQuery('')
    setQuestion('')
    setSearchError('')
    setSearching(false)
    if (selId) void loadQa(selId)
    return () => {
      generations.forEach(generation => {
        generation.current++
      })
    }
  }, [selId])
  useEffect(() => {
    const node = qaScrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [qa, qaJob?.stream, qaJob?.reasoning, asking])
  // 选择器里调了思考强度会广播最新配置，这里就地合并（本页自己拉模型列表，不走 useModels）
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const next = (e as CustomEvent<ModelConfig>).detail
      if (next?.id) setModels(list => list.map(m => (m.id === next.id ? { ...m, ...next } : m)))
    }
    window.addEventListener(MODEL_UPDATED_EVENT, onUpdated)
    return () => window.removeEventListener(MODEL_UPDATED_EVENT, onUpdated)
  }, [])
  // 回答计时：只在任务进行中每秒走一次
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (!qaJob) return
    const t = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [qaJob])
  const [showThinking, setShowThinking] = useState(false)
  // 刚发出的问题：任务结束、记录刷新前就先显示在对话里（否则提问后要等整轮结束才看得到）
  const [pendingQ, setPendingQ] = useState('')
  const pendingQRef = useRef('')
  const setPending = (q: string) => {
    pendingQRef.current = q
    setPendingQ(q)
  }

  const settleJob = (job: GenJob) => {
    setQaJob(null)
    setStopping(false)
    const q = pendingQRef.current
    if (askScope.current !== selRef.current) return setPending('')
    // 记录重新拉回来之后再撤掉「刚问的那条」，中间不闪。
    // 带代际守卫：重载期间作者又问了新问题时，不能把新问题的 pending 气泡误清掉
    if (job.status === 'done') {
      void loadQa(selRef.current).finally(() => {
        if (live.current && pendingQRef.current === q) setPending('')
      })
    } else {
      setPending('')
      setQuestion(prev => prev || q)
      setQaError(job.status === 'stopped' ? '已停止，本次回答未保存。' : job.error || '回答失败，请重试。')
    }
  }
  useJobPoll(
    qaJob?.id,
    qaJob?.status,
    job => {
      if (!live.current) return
      if (!job && askScope.current === selRef.current) {
        setQaError('回答任务已不可用，请重新提问。')
        // 任务 404 不会走 settle：pending 气泡也要在这里撤掉，否则「正在检索资料」永久卡死
        setPending('')
      }
      setQaJob(job)
    },
    settleJob
  )

  const selectLibrary = (id: string) => {
    selRef.current = id
    setSelId(id)
    setPane('documents')
  }
  const openCreate = () => {
    setCreateError('')
    setCreateOpen(true)
  }
  const invalidateSearch = () => {
    searchSeq.current++
    setHits(null)
    setSearching(false)
    setSearchError('')
  }
  const create = async () => {
    if (mutationLock.current) return
    if (!name.trim()) return setCreateError('请先为资料库填写名称。')
    mutationLock.current = true
    setCreating(true)
    setCreateError('')
    try {
      const result = await api.createKb(name.trim(), desc.trim() || undefined)
      if (!live.current) return
      setName('')
      setDesc('')
      setCreateOpen(false)
      await load()
      if (live.current) {
        selectLibrary(result.kb.id)
        toast('资料库已创建，可以添加文档了。')
      }
    } catch (e) {
      if (live.current) setCreateError((e as Error).message)
    } finally {
      mutationLock.current = false
      if (live.current) setCreating(false)
    }
  }
  // 文件选择和拖入共用入口；没有选中的资料库时按首个文件名自动建库。
  const addFiles = async (files: FileList | File[]) => {
    if (mutationLock.current) return
    const allFiles = Array.from(files)
    const list = allFiles.filter(f => isAccept(f.name))
    if (!list.length)
      return void alertDialog({
        title: '没有可导入的文件',
        body: `目前支持 ${ACCEPT_EXT.join(' / ')} 文本文件。`,
        tone: 'warning'
      })
    mutationLock.current = true
    setBusy(true)
    setBusyText('正在准备导入…')
    let kbId = selRef.current
    const skipped = allFiles.length - list.length
    try {
      if (!kbId) {
        const result = await api.createKb(list[0].name.replace(/\.[^.]+$/, '') || '未命名资料库')
        kbId = result.kb.id
      }
      let done = 0
      const fails: string[] = []
      for (const file of list) {
        if (!live.current) break
        setBusyText(`正在导入 ${done + fails.length + 1} / ${list.length}：${file.name}`)
        try {
          const base64 = await fileToBase64(file)
          if (!live.current) break
          await api.addKbDoc(kbId, { name: file.name, base64 })
          done++
        } catch (e) {
          fails.push(`${file.name}：${(e as Error).message}`)
        }
      }
      if (!live.current) return
      await load()
      if (!live.current) return
      if (!selRef.current) selectLibrary(kbId)
      if (selRef.current === kbId) invalidateSearch()
      if (fails.length)
        void alertDialog({
          title: '部分文档导入失败',
          body: `已导入 ${done} 个文件。\n${fails.join('\n')}`,
          tone: 'error'
        })
      else toast(`已导入 ${done} 个文件${skipped ? `，跳过 ${skipped} 个不支持的类型` : ''}。`)
    } catch (e) {
      if (live.current) void alertDialog({ title: '导入失败', body: (e as Error).message, tone: 'error' })
    } finally {
      mutationLock.current = false
      if (live.current) {
        setBusy(false)
        setBusyText('')
      }
    }
  }
  const addPaste = async () => {
    if (!sel || mutationLock.current) return
    if (docText.trim().length < 50) return setPasteError('请至少填写 50 字，以便建立文档索引。')
    const id = sel.id
    mutationLock.current = true
    setBusy(true)
    setBusyText('正在导入文本并建立索引…')
    setPasteError('')
    try {
      const result = await api.addKbDoc(id, { name: docName.trim() || '未命名文档', content: docText })
      if (!live.current) return
      setDocName('')
      setDocText('')
      setPasteOpen(false)
      await load()
      if (live.current) {
        if (selRef.current === id) invalidateSearch()
        toast(`文本已导入，建立了 ${result.chunks} 个检索片段。`)
      }
    } catch (e) {
      if (live.current) setPasteError((e as Error).message)
    } finally {
      mutationLock.current = false
      if (live.current) {
        setBusy(false)
        setBusyText('')
      }
    }
  }
  const removeDoc = async (docId: string, docTitle: string) => {
    if (!sel || mutationLock.current) return
    const id = sel.id
    mutationLock.current = true
    try {
      const ok = await confirmDialog({
        title: `移除文档「${docTitle}」？`,
        body: '只从资料库中移除，不删除源文件。',
        confirmText: '移除',
        danger: true
      })
      if (!ok || !live.current) return
      setDeleting(docId)
      await api.deleteKbDoc(id, docId)
      if (!live.current) return
      if (id === selRef.current) invalidateSearch()
      await load()
    } catch (e) {
      if (live.current) void alertDialog({ title: '移除失败', body: (e as Error).message, tone: 'error' })
    } finally {
      mutationLock.current = false
      if (live.current) setDeleting('')
    }
  }
  const removeKb = async (kb: KbMeta) => {
    if (mutationLock.current) return
    mutationLock.current = true
    try {
      const ok = await confirmDialog({
        title: `删除资料库「${kb.name}」？`,
        body: `其中 ${kb.docs.length} 篇文档与问答记录会一并删除，且不可恢复。`,
        confirmText: '删除资料库',
        danger: true
      })
      if (!ok || !live.current) return
      setDeleting(kb.id)
      await api.deleteKb(kb.id)
      if (live.current) await load()
    } catch (e) {
      if (live.current) void alertDialog({ title: '删除失败', body: (e as Error).message, tone: 'error' })
    } finally {
      mutationLock.current = false
      if (live.current) setDeleting('')
    }
  }
  const search = async () => {
    if (!sel || !query.trim()) return
    const seq = ++searchSeq.current
    const id = sel.id
    setSearching(true)
    setSearchError('')
    try {
      const result = await api.searchKb(query.trim(), 8, id)
      if (live.current && seq === searchSeq.current && id === selRef.current) setHits(result.hits)
    } catch (e) {
      if (live.current && seq === searchSeq.current && id === selRef.current) setSearchError((e as Error).message)
    } finally {
      if (live.current && seq === searchSeq.current && id === selRef.current) setSearching(false)
    }
  }
  const selectedModel = models.some(m => m.id === modelId)
  /** raw：起手问题直接带文本发出，不动输入框里正在写的内容 */
  const ask = async (raw?: string) => {
    const q = (raw ?? question).trim()
    if (
      !sel ||
      !sel.docs.length ||
      !q ||
      qaJob ||
      askLock.current ||
      !selectedModel ||
      modelsLoading ||
      modelsError ||
      clearLock.current
    )
      return
    const id = sel.id
    askLock.current = true
    askScope.current = id
    setAsking(true)
    setPending(q)
    if (raw === undefined) setQuestion('')
    setQaError('')
    try {
      const result = await api.askKb({ kbId: id, question: q, modelId })
      const job = await api.getJob(result.jobId)
      if (!live.current) return
      if (job.status === 'running') setQaJob(job)
      else settleJob(job)
    } catch (e) {
      if (live.current) setPending('')
      if (live.current && id === selRef.current) {
        setQaError((e as Error).message)
        setQuestion(prev => prev || q)
      }
    } finally {
      askLock.current = false
      if (live.current) setAsking(false)
    }
  }
  const stopAsk = async () => {
    if (!qaJob || stopping) return
    setStopping(true)
    try {
      await api.stopJob(qaJob.id)
    } catch (e) {
      if (live.current) void alertDialog({ title: '停止失败', body: (e as Error).message, tone: 'error' })
    } finally {
      if (live.current) setStopping(false)
    }
  }
  const clearQa = async () => {
    if (!sel || clearLock.current || askLock.current || qaJob) return
    const id = sel.id
    clearLock.current = true
    try {
      const ok = await confirmDialog({
        title: '清空问答记录？',
        body: '只清空当前资料库的对话，不影响文档。',
        confirmText: '清空',
        danger: true
      })
      if (!ok || !live.current) return
      setClearing(true)
      await api.clearKbQa(id)
      if (live.current && id === selRef.current) {
        qaLoadGen.current++
        setQa([])
        setQaLoading(false)
        setQaLoadError('')
        setQaError('')
      }
    } catch (e) {
      if (live.current && id === selRef.current) setQaError((e as Error).message)
    } finally {
      clearLock.current = false
      if (live.current) setClearing(false)
    }
  }
  const copyAnswer = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制回答')
    } catch {
      toast.error('复制失败，请手动选择文本')
    }
  }
  const mutating = busy || creating || !!deleting
  const jobInCurrent = !!qaJob && askScope.current === selId
  const otherJob = (qaJob || asking) && askScope.current !== selId
  const qaBlocked = !sel
    ? '先选择或新建一个资料库。'
    : !sel.docs.length
      ? '先添加文档，回答才有可引用的资料。'
      : modelsLoading
        ? '正在读取 AI 模型…'
        : modelsError
          ? '模型读取失败，请重试后再提问。'
          : !selectedModel
            ? '问答需要 AI 模型，文档整理和检索不受影响。'
            : otherJob
              ? '另一个资料库正在回答，完成或停止后可继续提问。'
              : ''

  // 模型状态的提示放在输入框上方（读取中 / 读取失败 / 还没配置），不再占一整行表单
  const modelNotice = modelsLoading ? (
    <p className="kb-qa-notice" role="status">
      正在读取 AI 模型…
    </p>
  ) : modelsError ? (
    <div className="kb-qa-notice is-error" role="alert">
      <span>模型读取失败：{modelsError}</span>
      <button className="resources-button resources-button--quiet" onClick={loadModels}>
        重试
      </button>
      <Link className="resources-text-link" to="/settings">
        检查设置
      </Link>
    </div>
  ) : !models.length ? (
    <div className="kb-qa-notice">
      <span>问答需要连接 AI 模型，整理文档与检索不受影响。</span>
      <Link className="resources-text-link" to="/settings">
        前往设置添加模型
      </Link>
    </div>
  ) : undefined

  return (
    <div className="resources-scope resources-knowledge-shell">
      <header className="resources-page-header resources-knowledge-header">
        <div>
          <h1>资料库</h1>
          <p>整理长篇文档，检索细节，让 AI 回答有据可查。</p>
        </div>
        <span className="resources-local-note">文档与问答记录保存在本机</span>
      </header>
      <div
        className={`resources-knowledge resources-knowledge--${pane}`}
        onDragOver={e => {
          if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
          e.preventDefault()
          if (!mutationLock.current) setDragOver(true)
        }}
        onDragLeave={e => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
          setDragOver(false)
        }}
        onDrop={e => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
        }}
      >
        {dragOver && (
          <div className="resources-drop-overlay">
            <Icon name="upload" size={30} />
            <strong>松开以导入文档</strong>
            <p>{sel ? `添加到「${sel.name}」` : '将按文件名自动创建资料库'}</p>
            <span>支持 TXT 与 Markdown 文本文件</span>
          </div>
        )}
        <div className="resources-knowledge-tabs" role="group" aria-label="切换资料栏目">
          <button aria-pressed={pane === 'libraries'} onClick={() => setPane('libraries')}>
            资料库{kbs.length ? ` (${kbs.length})` : ''}
          </button>
          <button aria-pressed={pane === 'documents'} onClick={() => setPane('documents')}>
            文档
          </button>
          <button aria-pressed={pane === 'qa'} onClick={() => setPane('qa')}>
            问答
          </button>
        </div>
        <aside className="resources-kb-rail" aria-label="资料库列表">
          <div className="resources-column-header">
            <h2>资料库</h2>
            <button
              className="resources-button resources-button--quiet resources-button--accent"
              onClick={openCreate}
              disabled={mutating}
            >
              新建
            </button>
          </div>
          <div className="resources-kb-list">
            {loading && (
              <p className="resources-status" role="status">
                正在读取资料库…
              </p>
            )}
            {error && (
              <div className="resources-notice resources-notice--error" role="alert">
                <span>读取失败：{error}</span>
                <button className="resources-button" onClick={load} disabled={loading}>
                  重新加载
                </button>
              </div>
            )}
            {!loading && !error && !kbs.length && (
              <div className="resources-empty resources-empty--compact">
                <Icon name="book" size={28} />
                <h3>把资料分类收好</h3>
                <p>为设定考据、写作笔记或拆书报告建立资料库。</p>
                <button className="resources-button resources-button--primary" onClick={openCreate} disabled={mutating}>
                  新建资料库
                </button>
              </div>
            )}
            {kbs.map(kb => (
              <button
                key={kb.id}
                className={`resources-kb-item ${kb.id === selId ? 'is-selected' : ''}`}
                aria-current={kb.id === selId ? 'true' : undefined}
                onClick={() => selectLibrary(kb.id)}
              >
                <Icon name="book" />
                <span>
                  <strong>{kb.name}</strong>
                  <span>{kb.docs.length} 篇文档</span>
                </span>
              </button>
            ))}
          </div>
          <p className="resources-rail-footer">可直接拖入 TXT / Markdown 文件</p>
        </aside>
        <section className="resources-kb-documents" aria-label="文档">
          <div className="resources-column-header">
            <h2>文档</h2>
            <span className="resources-hint">{sel ? `${sel.docs.length} 篇` : '按需检索 · 无需模型'}</span>
          </div>
          {!sel ? (
            <div className="resources-empty resources-docs-empty">
              {loading ? (
                <>
                  <h3>正在读取文档…</h3>
                  <p role="status">请稍候。</p>
                </>
              ) : error ? (
                <>
                  <h3>暂时无法读取资料</h3>
                  <p>{error}</p>
                  <button className="resources-button" onClick={load}>
                    重新加载
                  </button>
                </>
              ) : (
                <>
                  <Icon name="file" size={32} />
                  <h3>为写作建立参考资料</h3>
                  <p>选择左侧资料库，或新建一个。文件可直接拖入窗口，系统会自动建立检索索引。</p>
                  <div className="resources-actions">
                    <button
                      className="resources-button resources-button--primary"
                      onClick={openCreate}
                      disabled={mutating}
                    >
                      新建资料库
                    </button>
                    <button className="resources-button" onClick={() => fileRef.current?.click()} disabled={mutating}>
                      导入文件并建库
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="resources-docs-heading">
                <h3>{sel.name}</h3>
                <p>{sel.description || '添加设定、考据和写作笔记，随时检索和引用。'}</p>
                <span className="resources-hint">
                  {sel.docs.length} 篇文档 · {sel.chunkCount} 个检索片段
                </span>
              </div>
              <div className="resources-docs-toolbar">
                <button
                  className="resources-button resources-button--primary"
                  disabled={mutating}
                  onClick={() => fileRef.current?.click()}
                >
                  <Icon name="upload" />
                  {busy ? '导入中…' : '添加文件'}
                </button>
                <button
                  className="resources-button"
                  disabled={mutating}
                  onClick={() => {
                    setPasteError('')
                    setPasteOpen(true)
                  }}
                >
                  粘贴文本
                </button>
                <button
                  className="resources-button resources-button--quiet"
                  aria-expanded={searchOpen}
                  aria-controls="kb-search"
                  onClick={() => setSearchOpen(v => !v)}
                >
                  <Icon name="search" />
                  检索
                </button>
                <button
                  className="resources-button resources-button--quiet resources-button--danger"
                  disabled={mutating || !!qaJob || asking || clearing}
                  onClick={() => removeKb(sel)}
                >
                  {deleting === sel.id ? '删除中…' : '删除库'}
                </button>
              </div>
              {searchOpen && (
                <form
                  id="kb-search"
                  className="resources-kb-search"
                  onSubmit={e => {
                    e.preventDefault()
                    void search()
                  }}
                >
                  <label className="resources-visually-hidden" htmlFor="kb-query">
                    在当前资料库检索
                  </label>
                  <input
                    id="kb-query"
                    type="search"
                    value={query}
                    onChange={e => {
                      setQuery(e.target.value)
                      invalidateSearch()
                    }}
                    placeholder="检索人物、设定或关键词"
                  />
                  <button className="resources-button" disabled={searching || !query.trim()}>
                    {searching ? '检索中…' : '检索'}
                  </button>
                </form>
              )}
              {loading && (
                <p className="resources-status" role="status">
                  正在更新文档列表…
                </p>
              )}
              {error && (
                <div className="resources-notice resources-notice--error" role="alert">
                  <span>列表更新失败：{error}</span>
                  <button className="resources-button" onClick={load}>
                    重试
                  </button>
                </div>
              )}
              {searchError && (
                <p className="resources-notice resources-notice--error" role="alert">
                  检索失败：{searchError}。可重新检索。
                </p>
              )}
              <div className="resources-docs-scroll">
                {hits !== null && (
                  <section className="resources-search-results" aria-label="检索结果">
                    <div className="resources-results-header">
                      <h3>检索结果 · {hits.length}</h3>
                      <button className="resources-button resources-button--quiet" onClick={invalidateSearch}>
                        收起结果
                      </button>
                    </div>
                    {hits.length === 0 ? (
                      <p className="resources-description">没有找到相关片段。试试更具体的人物名或关键词。</p>
                    ) : (
                      hits.map((hit, index) => (
                        <article key={`${hit.docName}-${index}`} className="resources-search-hit">
                          <p className="resources-hint">
                            {hit.docName} · 相关度 {hit.score}
                          </p>
                          <p>{hit.text}</p>
                        </article>
                      ))
                    )}
                  </section>
                )}
                {!sel.docs.length ? (
                  <div className="resources-empty resources-empty--compact">
                    <Icon name="file" size={28} />
                    <h3>添加第一篇文档</h3>
                    <p>拖入文件，或从电脑中选择。支持 TXT / Markdown 与 GBK 编码，导入后自动按段落建立索引。</p>
                    <button className="resources-button" disabled={mutating} onClick={() => fileRef.current?.click()}>
                      选择文件
                    </button>
                  </div>
                ) : (
                  <div className="resources-document-list">
                    {sel.docs.map(doc => (
                      <article key={doc.id} className="resources-document-row">
                        <span className="resources-document-icon">
                          <Icon name="file" size={20} />
                        </span>
                        <div>
                          <h3>{doc.name}</h3>
                          <p>
                            {doc.chars.toLocaleString()} 字 · {doc.chunks} 个片段 · {fmtDate(doc.addedAt)} 添加
                          </p>
                        </div>
                        <button
                          className="resources-button resources-button--quiet resources-button--danger"
                          aria-label={`移除文档 ${doc.name}`}
                          onClick={() => removeDoc(doc.id, doc.name)}
                          disabled={mutating}
                        >
                          {deleting === doc.id ? '移除中…' : '移除'}
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
        <section className="resources-kb-qa kb-qa" aria-label="问答">
          <header className="kb-qa-head">
            <Emblem char="典" size={30} />
            <div className="kb-qa-title">
              <h2>资料问答</h2>
              <p>
                {sel ? `基于「${sel.name}」的 ${sel.docs.length} 篇文档作答，回答标注引用来源` : '选择资料库后开始问答'}
              </p>
            </div>
            {qa.length > 0 && (
              <button
                className="resources-button resources-button--quiet"
                disabled={!!qaJob || asking || clearing || qaLoading}
                onClick={clearQa}
              >
                {clearing ? '清空中…' : '清空记录'}
              </button>
            )}
          </header>
          <div className="resources-qa-scroll kb-qa-scroll" ref={qaScrollRef}>
            <div className="kb-qa-thread">
              {qaLoading && (
                <p className="resources-status" role="status">
                  正在读取问答记录…
                </p>
              )}
              {qaLoadError && (
                <div className="resources-notice resources-notice--error" role="alert">
                  <span>记录读取失败：{qaLoadError}</span>
                  <button className="resources-button" onClick={() => sel && loadQa(sel.id)}>
                    重试
                  </button>
                </div>
              )}
              {!qaLoading && !qaLoadError && qa.length === 0 && !jobInCurrent && !pendingQ && (
                <div className="collab-empty kb-qa-empty">
                  <span className="collab-empty-desk" aria-hidden="true" />
                  <h2>{!sel ? '从资料中寻找答案' : !sel.docs.length ? '先有资料，再有答案' : '向你的资料提问'}</h2>
                  <p>
                    {!sel
                      ? '先选择或新建资料库。文档会按需检索，回答将标注引用来源。'
                      : !sel.docs.length
                        ? '添加文档后，可以询问人物设定、比较观点或查找细节。'
                        : '回答依据检索到的片段生成，每处引用都标了序号，请结合原文核对。'}
                  </p>
                  {!sel ? (
                    <button className="btn btn--primary btn--md" onClick={openCreate} disabled={mutating}>
                      ＋ 新建资料库
                    </button>
                  ) : !sel.docs.length ? (
                    <div className="kb-qa-empty-actions">
                      <button
                        className="btn btn--primary btn--md"
                        disabled={mutating}
                        onClick={() => fileRef.current?.click()}
                      >
                        <Icon name="upload" /> 导入文档
                      </button>
                      <button
                        className="btn btn--ghost btn--md"
                        disabled={mutating}
                        onClick={() => {
                          setPasteError('')
                          setPasteOpen(true)
                        }}
                      >
                        粘贴文本
                      </button>
                    </div>
                  ) : (
                    <div className="kb-qa-suggest">
                      {KB_SUGGESTIONS.map(s => (
                        <button
                          key={s}
                          className="ink-chip"
                          disabled={!!qaBlocked || asking || !!qaJob}
                          onClick={() => void ask(s)}
                        >
                          <span aria-hidden="true">◇</span>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {qa.map(entry => (
                <article key={entry.id} className="kb-qa-turn">
                  <div className="msg-user flex justify-end">
                    <div className="kb-qa-bubble-wrap">
                      <span className="resources-visually-hidden">提问</span>
                      <div className="msg-bubble-user">{entry.q}</div>
                    </div>
                  </div>
                  <div className="msg-assistant">
                    <div className="msg-meta">
                      <Emblem char="典" size={26} />
                      <span className="msg-meta-name">资料助手</span>
                      <span className="msg-meta-time">{fmtClock(entry.at)}</span>
                    </div>
                    <Markdown text={entry.a} className="msg-body" />
                    {entry.hits.length > 0 && (
                      <details className="kb-qa-sources">
                        <summary>
                          引用来源 · {entry.hits.length}
                          <span>{[...new Set(entry.hits.map(hit => hit.docName))].join('、')}</span>
                        </summary>
                        <ol>
                          {entry.hits.map((hit, i) => (
                            <li key={`${hit.docName}-${i}`}>
                              <b>{hit.docName}</b>
                              <span>{hit.text}</span>
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                    <div className="msg-tools">
                      <button type="button" onClick={() => void copyAnswer(entry.a)} aria-label="复制这条回答">
                        复制
                      </button>
                    </div>
                  </div>
                </article>
              ))}
              {pendingQ && askScope.current === selId && (
                <article className="kb-qa-turn">
                  <div className="msg-user flex justify-end">
                    <div className="kb-qa-bubble-wrap">
                      <div className="msg-bubble-user">{pendingQ}</div>
                    </div>
                  </div>
                  <div className="msg-assistant msg-live" aria-live="polite" aria-busy="true">
                    <div className="msg-meta">
                      <Emblem char="典" size={26} />
                      <span className="msg-meta-name">资料助手</span>
                      <span className="msg-meta-status">
                        {qaJob?.stream ? '正在撰写' : qaJob?.reasoning ? '正在思考' : '正在检索资料'}
                        {qaJob?.startedAt
                          ? ` · ${fmtElapsed(Math.max(0, Math.round((clock - qaJob.startedAt) / 1000)))}`
                          : ''}
                      </span>
                    </div>
                    {qaJob?.reasoning && (
                      <div className={`msg-think${showThinking ? ' is-open' : ''}${qaJob.stream ? ' is-done' : ''}`}>
                        <button
                          type="button"
                          aria-expanded={showThinking}
                          onClick={() => setShowThinking(s => !s)}
                          className="msg-think-head"
                        >
                          <span className="msg-think-dot" aria-hidden="true" />
                          <span>{qaJob.stream ? '思考过程' : '思考中'}</span>
                          <small>{qaJob.reasoning.length.toLocaleString()} 字</small>
                          <span className="msg-think-toggle">{showThinking ? '收起' : '展开'}</span>
                        </button>
                        {showThinking && (
                          <div className="msg-think-body">
                            {qaJob.reasoning.length > 600 ? `……${qaJob.reasoning.slice(-600)}` : qaJob.reasoning}
                          </div>
                        )}
                      </div>
                    )}
                    {qaJob?.stream ? (
                      <Markdown text={qaJob.stream} className="msg-body is-streaming" />
                    ) : (
                      !qaJob?.reasoning && (
                        <div className="msg-working">
                          <span className="msg-working-bar" aria-hidden="true" />
                          正在从「{sel?.name}」里检索相关片段
                        </div>
                      )
                    )}
                  </div>
                </article>
              )}
              {otherJob && (
                <div className="resources-notice" role="status">
                  <span>另一个资料库正在回答，当前记录不会被覆盖。</span>
                  {kbs.some(kb => kb.id === askScope.current) && (
                    <button
                      className="resources-button"
                      onClick={() => {
                        selectLibrary(askScope.current)
                        setPane('qa')
                      }}
                    >
                      查看回答
                    </button>
                  )}
                </div>
              )}
              {qaError && (
                <p className="resources-notice resources-notice--error" role="alert">
                  {qaError}
                </p>
              )}
            </div>
          </div>
          <Composer
            value={question}
            onChange={setQuestion}
            onSend={() => void ask()}
            onStop={stopAsk}
            running={jobInCurrent}
            disabled={!sel || !sel.docs.length || clearing}
            sendDisabled={!!qaBlocked || asking}
            placeholder={!sel ? '先选择资料库' : !sel.docs.length ? '导入文档后开始提问' : '向这些资料提问…'}
            hint="Enter 发送 · Shift+Enter 换行"
            aboveSlot={modelNotice}
            toolbar={
              sel ? (
                <span className="kb-qa-scope" title={`只在「${sel.name}」里检索`}>
                  <Icon name="book" size={13} />
                  <span>{sel.name}</span>
                  <small>{sel.docs.length} 篇</small>
                </span>
              ) : undefined
            }
            modelSlot={
              models.length > 0 ? (
                <ModelSelect
                  variant="pill"
                  hotkey
                  value={modelId}
                  onChange={setModelId}
                  models={models}
                  disabled={modelsLoading || asking || !!qaJob}
                />
              ) : undefined
            }
          />
          <p className="kb-qa-footnote">提问时，检索到的相关片段会随问题发送给所选 AI 服务</p>
        </section>
        {busy && (
          <div className="resources-import-status" role="status">
            {busyText}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT_EXT.join(',')}
          hidden
          onChange={e => {
            if (e.target.files?.length) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {createOpen && (
        <ModalShell
          title={<span className="resources-scope">新建资料库</span>}
          width={480}
          onClose={() => setCreateOpen(false)}
          busy={creating}
        >
          <form
            className="resources-scope resources-form"
            onSubmit={e => {
              e.preventDefault()
              void create()
            }}
          >
            <p className="resources-description">按主题组织文档，每个资料库保留独立的问答记录。</p>
            <fieldset className="resources-fields" disabled={creating}>
              <label className="resources-field">
                名称
                <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：修仙体系考据" />
              </label>
              <label className="resources-field">
                说明（可选）
                <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="这份资料库用来收集什么？" />
              </label>
            </fieldset>
            {createError && (
              <p className="resources-notice resources-notice--error" role="alert">
                {createError}
              </p>
            )}
            <div className="resources-modal-footer">
              <button
                type="button"
                className="resources-button resources-button--quiet"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                取消
              </button>
              <button className="resources-button resources-button--primary" disabled={creating}>
                {creating ? '创建中…' : '创建资料库'}
              </button>
            </div>
          </form>
        </ModalShell>
      )}
      {pasteOpen && sel && (
        <ModalShell
          title={<span className="resources-scope">添加文本 · {sel.name}</span>}
          width={620}
          onClose={() => setPasteOpen(false)}
          busy={busy}
        >
          <form
            className="resources-scope resources-form"
            onSubmit={e => {
              e.preventDefault()
              void addPaste()
            }}
          >
            <fieldset className="resources-fields" disabled={busy}>
              <label className="resources-field">
                文档名称
                <input
                  value={docName}
                  onChange={e => setDocName(e.target.value)}
                  placeholder="例如：人物动机分析（可选）"
                />
              </label>
              <label className="resources-field">
                文本内容
                <textarea
                  value={docText}
                  onChange={e => setDocText(e.target.value)}
                  rows={11}
                  placeholder="粘贴设定考据、写作笔记或拆书结论，至少 50 字。"
                />
              </label>
              <p className="resources-hint" role="status">
                {docText.trim().length < 50
                  ? `还需 ${50 - docText.trim().length} 字即可导入（至少 50 字）。`
                  : `${docText.trim().length.toLocaleString()} 字，导入后会自动建立检索索引。`}
              </p>
            </fieldset>
            {pasteError && (
              <p className="resources-notice resources-notice--error" role="alert">
                {pasteError}
              </p>
            )}
            <div className="resources-modal-footer">
              <button
                type="button"
                className="resources-button resources-button--quiet"
                disabled={busy}
                onClick={() => setPasteOpen(false)}
              >
                取消
              </button>
              <button
                className="resources-button resources-button--primary"
                disabled={busy || docText.trim().length < 50}
              >
                {busy ? '导入中…' : '导入文本'}
              </button>
            </div>
          </form>
        </ModalShell>
      )}
    </div>
  )
}

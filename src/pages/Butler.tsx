import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './collab.css'
import './collab-ink.css'
import './butler-agent.css'
import { useNavigate, useSearchParams, Navigate } from 'react-router-dom'
import { api, ApiError, NotFoundError } from '../lib/api'
import { useJobPoll } from '../lib/useJobPoll'
import { useNovel } from '../lib/hooks/useNovel'
import { useJob } from '../lib/hooks/useJob'
import { useModels } from '../lib/hooks/useModels'
import { useSmoothText } from '../lib/hooks/useSmoothText'
import { describeModelError } from '../lib/errors'
import {
  getChatDraft,
  setChatDraft,
  getChatScroll,
  setChatScroll,
  getAgentFlags,
  setAgentFlags,
  getLastSession,
  setLastSession
} from '../lib/chatDraft'
import ModelSelect from '../components/ModelSelect'
import MenuSelect from '../components/MenuSelect'
import Composer from '../components/Composer'
import Markdown from '../components/Markdown'
import { confirmDialog } from '../components/Dialog'
import { Emblem } from '../components/InkArt'
import { toast } from '../components/Toast'
import {
  QUICK_PROMPTS,
  BIcon,
  AGENT_MODES,
  modeToFlags,
  flagsToMode,
  ACTION_META,
  ACTION_META_FALLBACK,
  pagePath,
  jobPage,
  fmtTime,
  fmtRelative,
  chapterParas,
  selectedQuote
} from './butler/constants'
import type { AgentMode } from './butler/constants'
import type { GenJob, ChatMessage, ChatAction, ChatSessionMeta, ConsistencyIssue } from '../types'

/** 待发送的附件：图片已上传到服务端；文档在发送时才内联成引用块 */
type PendingAttachment =
  | { key: string; kind: 'image'; name: string; file: string; url: string }
  | { key: string; kind: 'text'; name: string; content: string }

/** 长会话尾部消息窗口：默认挂载最近 60 条，更早的按需展开 */
const BUTLER_MSG_WINDOW = 60

function fmtElapsed(sec: number) {
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

/**
 * 创作管家（独立模块）
 * - 独立入口与状态：不依赖「设定/生成」等页面，自带作品选择
 * - 支持修改已有书籍（书名/简介/章节等由管家动作完成）与新建书籍
 */
export default function Butler() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const novelId = params.get('id') || ''

  // 单一作品数据源：加载 / 重载统一收口到 useNovel（详见该 hook 注释）
  const modelSyncedFor = useRef('')
  const { novel, loadError, reload } = useNovel(novelId, n => {
    // 换书后首次成功拉取时，把本书默认模型同步到选择器（等价于原 main effect 的 setModelId）
    if (modelSyncedFor.current !== novelId) {
      modelSyncedFor.current = novelId
      setModelId(n.modelId || '')
    }
  })
  const models = useModels()
  // 管家对话流任务（chat）与后台轮询 / 收尾统一由 useJob 托管
  const { job, running, claimRunning, startJob, stop, setJob } = useJob({
    claim: j => j.type === 'chat',
    onSettled: async j => {
      await loadChat()
      const n = await reload()
      if (n && !modelId) setModelId(n.modelId || '')
      if (j.status === 'stopped') toast('已停止回复。')
      if (j.status === 'error') setError(describeModelError(j))
      lockSend(false)
      // 排队的消息：本轮正常结束才自动接着发；停止 / 出错时留在队列里，由作者决定
      if (j.status === 'done' && queuedRef.current.length) {
        const [next, ...rest] = queuedRef.current
        setQueued(rest)
        // 发送失败（断网 / 403）时消息还没进聊天记录，必须回队，否则凭空丢失
        void sendRef.current(next).then(ok => {
          if (!ok) setQueued([next, ...queuedRef.current])
        })
      }
    }
  })
  // 流式正文按字平滑展开：中转站常把几十上百字攒成一块发，直接渲染就是一蹦一大段
  const smoothStream = useSmoothText(running ? job?.stream || '' : '', running)
  // 回复进行中输入的消息先排队（像成熟的 agent 那样不用干等）
  const [queued, setQueuedState] = useState<string[]>([])
  const queuedRef = useRef<string[]>([])
  const setQueued = (next: string[]) => {
    queuedRef.current = next
    setQueuedState(next)
  }
  const sendRef = useRef<(raw?: string) => Promise<boolean>>(async () => false)
  // 运行计时：只在回复进行中每秒走一次
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [running])
  const [modelId, setModelId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInputState] = useState('')
  const [selOpen, setSelOpen] = useState(false)
  // 附件：图片上传后随消息发给多模态模型；文档在发送时才内联，不落盘
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const docInputRef = useRef<HTMLInputElement>(null)
  const [selChapter, setSelChapter] = useState(0)
  const [selParas, setSelParas] = useState<number[]>([])

  // 多会话（多线索）：列表元信息 + 当前活跃会话
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([])
  const [activeSid, setActiveSid] = useState('')
  // 请求回调读取最新作品 / 会话身份，避免慢响应跨书写入。
  const chatScopeRef = useRef({ novelId, activeSid })
  chatScopeRef.current = { novelId, activeSid }
  const loadChatGenRef = useRef(0)
  const [sessionsOpen, setSessionsOpen] = useState(() => window.matchMedia('(min-width: 761px)').matches)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [sessionLoadError, setSessionLoadError] = useState('')
  const [renamingId, setRenamingId] = useState('')
  const [renameText, setRenameText] = useState('')
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  // 长会话只挂载尾部消息，更早的靠「加载更早的消息」按需展开，避免几百条消息全部进 DOM
  const [msgWindow, setMsgWindow] = useState(BUTLER_MSG_WINDOW)

  const setInput = (v: string) => {
    setInputState(v)
    if (novelId) setChatDraft(novelId, { input: v }, activeSid)
  }
  const [error, setError] = useState('')
  const [showThinking, setShowThinking] = useState(true)
  // 授权档位：三档模式下拉，从 localStorage 恢复，切页/重开仍保留
  const [agentMode, setAgentModeState] = useState<AgentMode>(() => flagsToMode(getAgentFlags()))
  const setAgentMode = (m: AgentMode) => {
    setAgentModeState(m)
    setAgentFlags(modeToFlags(m))
  }
  const { butler, allowDangerous } = modeToFlags(agentMode)
  const curModeMeta = AGENT_MODES.find(m => m.id === agentMode) ?? AGENT_MODES[1]
  const [agentModeBusy, setAgentModeBusy] = useState(false)
  const chooseModel = async (v: string) => {
    setModelId(v)
    if (!novelId) return
    try {
      const saved = await api.setNovelPrefs(novelId, { modelId: v })
      if (saved.modelId !== v) setModelId(saved.modelId || '')
      toast.success('本书模型已保存。')
    } catch (e) {
      setError(`模型保存失败：${(e as Error).message}`)
    }
  }
  // 能否连发由 ref 决定：同一拍里双击 Enter 时 state 还没 flush，两次都进得来
  const sendLockRef = useRef(false)
  // 新建会话/启动 AI 同理用 ref 互斥（声明在早退之前，遵守 Hook 调用顺序不变量）
  const newSessionBusyRef = useRef(false)
  const lockSend = (v: boolean) => {
    sendLockRef.current = v
  }
  const [consJob, setConsJob] = useState<GenJob | null>(null)
  const [consOpen, setConsOpen] = useState(true)
  const consBusyRef = useRef(false)

  // 一键落库兜底：模型偶尔写完正文却忘了输出落库动作块。
  // 这里记录「正在挑章号的那条消息」，选中章号后一键写进成书，省得作者打字催。
  const [persistTarget, setPersistTarget] = useState<{ at: number; text: string } | null>(null)
  const [persistChapter, setPersistChapter] = useState(0)
  const [persistBusy, setPersistBusy] = useState(false)

  /** 下一待写章：大纲里第一个还没有成文正文的章号（一键落库的默认章号） */
  const nextUnwrittenChapter = useMemo(() => {
    const written = novel?.chapters || []
    const outline = novel?.outline || []
    const hit = outline.find(o => !written.some(c => c.index === o.index && String(c.content || '').trim()))
    if (hit) return hit.index
    if (written.length) return Math.max(...written.map(c => c.index)) + 1
    return outline[0]?.index || 1
  }, [novel])

  /** 一键落库的章号候选：大纲 ∪ 已有章节 ∪ 下一待写章，去重升序（大纲为空时也能选） */
  const persistOptions = useMemo(() => {
    const map = new Map<number, string>()
    for (const o of novel?.outline || []) if (o.index > 0) map.set(o.index, o.title || '')
    for (const c of novel?.chapters || []) if (!map.has(c.index)) map.set(c.index, c.title || '')
    if (!map.has(nextUnwrittenChapter)) map.set(nextUnwrittenChapter, '')
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [novel, nextUnwrittenChapter])

  const listRef = useRef<HTMLDivElement>(null)
  const undoDoneRef = useRef<Set<string>>(new Set())
  const navDoneRef = useRef<Set<string>>(new Set())
  // 本会话加载时已存在的最后一条消息时间：早于它的消息属于历史，动作不重放
  const sessionMsgFloorRef = useRef<number | null>(null)
  const initScrollRef = useRef(false)

  const setSel = (ch: number, paras: number[]) => {
    setSelChapter(ch)
    setSelParas(paras)
    if (novelId) setChatDraft(novelId, { selChapter: ch, selParas: paras }, activeSid)
  }
  const togglePara = (n: number) => {
    setSel(selChapter, selParas.includes(n) ? selParas.filter(x => x !== n) : [...selParas, n])
  }

  // 自动执行 navigate / deleteNovel。
  // 双重防重放：①只处理「本会话加载之后新增」的消息动作（历史消息永不触发跳转）；
  // ②navDoneRef 保证同一条消息在多次 effect 中只执行一次。
  // 这是「点开管家就被跳走」的根因修复。
  useEffect(() => {
    const floor = sessionMsgFloorRef.current
    for (const m of messages) {
      if (floor !== null && m.at <= floor) continue
      for (const a of m.actions || []) {
        if (a.type === 'navigate' || a.type === 'deleteNovel') {
          if ((a.status || 'applied') !== 'applied') continue
          const key = `${a.type}:${m.at}`
          if (navDoneRef.current.has(key)) continue
          navDoneRef.current.add(key)
          if (a.type === 'deleteNovel') {
            setParams({}, { replace: true })
            navigate('/')
          } else {
            const path = pagePath(a.text, novelId)
            if (path && path !== window.location.pathname) navigate(path)
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  // 一致性检查任务：增量轮询（结论文本可能很长，避免反复整包重传）
  useJobPoll(consJob?.id, consJob?.status, setConsJob)

  // 贴底跟随：「是否停在底部」由用户自己的滚动决定（见 onListScroll），而不是渲染后再量——
  // 思考块、动作卡一次就能长出 160px 以上，渲染后再量会误判成「已离开底部」而停止跟随
  const stickRef = useRef(true)
  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages.length, smoothStream, job?.reasoning, job?.actions?.length, running, queued.length])

  useEffect(() => {
    if (!novelId || !messages.length || initScrollRef.current) return
    initScrollRef.current = true
    const el = listRef.current
    if (!el) return
    const saved = getChatScroll(novelId, activeSid)
    el.scrollTop = saved > 0 ? saved : el.scrollHeight
  }, [novelId, activeSid, messages.length])

  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (novelId) setChatScroll(novelId, el.scrollTop, activeSid)
  }

  const msgStart = Math.max(0, messages.length - msgWindow)
  const shownMsgs = messages.slice(msgStart)

  // 展开更早的消息时补上高度差，视口内容不跳动。
  // 用 layout effect 而非 rAF：rAF 在隐藏窗口里不派发，补偿会静默丢失。
  const expandAnchorRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const before = expandAnchorRef.current
    if (before == null) return
    expandAnchorRef.current = null
    const el = listRef.current
    if (el) el.scrollTop += el.scrollHeight - before
  })

  /** 展开更早的消息：先记下容器高度，展开后补上高度差，视口内容不跳动 */
  const loadEarlier = () => {
    const el = listRef.current
    if (el) expandAnchorRef.current = el.scrollHeight
    setMsgWindow(w => w + 200)
  }

  /** 拉取会话列表（元信息）；返回列表以便调用方挑选活跃会话 */
  const bootGenRef = useRef(0)
  const loadSessions = async (): Promise<ChatSessionMeta[]> => {
    const gen = bootGenRef.current
    if (!novelId) return []
    setLoadingSessions(true)
    setSessionLoadError('')
    try {
      const r = await api.listChatSessions(novelId)
      const next = r.sessions || []
      // 慢响应不得盖新状态：切书后 bootGen 已自增，旧的会话列表直接丢弃
      if (gen !== bootGenRef.current) return next
      setSessions(next)
      return next
    } catch (e) {
      if (gen === bootGenRef.current) {
        const message = (e as Error).message || '对话历史读取失败'
        setSessionLoadError(message)
        setError(message)
      }
      return []
    } finally {
      if (gen === bootGenRef.current) setLoadingSessions(false)
    }
  }

  /** 打开某个会话：拉取完整消息，恢复该会话的草稿与滚动位置 */
  const openGenRef = useRef(0)
  const openSession = async (sid: string, opts: { silent?: boolean } = {}) => {
    if (!novelId || !sid) return
    // 排队消息属于当前会话的上下文：切走即清空，避免在途任务结束后串发进新会话
    if (sid !== activeSid) setQueued([])
    const book = novelId
    const boot = bootGenRef.current
    const gen = ++openGenRef.current
    if (!opts.silent) setLoadingMsgs(true)
    setError('')
    try {
      const r = await api.getChatSession(book, sid)
      // 连点会话或换书：先发的慢响应不得覆盖后点的状态。
      if (gen !== openGenRef.current || boot !== bootGenRef.current || chatScopeRef.current.novelId !== book) return
      const msgs = r.session?.messages || []
      setActiveSid(sid)
      setMessages(msgs)
      setMsgWindow(BUTLER_MSG_WINDOW)
      sessionMsgFloorRef.current = msgs.length ? Math.max(...msgs.map(m => m.at)) : 0
      navDoneRef.current = new Set()
      const d = getChatDraft(book, sid)
      setInputState(d.input)
      setSelChapter(d.selChapter)
      setSelParas(d.selParas)
      initScrollRef.current = false
      setLastSession(book, sid)
      setRenamingId('')
    } catch (e) {
      if (gen !== openGenRef.current || boot !== bootGenRef.current || chatScopeRef.current.novelId !== book) return
      if (e instanceof NotFoundError) setError('该会话已不存在，请从左侧另选一个。')
      else setError((e as Error).message)
    } finally {
      if (gen === openGenRef.current && boot === bootGenRef.current && chatScopeRef.current.novelId === book) {
        setLoadingMsgs(false)
      }
    }
  }

  // 重新载入当前会话的消息（回复结束 / 撤销动作后）
  const loadChat = async () => {
    if (!novelId || !activeSid) return
    const book = novelId
    const sid = activeSid
    const boot = bootGenRef.current
    const gen = ++loadChatGenRef.current
    try {
      const r = await api.getChatSession(book, sid)
      if (
        gen !== loadChatGenRef.current ||
        boot !== bootGenRef.current ||
        chatScopeRef.current.novelId !== book ||
        chatScopeRef.current.activeSid !== sid
      )
        return
      setMessages(r.session?.messages || [])
      // 刻意不更新 sessionMsgFloorRef：水位语义是「会话装载时的历史水位」（openSession 负责）。
      // 这里若抬到最新一条，下方自动执行 navigate/deleteNovel 的 effect 会把新回复也当历史跳过，
      // 「自动跳转」类动作因此从未生效。新消息的防重放由 navDoneRef 兜底，effect 重复运行不会重复执行。
    } catch (e) {
      if (gen === loadChatGenRef.current && boot === bootGenRef.current && chatScopeRef.current.novelId === book) {
        setError((e as Error).message)
      }
    }
  }

  /** 进入某本书：载入会话列表，并续上上次停留的会话（没有则用最新一个，仍没有就保持空白待新建） */
  const bootSessions = async () => {
    if (!novelId) return
    // 换书即自增代号：旧书的 loadSessions/openSession 响应回来后一律作废
    const gen = ++bootGenRef.current
    const myNovel = novelId
    setActiveSid('')
    setMessages([])
    setRenamingId('')
    const list = await loadSessions()
    if (gen !== bootGenRef.current) return
    if (!list.length) return
    const remembered = getLastSession(myNovel)
    const target = list.find(s => s.id === remembered) || list[0]
    if (target) await openSession(target.id, { silent: true })
  }

  useEffect(() => {
    if (!novelId) return
    // 切换书籍：先使旧请求失效，再清空上一本的消息、草稿与导航状态。
    // 否则旧会话的慢响应可能在新书页面上重新写回消息。
    openGenRef.current++
    loadChatGenRef.current++
    setMessages([])
    setSessions([])
    setActiveSid('')
    setInputState('')
    setSelChapter(0)
    setSelParas([])
    setQueued([])
    setPending([])
    setError('')
    setSessionLoadError('')
    navDoneRef.current = new Set()
    sessionMsgFloorRef.current = null
    initScrollRef.current = false
    // job 必须一并清掉：上一本书的在途 chat 任务若留着，会禁住新书的输入框、
    // 流式区继续串显上一本书的正文；claimRunning 只负责认领、从不清空。
    // 清掉后轮询随之停止，回到旧书时 claimRunning 会重新接上。
    setJob(null)
    // 一致性检查任务同理：不清会把上一本书的检查结果/进度串到新书
    setConsJob(null)
    bootSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId])

  // 刷新 / 重进页面时接回正在跑的管家对话任务
  useEffect(() => {
    if (novelId) void claimRunning(novelId)
  }, [novelId, claimRunning])

  // 认领到的 chat 任务可能属于另一个会话（上次停留的会话 ≠ 在途任务的会话）。
  // 直接认领会把别的会话的正文串显进当前会话、还锁住输入框——跟着任务切到它所属的会话。
  // 只在 sessionId 变化时触发一次；在本会话内发起的任务 sessionId 相同，不会多余重载。
  useEffect(() => {
    const sid = job?.sessionId
    if (!sid || job?.type !== 'chat') return
    if (chatScopeRef.current.activeSid === sid) return
    void openSession(sid, { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.sessionId])

  useEffect(() => {
    // 只在「任务身份或状态」变化时解锁发送，不跟随 job 对象本身（流式期间每 tick 都会换新对象）
    if (!job || job.status !== 'running') lockSend(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖语义等价于 [job?.id, job?.status]
  }, [job?.id, job?.status])

  // 管家只有一个：本书管家。不带作品 id 直接回首页选书（独立闲聊入口已删除）。
  if (!novelId) return <Navigate to="/" replace />

  const reasoningText = job?.reasoning || ''
  const streamText = running ? job?.stream || '' : ''
  const liveActions = job?.actions || []
  const chapters = novel?.chapters || []
  const selChapterObj = selChapter > 0 ? chapters.find(c => c.index === selChapter) : null
  const selChapterParas = selChapterObj ? chapterParas(selChapterObj.content || '') : []
  const selQuote = novel ? selectedQuote(novel, selChapter, selParas) : ''

  const send = async (raw?: string) => {
    // 快捷指令 / 排队消息自带文本：不读取也不消耗当前输入框的选段与附件，
    // 否则一条无关的快捷指令会把作者刚附上的图片 / 文档悄悄带走
    const isRaw = raw !== undefined
    // 文档类附件在发送时内联成引用块（与「附选段」同一口径），不落盘
    const docs = isRaw
      ? []
      : pending.filter((p): p is Extract<PendingAttachment, { kind: 'text' }> => p.kind === 'text')
    const docBlock = docs.map(d => `\n\n————————————————\n【附加文档 · ${d.name}】\n${d.content}`).join('')
    const text = ((raw ?? input).trim() + (!isRaw && selQuote ? `\n\n${selQuote}` : '') + docBlock).trim()
    const images = isRaw
      ? []
      : pending.filter((p): p is Extract<PendingAttachment, { kind: 'image' }> => p.kind === 'image')
    const finalText = text || (images.length ? '请结合我发的图片继续。' : '')
    if (!novelId || !finalText || !models.length || uploading || loadingMsgs || agentModeBusy) return false
    if (sendLockRef.current || (job && job.status === 'running')) return false
    lockSend(true)
    setError('')
    try {
      // 没有活跃会话时，服务端会自动新建一个并回传 id
      const res = await api.sendChat(
        novelId,
        finalText,
        modelId || undefined,
        butler,
        butler && allowDangerous,
        activeSid || undefined,
        images.map(p => ({ kind: 'image' as const, name: p.name, file: p.file }))
      )
      const sid = res.sessionId || activeSid
      if (sid && sid !== activeSid) {
        setActiveSid(sid)
        setLastSession(novelId, sid)
      }
      // 快捷指令 / 排队消息自带文本：输入框里正在写的草稿与待发送附件都不能被一并清掉
      if (!isRaw) {
        setInput('')
        setPending([])
      }
      // 发出新消息后总是回到底部跟随回复
      stickRef.current = true
      setMessages(prev => [
        ...prev,
        {
          role: 'user',
          content: finalText,
          at: Date.now(),
          ...(images.length
            ? { attachments: images.map(p => ({ kind: 'image' as const, name: p.name, file: p.file })) }
            : {})
        }
      ])
      const r = await startJob(() => Promise.resolve({ jobId: res.jobId }))
      if (!r.ok) {
        setError(r.error)
        lockSend(false)
        return false
      }
      setShowThinking(true)
      // 标题可能刚从首条消息推导出来，刷新列表
      loadSessions()
      return true
    } catch (e) {
      const err = e as Error
      setError(
        err instanceof ApiError && err.status === 403
          ? '本地服务拒绝了请求。请确认当前打开的是最新版本，不要混用旧版窗口或旧后端。'
          : err.message
      )
      lockSend(false)
      return false
    }
  }
  sendRef.current = send

  const runConsistency = async () => {
    if (!novelId || consBusyRef.current) return
    consBusyRef.current = true
    setError('')
    try {
      setConsOpen(true)
      setConsJob(await api.getJob((await api.startConsistency(novelId, modelId || undefined)).jobId))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      consBusyRef.current = false
    }
  }

  /** 新建会话并切换过去 */
  const newSession = async () => {
    if (!novelId || running || newSessionBusyRef.current) return
    newSessionBusyRef.current = true
    try {
      await newSessionInner()
    } finally {
      newSessionBusyRef.current = false
    }
  }
  const newSessionInner = async () => {
    setError('')
    setSessionLoadError('')
    try {
      const r = await api.createChatSession(novelId)
      const created = r.session
      const sid = created?.id
      if (created) {
        const meta: ChatSessionMeta = {
          id: created.id,
          title: created.title || '新对话',
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          count: created.messages?.length || 0,
          preview: created.messages?.[created.messages.length - 1]?.content?.slice(0, 80) || ''
        }
        setSessions(prev => [meta, ...prev.filter(s => s.id !== meta.id)])
      } else {
        await loadSessions()
      }
      if (sid) await openSession(sid)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** 切换会话（正在回复时先拦一下，避免消息写错会话） */
  const switchSession = async (sid: string) => {
    if (sid === activeSid) return
    if (running) {
      setError('回复生成中，暂不能切换会话；可先「停止」再切换。')
      return
    }
    await openSession(sid)
  }

  const submitRename = async (sid: string) => {
    const title = renameText.trim()
    setRenamingId('')
    if (!novelId || !title) return
    // 乐观更新，失败再回滚
    setSessions(prev => prev.map(s => (s.id === sid ? { ...s, title } : s)))
    try {
      await api.renameChatSession(novelId, sid, title)
      loadSessions()
    } catch (e) {
      setError((e as Error).message)
      loadSessions()
    }
  }

  const removeSession = async (sid: string, title: string) => {
    if (!novelId || running) return
    const ok = await confirmDialog({
      title: `删除会话「${title}」？`,
      body: '该会话的全部消息记录会被移除，此操作不可恢复。',
      confirmText: '删除会话',
      danger: true
    })
    if (!ok) return
    try {
      const r = await api.deleteChatSession(novelId, sid)
      setSessions(r.sessions || [])
      if (sid === activeSid) {
        const next = (r.sessions || [])[0]
        if (next) await openSession(next.id)
        else {
          setActiveSid('')
          setMessages([])
        }
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const clear = async () => {
    if (!novelId || running) return
    const ok = await confirmDialog({
      title: '清空全部会话？',
      body: '本书所有研讨会话与消息都会被移除，此操作不可恢复。',
      confirmText: '清空',
      danger: true
    })
    if (!ok) return
    try {
      await api.clearChat(novelId)
      setMessages([])
      setSessions([])
      setActiveSid('')
      undoDoneRef.current = new Set()
      toast.success('全部会话已清空。')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** 一键把某条回复的正文写进成书（兜底：模型偶尔忘记输出落库动作块） */
  const doPersist = async () => {
    if (!novelId || !persistTarget || !persistChapter) return
    setPersistBusy(true)
    setError('')
    try {
      await api.persistChatToChapter(novelId, persistChapter, persistTarget.text, 'replace')
      setPersistTarget(null)
      toast.success(`已写入第 ${persistChapter} 章，到「成书」即可查看。`)
      // 走 useNovel 的 reload（带代际校验）：直接 getNovel().then(setNovel) 绕过防竞态，
      // 写入落库后 ~100ms 内切书的话，旧书整包数据会晚于新书落地覆盖 novel
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPersistBusy(false)
    }
  }

  const addImages = async (files: FileList | null) => {
    if (!files?.length) return
    const room = 4 - pending.filter(p => p.kind === 'image').length
    if (room <= 0) {
      toast('一条消息最多带 4 张图片，先移掉几张再选。')
      return
    }
    setUploading(true)
    try {
      const added: PendingAttachment[] = []
      for (const f of [...files].slice(0, room)) {
        if (!f.type.startsWith('image/')) continue
        if (f.size > 8 * 1024 * 1024) {
          toast(`「${f.name}」超过 8MB，已跳过。`)
          continue
        }
        const r = await api.uploadAttachment(f)
        added.push({ key: r.file, kind: 'image', name: f.name, file: r.file, url: r.url })
      }
      if (added.length) setPending(prev => [...prev, ...added])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const addDoc = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    if (!/\.(txt|md|markdown)$/i.test(f.name)) {
      toast('文档仅支持 .txt / .md，图片请选「插入图片」。')
      return
    }
    const raw = await f.text().catch(() => '')
    if (!raw.trim()) {
      toast('这个文档是空的。')
      return
    }
    const content =
      raw.length > 8000
        ? `${raw.slice(0, 8000)}

（文档过长已截断；原文件 ${f.name} 共 ${raw.length} 字）`
        : raw
    setPending(prev => [...prev, { key: `${f.name}-${Date.now()}`, kind: 'text', name: f.name, content }])
  }

  const removePending = (key: string) => setPending(prev => prev.filter(p => p.key !== key))

  const copyMsg = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制，可粘贴到本章指令、大纲摘要或设定中。')
    } catch {
      setError('复制失败：请手动选择文本复制。')
    }
  }

  const undoAction = async (msgAt: number, a: ChatAction) => {
    if (!novelId) return
    const key = `${msgAt}:${a.type}:${a.chapter}:${a.label}`
    if (undoDoneRef.current.has(key)) return
    try {
      await api.undoChatAction(novelId, a)
      undoDoneRef.current.add(key)
      setMessages(prev =>
        prev.map(m =>
          m.at === msgAt && m.actions
            ? {
                ...m,
                actions: m.actions.map(x =>
                  x === a ? { ...x, text: '', before: x.text, label: `${x.label} · 已撤销` } : x
                )
              }
            : m
        )
      )
      toast.success(`已撤销：${a.label}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // payload 美化规则跟着动作定义走（见 butler/constants 的 ACTION_META.pretty），
  // 这里只查一次表，不再按 type 分支。
  const prettyActionText = (raw: string, type: ChatAction['type']): string => ACTION_META[type]?.pretty?.(raw) ?? raw

  const actionCard = (a: ChatAction, msgAt: number) => {
    const meta = ACTION_META[a.type] ?? ACTION_META_FALLBACK
    const tone = meta.tone
    const status = a.status || 'applied'
    const revoked = a.label.includes('已撤销')
    const rejected = status === 'rejected'
    const failed = status === 'failed'
    const started = status === 'started'
    const dim = revoked || rejected || failed
    // 「不可撤销」与「套用预置」由动作自身的元数据决定，不再在这里堆 type 判断
    const noUndo = !!meta.noUndo || started
    const isApply = !!meta.applyKind
    const showDiff = !dim && !isApply && !noUndo && !!a.before && a.before !== a.text
    const page = started ? jobPage(a) : null
    const pageHref = page ? pagePath(page, novelId) : null

    // 工具调用行：图标 · 动作 · 章号 · 状态，右侧撤销；改动内容以 diff 行列在下方
    return (
      <div
        key={`${msgAt}-${a.type}-${a.chapter}-${a.label}`}
        className={`tool-call tool-call--${dim ? 'dim' : tone}${rejected || failed ? ' is-failed' : ''}`}
      >
        <div className="tool-call-head">
          <span className="tool-call-icon">{meta.icon}</span>
          <span className="tool-call-label">{a.label}</span>
          {a.chapter > 0 && <span className="tool-call-tag">第 {a.chapter} 章</span>}
          {started && <span className="tool-call-status is-gold">已启动</span>}
          {rejected && <span className="tool-call-status is-seal">已拒绝</span>}
          {failed && <span className="tool-call-status is-seal">失败</span>}
          {revoked && <span className="tool-call-status">已撤销</span>}
          {!dim && !started && <span className="tool-call-status is-jade">已完成</span>}
          {!revoked && !rejected && !failed && !noUndo && (
            <button onClick={() => undoAction(msgAt, a)} className="tool-call-undo">
              撤销
            </button>
          )}
          {meta.note && !dim && <span className="tool-call-note">{meta.note}</span>}
        </div>
        {(rejected || failed) && <p className="tool-call-reason">{a.reason || '未执行'}</p>}
        {started && (
          <div className="tool-call-started">
            <p>已在后台开始执行，可离开本页。</p>
            {pageHref && (
              <button onClick={() => navigate(pageHref)} className="btn btn--outline btn--sm shrink-0">
                前往查看
              </button>
            )}
          </div>
        )}
        {!dim && showDiff && (
          <div className="tool-call-diff">
            <div className="tool-call-line is-del">
              <span>-</span>
              <p>{prettyActionText(a.before, a.type)}</p>
            </div>
            <div className="tool-call-line is-add">
              <span>+</span>
              <p>{prettyActionText(a.text, a.type)}</p>
            </div>
          </div>
        )}
        {!dim && isApply && <p className="tool-call-apply">{`已${meta.applyKind}：${a.text}`}</p>}
        {!dim && !isApply && !showDiff && !noUndo && a.text && (
          <div className="tool-call-diff">
            <div className="tool-call-line is-add">
              <span>+</span>
              <p>{prettyActionText(a.text, a.type)}</p>
            </div>
          </div>
        )}
      </div>
    )
  }

  const assistantMeta = (at?: number, status?: string) => (
    <div className="msg-meta">
      <Emblem char="管" size={26} />
      <span className="msg-meta-name">写作管家</span>
      {status ? (
        <span className="msg-meta-status">{status}</span>
      ) : (
        at !== undefined && <span className="msg-meta-time">{fmtTime(at)}</span>
      )}
    </div>
  )
  const liveSeconds = running && job?.startedAt ? Math.max(0, Math.round((clock - job.startedAt) / 1000)) : 0
  // 推理型模型可能先静默思考很久：首段正文未到时要明确「还在等」，而不是一直显示准备回复
  const waitingFirstToken = !streamText && !reasoningText && liveSeconds >= 12
  const livePhase = streamText
    ? '正在撰写'
    : reasoningText
      ? '正在思考'
      : liveActions.length
        ? '正在执行'
        : waitingFirstToken
          ? '等待模型输出'
          : '准备回复'

  if (!novel) return <div className="p-10 text-[var(--text-dim)]">{error || loadError || '加载中……'}</div>

  return (
    <div className="collab-page flex h-full flex-col">
      <div className="collab-header">
        <button
          onClick={() => setSessionsOpen(o => !o)}
          aria-expanded={sessionsOpen}
          aria-controls="collab-sessions"
          title={sessionsOpen ? '收起会话列表' : '展开会话列表'}
          aria-label={sessionsOpen ? '收起会话列表' : '展开会话列表'}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--text-dim)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] ${sessionsOpen ? '' : 'opacity-60'}`}
        >
          <BIcon name="panel" size={15} />
        </button>
        <div className="collab-heading">
          <span className="collab-heading-mark" aria-hidden="true">
            <BIcon name="pen-nib" size={14} />
          </span>
          <div className="min-w-0">
            <h1 className="collab-title">
              《{novel.title}》<span> · {sessions.find(s => s.id === activeSid)?.title || '新对话'}</span>
            </h1>
            <p className="collab-context" title={novel.genre}>
              {novel.genre || '未分类'} · 与 AI 讨论
            </p>
          </div>
          {running && (
            <span className="ink-status ink-status--gold collab-running">
              <span className="breathing">●</span>回复中
            </span>
          )}
        </div>

        <div className="collab-header-actions">
          <button
            onClick={runConsistency}
            disabled={!models.length || (!!consJob && consJob.status === 'running')}
            className="btn btn--ghost btn--sm"
          >
            <BIcon name="shield" size={13} />
            {consJob?.status === 'running' ? '检查中…' : '一致性检查'}
          </button>
          <button
            onClick={newSession}
            disabled={running}
            className="btn btn--primary btn--sm"
            title="开启一条新的研讨线索"
          >
            <BIcon name="plus" size={13} />
            新对话
          </button>
          <button onClick={() => navigate('/')} className="btn btn--ghost btn--sm" title="回首页换一部作品研讨">
            换作品
          </button>
          {sessions.length > 0 && (
            <button onClick={clear} disabled={running} className="btn btn--danger btn--sm">
              清空
            </button>
          )}
        </div>
      </div>

      <div className="collab-quick" role="group" aria-label="快捷指令">
        {QUICK_PROMPTS.map(q => (
          <button
            key={q.label}
            type="button"
            className="ink-chip collab-quick-chip"
            title={q.text}
            disabled={running}
            onClick={() => void send(q.text)}
          >
            <BIcon name="knot" size={13} />
            {q.label}
          </button>
        ))}
      </div>

      <div className="collab-body flex min-h-0 flex-1">
        {/* 会话侧栏：多条研讨线索并行，随时切换。折叠时整列宽度归零并淡出 */}
        <aside
          id="collab-sessions"
          aria-label="对话历史"
          aria-hidden={!sessionsOpen}
          className={`collab-sessions session-rail shrink-0 overflow-hidden bg-[var(--rail)] ${
            sessionsOpen ? 'is-open' : 'is-closed'
          }`}
        >
          <div className="flex h-full w-[260px] flex-col">
            <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-faint)]">
                  对话历史
                </div>
              </div>
              <span className="mono rounded-[5px] bg-[var(--panel2)] px-1.5 py-px text-[10px] text-[var(--text-faint)]">
                {sessions.length}
              </span>
              <button
                onClick={newSession}
                disabled={running}
                title="开启一条新的研讨线索"
                aria-label="新建研讨线索"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-40"
              >
                <BIcon name="plus" size={13} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {loadingSessions ? (
                <div className="px-2 py-8 text-center text-[11px] leading-[1.9] text-[var(--text-faint)]">
                  正在读取对话历史…
                </div>
              ) : sessionLoadError ? (
                <div className="px-2 py-6 text-center text-[11px] leading-[1.8] text-[var(--seal)]">
                  <div>对话历史读取失败</div>
                  <button
                    onClick={loadSessions}
                    className="mt-2 rounded-[7px] border border-[var(--seal)]/30 px-2 py-1 text-[10px] text-[var(--seal)] hover:bg-[var(--seal)]/[0.08]"
                  >
                    重新读取
                  </button>
                </div>
              ) : sessions.length === 0 ? (
                <div className="px-2 py-8 text-center text-[11px] leading-[1.9] text-[var(--text-faint)]">
                  <div className="mb-1 font-medium text-[var(--text-dim)]">还没有对话历史</div>
                  发第一条消息会自动建档，
                  <br />
                  也可以点击上方「新对话」开始。
                </div>
              ) : (
                <div className="space-y-0.5">
                  {sessions.map(s => {
                    const on = s.id === activeSid
                    const editing = renamingId === s.id
                    return (
                      <div
                        key={s.id}
                        className={`session-item group relative rounded-[9px] transition-colors duration-200 ${
                          on ? 'bg-[var(--panel2)]' : 'hover:bg-[var(--hover)]'
                        }`}
                      >
                        {editing ? (
                          <div className="px-1.5 py-1.5">
                            <input
                              aria-label="会话名称"
                              autoFocus
                              value={renameText}
                              onChange={e => setRenameText(e.target.value)}
                              onBlur={() => submitRename(s.id)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  submitRename(s.id)
                                }
                                if (e.key === 'Escape') {
                                  e.preventDefault()
                                  setRenamingId('')
                                }
                              }}
                              className="w-full rounded-[7px] border border-[color-mix(in_srgb,var(--gold)_55%,var(--line))] bg-[var(--panel)] px-2 py-1 text-[12px] text-[var(--text)] outline-none"
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => switchSession(s.id)}
                            aria-current={on ? 'true' : undefined}
                            disabled={running || loadingMsgs}
                            className="block w-full px-2.5 py-2 pr-12 text-left"
                          >
                            <div
                              className={`truncate text-[12px] leading-[1.45] ${on ? 'font-medium text-[var(--text)]' : 'text-[var(--text-dim)] group-hover:text-[var(--text)]'}`}
                            >
                              {s.title || '新对话'}
                            </div>
                            <div className="mono mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                              <span>{fmtRelative(s.updatedAt)}</span>
                              {s.count > 0 && (
                                <>
                                  <span>·</span>
                                  <span>{s.count} 条</span>
                                </>
                              )}
                            </div>
                          </button>
                        )}
                        {!editing && (
                          <div className="collab-session-actions absolute right-1 top-1.5 flex items-center gap-0.5">
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                setRenameText(s.title || '')
                                setRenamingId(s.id)
                              }}
                              title="重命名"
                              aria-label={`重命名会话「${s.title || '新对话'}」`}
                              className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--text-faint)] transition-colors hover:bg-[var(--panel2)] hover:text-[var(--text)]"
                            >
                              <BIcon name="pencil" size={11} />
                            </button>
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                removeSession(s.id, s.title || '新对话')
                              }}
                              disabled={running}
                              title="删除会话"
                              aria-label={`删除会话「${s.title || '新对话'}」`}
                              className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--text-faint)] transition-colors hover:bg-[var(--panel2)] hover:text-[var(--seal)] disabled:opacity-40"
                            >
                              <BIcon name="trash" size={11} />
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="px-3.5 py-2 text-[10px] leading-[1.7] text-[var(--text-faint)]">会话分别保存讨论记录。</div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {!models.length && (
            <div className="collab-model-notice" role="status">
              <span>暂无可用模型。可先写下问题，配置模型后再发送。</span>
              <button className="btn btn--outline btn--sm" onClick={() => navigate('/settings')}>
                前往设置
              </button>
            </div>
          )}
          {error && (
            <div className="px-6 pt-3">
              <div className="rounded-[12px] border border-[var(--seal)]/30 bg-[var(--seal)]/[0.07] px-3.5 py-2 text-[12px] text-[var(--seal)]">
                <span role="alert">{error}</span>
              </div>
            </div>
          )}

          {consJob && (consJob.status !== 'running' || consJob.stream) && (
            <div className="mx-6 mt-3 shrink-0 overflow-hidden rounded-[12px] border border-[var(--line)]">
              <div className="flex items-center gap-2 bg-[var(--panel2)]/60 px-3.5 py-2">
                <span className="text-[12px] font-medium text-[var(--text)]">全书一致性检查</span>
                {consJob.status === 'running' ? (
                  <span className="text-[11px] text-[var(--jade)]">
                    通读全书检查中<span className="breathing ml-0.5">▍</span>
                  </span>
                ) : consJob.status === 'error' ? (
                  <span className="text-[11px] text-[var(--seal)]">{consJob.error || '检查失败'}</span>
                ) : consJob.status === 'stopped' ? (
                  <span className="text-[11px] text-[var(--text-faint)]">已停止，检查结果不完整</span>
                ) : (
                  <span className="mono text-[11px] text-[var(--text-dim)]">
                    {Array.isArray(consJob.result) && consJob.result.length > 0
                      ? `发现 ${consJob.result.length} 处问题`
                      : '未发现问题'}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {consJob.status === 'running' && (
                    <button
                      onClick={() => api.stopJob(consJob.id).catch(() => {})}
                      className="text-[11px] text-[var(--text-faint)] hover:text-[var(--seal)]"
                    >
                      停止
                    </button>
                  )}
                  <button
                    onClick={() => setConsJob(null)}
                    className="text-[11px] text-[var(--text-faint)] hover:text-[var(--text)]"
                  >
                    关闭
                  </button>
                </div>
              </div>
              {consJob.status === 'running' && (
                <div className="max-h-24 overflow-y-auto bg-[var(--panel)] px-3.5 py-2 text-[12px] leading-relaxed text-[var(--text-faint)]">
                  {consJob.stream}
                </div>
              )}
              {consJob.status === 'done' && consOpen && Array.isArray(consJob.result) && consJob.result.length > 0 && (
                <div className="max-h-64 space-y-1.5 overflow-y-auto bg-[var(--panel)] px-3.5 py-3">
                  {(consJob.result as ConsistencyIssue[]).map((it, i) => (
                    <div key={i} className="rounded-[9px] border border-[var(--line)] px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-medium ${it.severity === 'high' ? 'text-[var(--seal)]' : it.severity === 'medium' ? 'text-[var(--gold)]' : 'text-[var(--text-dim)]'}`}
                        >
                          {it.severity === 'high'
                            ? '严重'
                            : it.severity === 'medium'
                              ? '中等'
                              : it.severity === 'low'
                                ? '轻微'
                                : '提示'}
                        </span>
                        <span className="text-xs font-medium text-[var(--text)]">{it.issue}</span>
                      </div>
                      {it.location && (
                        <div className="mt-1 text-[11px] text-[var(--text-faint)]">位置：{it.location}</div>
                      )}
                      {it.evidence && (
                        <div className="mt-1 text-[11px] leading-relaxed text-[var(--text-dim)]">{it.evidence}</div>
                      )}
                      {it.suggestion && (
                        <div className="mt-1.5 rounded-[9px] border-l-2 border-[var(--jade)] bg-[var(--jade)]/[0.06] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--text)]/80">
                          <span className="text-[var(--jade)]">建议：</span>
                          {it.suggestion}
                        </div>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => setConsOpen(false)}
                    className="mt-1 text-[11px] text-[var(--text-faint)] hover:text-[var(--gold)]"
                  >
                    收起清单
                  </button>
                </div>
              )}
              {consJob.status === 'done' &&
                consOpen &&
                Array.isArray(consJob.result) &&
                consJob.result.length === 0 && (
                  <div className="bg-[var(--panel)] px-3.5 py-2.5 text-[12px] text-[var(--jade)]">
                    全书未发现前后矛盾或设定冲突
                  </div>
                )}
              {consJob.status === 'done' && !consOpen && (
                <button
                  onClick={() => setConsOpen(true)}
                  className="bg-[var(--panel)] px-3.5 py-2 text-[11px] text-[var(--gold)]"
                >
                  展开问题清单
                </button>
              )}
            </div>
          )}

          {/* 消息流：key 绑定会话 id，切换线索时整列重新入场 */}
          <div
            ref={listRef}
            onScroll={onListScroll}
            // 关掉浏览器的滚动锚定：贴底跟随与「加载更早」的高度补偿都由本组件自己做，
            // 锚定会在实时回复换成正式消息的那一帧把 scrollTop 拉回旧锚点，贴底随之失效
            className="min-h-0 flex-1 overflow-y-auto px-4 py-8 [overflow-anchor:none] sm:px-8 sm:py-10"
          >
            <div key={activeSid || 'blank'} className="thread-swap mx-auto max-w-[760px] space-y-8">
              {messages.length === 0 && !running && !loadingMsgs && (
                <div className="collab-empty">
                  <span className="collab-empty-desk" aria-hidden="true" />
                  <h2>今天想聊《{novel.title}》的哪一部分？</h2>
                  <p>讨论情节、整理设定，或附上选段请管家动手修改。管家改过的每一处都会列成动作记录，可以逐条撤销。</p>
                  <span className="collab-empty-hills" aria-hidden="true" />
                </div>
              )}

              {loadingMsgs && (
                <div className="flex flex-col items-center gap-3 py-16 text-[12px] text-[var(--text-faint)]">
                  <span className="breathing text-[13px] text-[var(--gold)]">◍</span>
                  正在载入这条线索……
                </div>
              )}

              {msgStart > 0 && (
                <button
                  onClick={loadEarlier}
                  className="mx-auto block rounded-full bg-[var(--panel2)] px-3.5 py-1.5 text-[12px] text-[var(--text-faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  加载更早的消息（还有 {msgStart} 条）
                </button>
              )}

              {shownMsgs.map((m, i) => (
                <div key={`${m.role}-${m.at}-${msgStart + i}`}>
                  {m.role === 'user' ? (
                    <div className="msg-user flex justify-end">
                      <div className="max-w-[min(640px,82%)]">
                        <div className="mono mb-1.5 pr-1 text-right text-[10px] text-[var(--text-faint)]">
                          {fmtTime(m.at)}
                        </div>
                        {(m.attachments?.length || 0) > 0 && (
                          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                            {m.attachments!.map(a => (
                              <img
                                key={a.file}
                                src={api.attachmentUrl(a.file)}
                                alt={a.name}
                                title={a.name}
                                className="h-24 w-32 rounded-[9px] object-cover ring-1 ring-[var(--line)]"
                              />
                            ))}
                          </div>
                        )}
                        <div className="msg-bubble-user">{m.content}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="msg-assistant group">
                      {assistantMeta(m.at)}
                      <Markdown text={m.content} className="msg-body" />
                      {!!m.research?.sources?.length && (
                        <details className="mt-3 rounded-[10px] border border-[var(--line-soft)] bg-[var(--panel2)]/45">
                          <summary className="cursor-pointer px-3 py-2 text-[11.5px] text-[var(--text-dim)]">
                            联网来源 · {m.research.sources.length}
                          </summary>
                          <ul className="space-y-1.5 px-3 pb-3">
                            {m.research.sources.map((s, i) => (
                              <li key={`${s.url}-${i}`} className="text-[11.5px] leading-[1.65]">
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[var(--jade)] hover:underline"
                                >
                                  [{i + 1}] {s.title || s.url}
                                </a>
                                {s.snippet && (
                                  <span className="ml-1 text-[var(--text-faint)]">{s.snippet.slice(0, 90)}…</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {(m.actions?.length || 0) > 0 && (
                        <div className="mt-1">{m.actions!.map(a => actionCard(a, m.at))}</div>
                      )}
                      {m.needsPersist && !running && (
                        <div className="mt-2 rounded-[12px] border border-[var(--gold)]/35 bg-[var(--gold)]/[0.06] px-3 py-2">
                          <p className="text-[12px] leading-[1.7] text-[var(--text-dim)]">
                            这段正文还没写进「成书」——点一下即可落库，不用再打字。
                          </p>
                          {persistTarget?.at === m.at ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <MenuSelect
                                ariaLabel="写入正文的目标章节"
                                value={String(persistChapter)}
                                onChange={v => setPersistChapter(Number(v))}
                                className="h-7 rounded-[9px] border border-transparent bg-[var(--panel2)] px-2 text-[11px] outline-none transition"
                                options={[
                                  { value: '0', label: '选择章号…', muted: true },
                                  ...persistOptions.map(([index, title]) => ({
                                    value: String(index),
                                    label: `第${index}章${title ? ` ${title}` : ''}`
                                  }))
                                ]}
                              />
                              <button
                                onClick={doPersist}
                                disabled={persistBusy || !persistChapter}
                                className="h-7 rounded-[9px] bg-[var(--gold)] px-3 text-[12px] font-medium text-white transition hover:bg-[var(--gold-deep)] disabled:opacity-40"
                              >
                                {persistBusy ? '写入中…' : '写入'}
                              </button>
                              <button
                                onClick={() => setPersistTarget(null)}
                                className="text-[11px] text-[var(--text-faint)] transition hover:text-[var(--text)]"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setPersistTarget({ at: m.at, text: m.content })
                                setPersistChapter(nextUnwrittenChapter)
                              }}
                              className="btn btn--outline btn--sm mt-1.5"
                            >
                              ✚ 写入成书
                            </button>
                          )}
                        </div>
                      )}
                      <div className="msg-tools">
                        <button type="button" onClick={() => copyMsg(m.content)} aria-label="复制这条回复">
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
                            <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
                          </svg>
                          复制
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* 读屏只通报「回复完成」：流式增量与每秒计时不进 live 区域，避免刷屏 */}
              <span className="sr-only" role="status">
                {job?.status === 'done' ? '管家已回复' : ''}
              </span>
              {running && (
                <div className="msg-assistant msg-live" aria-busy="true">
                  {assistantMeta(undefined, `${livePhase} · ${fmtElapsed(liveSeconds)}`)}
                  {reasoningText && (
                    <div className={`msg-think${showThinking ? ' is-open' : ''}${streamText ? ' is-done' : ''}`}>
                      <button
                        type="button"
                        aria-expanded={showThinking}
                        onClick={() => setShowThinking(s => !s)}
                        className="msg-think-head"
                      >
                        <span className="msg-think-dot" aria-hidden="true" />
                        <span>{streamText ? '思考过程' : '思考中'}</span>
                        <small>{reasoningText.length.toLocaleString()} 字</small>
                        <span className="msg-think-toggle">{showThinking ? '收起' : '展开'}</span>
                      </button>
                      <div className="msg-think-collapse">
                        <div className="msg-think-body">
                          {reasoningText.length > 600 ? `……${reasoningText.slice(-600)}` : reasoningText}
                        </div>
                      </div>
                    </div>
                  )}
                  {streamText ? (
                    <Markdown text={smoothStream} className="msg-body is-streaming" />
                  ) : (
                    !reasoningText && (
                      <div className="msg-working">
                        <span className="msg-working-bar" aria-hidden="true" />
                        {waitingFirstToken
                          ? '模型思考较久，首段正文到达后会逐字显示；也可以点停止'
                          : '正在研读本书档案与我们的对话'}
                      </div>
                    )
                  )}
                  {liveActions.map(a => actionCard(a, 0))}
                </div>
              )}
            </div>
          </div>

          {/* 附选段：挑好章节/段落随消息原文发出，管家据此精确修改 */}
          <div className="shrink-0 px-3 sm:px-6">
            <div className="mx-auto max-w-[760px]">
              <div className="mb-2.5 overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--panel)]">
                <div className="flex items-center gap-2 px-3.5 py-1.5">
                  <button
                    onClick={() => setSelOpen(!selOpen)}
                    aria-expanded={selOpen}
                    title="选中章节/段落附到消息里，管家会按段号精确改写这段"
                    className="flex items-center gap-1.5 text-[11px] text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
                  >
                    <span
                      className={`text-[10px] text-[var(--text-faint)] transition-transform ${selOpen ? 'rotate-90' : ''}`}
                    >
                      ▸
                    </span>
                    引用正文选段
                  </button>
                  {selChapter > 0 && selParas.length > 0 && (
                    <span className="mono rounded-[7px] bg-[color-mix(in_srgb,var(--gold)_12%,var(--panel))] px-1.5 py-px text-[10px] leading-[16px] text-[var(--gold)]">
                      第{selChapter}章 · {selParas.length} 段
                    </span>
                  )}
                  <button
                    onClick={() => setSel(0, [])}
                    className="ml-auto text-[11px] text-[var(--text-faint)] transition hover:text-[var(--seal)]"
                  >
                    清除选段
                  </button>
                </div>
                {selOpen && (
                  <div className="px-3.5 pb-3 pt-2">
                    <div className="flex items-center gap-2">
                      <MenuSelect
                        ariaLabel="引用选段的章节"
                        value={String(selChapter)}
                        onChange={v => setSel(Number(v), [])}
                        className="h-7 rounded-[9px] border border-transparent bg-[var(--panel2)] px-2 text-[11px] outline-none transition"
                        options={[
                          { value: '0', label: '选择章节，点下面的段落即可勾选…', muted: true },
                          ...chapters.map(c => ({
                            value: String(c.index),
                            label: `第${c.index}章${c.title ? ` ${c.title}` : ''}`
                          }))
                        ]}
                      />
                      {selChapter > 0 && selChapterParas.length > 0 && (
                        <button
                          onClick={() =>
                            setSel(
                              selChapter,
                              selChapterParas.map((_, i) => i + 1)
                            )
                          }
                          className="text-[11px] text-[var(--text-faint)] transition hover:text-[var(--gold)]"
                        >
                          选整章
                        </button>
                      )}
                    </div>
                    {selChapter > 0 &&
                      (selChapterParas.length > 0 ? (
                        <div className="mt-2 max-h-52 space-y-1 overflow-y-auto pr-1">
                          {selChapterParas.map((p, i) => {
                            const n = i + 1
                            const on = selParas.includes(n)
                            return (
                              <button
                                key={n}
                                onClick={() => togglePara(n)}
                                aria-pressed={on}
                                className={`flex w-full items-start gap-2 rounded-[9px] border px-2 py-1.5 text-left transition ${
                                  on
                                    ? 'border-[var(--gold)]/50 bg-[var(--gold)]/[0.08]'
                                    : 'border-[var(--line)] bg-[var(--panel)]/50 hover:border-[var(--gold)]/30'
                                }`}
                              >
                                <span
                                  className={`mono mt-px w-7 shrink-0 text-right text-[10px] ${on ? 'text-[var(--gold)]' : 'text-[var(--text-faint)]'}`}
                                >
                                  {n}
                                </span>
                                <span
                                  className={`whitespace-pre-wrap text-[12px] leading-[1.7] ${on ? 'text-[var(--text)]' : 'text-[var(--text-dim)]'}`}
                                >
                                  {p}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="mt-2 text-[11px] text-[var(--text-faint)]">
                          本章还没有正文，先到「成书」页写一章再回来选段。
                        </p>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 隐藏的文件选择器：＋ 菜单里的「插入图片 / 附加文档」复用 */}
          <input
            aria-label="添加图片附件"
            ref={imgInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={e => {
              void addImages(e.target.files)
              e.target.value = ''
            }}
          />
          <input
            aria-label="添加文本附件"
            ref={docInputRef}
            type="file"
            accept=".txt,.md,.markdown"
            className="hidden"
            onChange={e => {
              void addDoc(e.target.files)
              e.target.value = ''
            }}
          />

          <Composer
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={stop}
            running={running}
            sendDisabled={!models.length || uploading || loadingMsgs || agentModeBusy}
            hasAttachments={pending.length > 0 || !!selQuote}
            hint={running ? 'Enter 排队 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行'}
            placeholder="描述你的问题，或说明希望怎样修改…"
            plusTitle="添加图片 / 文档 / 选段"
            plusMenu={[
              { label: '插入图片（随消息发给模型）', onSelect: () => imgInputRef.current?.click() },
              { label: '附加文档（.txt / .md）', onSelect: () => docInputRef.current?.click() },
              { label: selOpen ? '收起附选段' : '附选段（精确改写某几段）', onSelect: () => setSelOpen(v => !v) }
            ]}
            topSlot={
              pending.length || uploading ? (
                <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
                  {pending.map(p =>
                    p.kind === 'image' ? (
                      <span key={p.key} className="group/att relative">
                        <img
                          src={p.url}
                          alt={p.name}
                          title={p.name}
                          className="h-14 w-20 rounded-[9px] object-cover ring-1 ring-[var(--line)]"
                        />
                        <button
                          type="button"
                          onClick={() => removePending(p.key)}
                          aria-label={`移除 ${p.name}`}
                          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--text)] text-[10px] leading-none text-[var(--bg)] opacity-100 transition"
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span
                        key={p.key}
                        className="flex max-w-[220px] items-center gap-1.5 rounded-[9px] bg-[var(--panel2)] px-2 py-1.5 text-[11px] text-[var(--text-dim)]"
                      >
                        <span className="truncate">{p.name}</span>
                        <button
                          type="button"
                          onClick={() => removePending(p.key)}
                          aria-label={`移除 ${p.name}`}
                          className="shrink-0 text-[var(--text-faint)] transition hover:text-[var(--seal)]"
                        >
                          ×
                        </button>
                      </span>
                    )
                  )}
                  {uploading && <span className="text-[11px] text-[var(--text-faint)]">正在上传图片……</span>}
                </div>
              ) : null
            }
            onQueue={text => setQueued([...queuedRef.current, text])}
            aboveSlot={
              queued.length > 0 ? (
                <div className="collab-queue" aria-label="排队中的消息">
                  {queued.map((q, i) => (
                    <div key={`${i}-${q.slice(0, 12)}`} className="collab-queue-item">
                      <span className="collab-queue-idx">{running || i > 0 ? `排队 ${i + 1}` : '待发送'}</span>
                      <span className="collab-queue-text" title={q}>
                        {q}
                      </span>
                      {!running && i === 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            // 发送成功才出队：send 可能因上传中 / 加载中等返回 false，
                            // 先出队再发会让消息凭空丢失（自动队列有回队，手动也要有）。
                            // 完成时按内容找当前位置，期间队列被增删也不会移错项
                            void send(q).then(ok => {
                              if (!ok) return
                              const cur = queuedRef.current
                              const at = cur.indexOf(q)
                              if (at >= 0) setQueued(cur.filter((_, j) => j !== at))
                            })
                          }}
                        >
                          发送
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="移出队列"
                        onClick={() => setQueued(queued.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : undefined
            }
            modelSlot={
              models.length > 0 ? (
                <ModelSelect
                  variant="pill"
                  hotkey
                  disabled={running}
                  value={modelId}
                  onChange={chooseModel}
                  models={models}
                  placeholder="使用默认模型"
                />
              ) : undefined
            }
            toolbar={
              <span className={`collab-permission collab-permission--${agentMode}`}>
                <BIcon name={curModeMeta.icon} size={13} />
                <MenuSelect
                  value={agentMode}
                  disabled={running || agentModeBusy}
                  ariaLabel="授权模式"
                  title={curModeMeta.hint}
                  className="collab-permission-trigger"
                  options={AGENT_MODES.map(m => ({
                    value: m.id,
                    label: m.label,
                    hint: m.id === 'full' ? '高风险' : undefined
                  }))}
                  onChange={async mode => {
                    const next = mode as AgentMode
                    setAgentModeBusy(true)
                    try {
                      if (
                        next === 'full' &&
                        !(await confirmDialog({
                          title: '允许高风险操作？',
                          body: '完全访问允许 AI 直接删书、删章和清空正文，不再逐次询问。此授权会记住，部分操作无法撤销。',
                          confirmText: '允许完全访问',
                          danger: true
                        }))
                      )
                        return
                      setAgentMode(next)
                    } finally {
                      setAgentModeBusy(false)
                    }
                  }}
                />
              </span>
            }
          />

          {/* 完全访问不再在输入框下方挂一条红色警示：授权胶囊本身是朱砂色，切换时已经确认过一次 */}
          {(!models.length || !allowDangerous) && (
            <div className="shrink-0 px-6 pb-3">
              <div className="collab-footer">
                {!models.length && <span>尚未配置模型</span>}
                {!models.length && !allowDangerous && <span>·</span>}
                {!allowDangerous && (
                  <span>
                    {agentMode === 'chat' ? '仅讨论，不修改作品' : '允许修改设定、大纲与正文；请核对动作记录'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右栏：本书速览与正在讨论的章节，只读参考，不打断对话 */}
        <aside className="collab-aside" aria-label="本书速览">
          <section className="collab-aside-card">
            <h2 className="ink-section-title">本书设定速览</h2>
            <dl className="collab-facts">
              <div>
                <dt>书名</dt>
                <dd>《{novel.title}》</dd>
              </div>
              <div>
                <dt>类型</dt>
                <dd>{novel.genre || '未分类'}</dd>
              </div>
              <div>
                <dt>主要人物</dt>
                <dd>
                  {[novel.protagonist, ...novel.characters]
                    .map(c => c?.name)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join('、') || '尚未填写'}
                </dd>
              </div>
              <div>
                <dt>世界观</dt>
                <dd className="collab-facts-clamp">{novel.worldview?.split('\n')[0] || '尚未填写'}</dd>
              </div>
            </dl>
          </section>
          <section className="collab-aside-card">
            <h2 className="ink-section-title">正在讨论的章节</h2>
            {selChapter > 0 ? (
              <button type="button" className="collab-chapter-current" onClick={() => setSelOpen(true)}>
                <span>第 {selChapter} 章</span>
                <small>{selParas.length ? `已引用 ${selParas.length} 段` : '尚未选段'}</small>
              </button>
            ) : (
              <p className="collab-aside-note">在输入区点「引用正文选段」，可以带上章节与段落原文。</p>
            )}
            <div className="collab-chapter-list">
              {[...(novel.chapters || [])]
                .sort((a, b) => b.index - a.index)
                .slice(0, 5)
                .map(c => (
                  <button
                    key={c.index}
                    type="button"
                    className="collab-chapter-row"
                    onClick={() => {
                      setSel(c.index, [])
                      setSelOpen(true)
                    }}
                  >
                    <span>
                      第 {c.index} 章 · {c.title || '未命名'}
                    </span>
                    <small>{c.words.toLocaleString()} 字</small>
                  </button>
                ))}
            </div>
          </section>
          <section className="collab-aside-card">
            <h2 className="ink-section-title">快捷信息</h2>
            <dl className="collab-facts">
              <div>
                <dt>总字数</dt>
                <dd className="ink-num">
                  {(novel.chapters || []).reduce((s, c) => s + (c.words || 0), 0).toLocaleString('zh-CN')}
                </dd>
              </div>
              <div>
                <dt>章节数</dt>
                <dd className="ink-num">{(novel.chapters || []).length}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}

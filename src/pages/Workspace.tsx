import { useCallback, useEffect, useRef, useState } from 'react'
import './planning.css'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { desktop } from '../lib/desktop'
import { WORD_OPTIONS } from '../lib/constants'
import { useNovel } from '../lib/hooks/useNovel'
import { useModels } from '../lib/hooks/useModels'
import { setChatDraft, getChatDraft, getLastSession, setLastSession } from '../lib/chatDraft'
import { PANE_TABS, WORKSPACE_TABS, type WorkspacePane, type WorkspaceTabKey } from './studio-tabs'
import ModelSelect from '../components/ModelSelect'
import MenuSelect from '../components/MenuSelect'
import { confirmDialog, alertDialog } from '../components/Dialog'
import { CloudScroll, InkLandscape } from '../components/InkArt'
import { inputCls, SIcon, Icon, newId, type IconName } from './workspace/shared'
import Field from './workspace/Field'
import WorldSection from './workspace/WorldSection'
import AssistPanel from './workspace/AssistPanel'
import PresetTile from './workspace/PresetTile'
import './workspace/sections.css'
import PresetModal from './workspace/PresetModal'
import SmartImportModal from './workspace/SmartImportModal'
import PlotlineCard from './workspace/PlotlineCard'
import PlotlineImportModal from './workspace/PlotlineImportModal'
import SkillImportModal from './workspace/SkillImportModal'
import CharacterCard from './workspace/CharacterCard'
import OutlineBoard from './workspace/OutlineBoard'
import ReferenceAnalysisModal from './workspace/ReferenceAnalysisModal'
import type { EditTarget } from './workspace/PresetModal'
import type {
  Novel,
  Character,
  ChapterOutline,
  Presets,
  ParsedSettings,
  SkillPreset,
  Plotline,
  ReferenceAnalysis,
  StyleRecommendation
} from '../types'

/** 设定工作台左栏：子页签的短名与图标（完整名仍以 studio-tabs 为准，用在中间标题） */
const BIBLE_NAV: Partial<Record<WorkspaceTabKey, { label: string; icon: IconName }>> = {
  basic: { label: '基本信息', icon: 'doc' },
  chars: { label: '人物设定', icon: 'user' },
  world: { label: '世界观', icon: 'globe' },
  prompt: { label: '文风', icon: 'brush' },
  ref: { label: '参考作品', icon: 'book' }
}

/** 中间标题下的一句说明 */
const SECTION_DESC: Partial<Record<WorkspaceTabKey, string>> = {
  basic: '作品资料与写作规模。修改后保存，对本书生效。',
  chars: '整理角色身份、动机与人物关系；点「查看 / 编辑」展开全部字段。',
  world: '世界观、剧情元素与额外要求；点一行展开编辑。',
  prompt: '文笔风格、写作模板、写作技能与自定义指令，对每一章生效。',
  ref: '指定参考小说文件夹，分析后可一键补充进本书设定。'
}

const ASSIST_KEY = 'plan-assist'

/** 设定工作区：子页签状态改由 URL 驱动（`sub` 查询参数），组件内不再自持 tab state */
export default function Workspace({
  pane,
  sub,
  onSub
}: {
  pane: WorkspacePane
  /** 当前子页签（来自 URL；非法值回落到该工作区的第一个页签） */
  sub: string | null
  onSub: (key: WorkspaceTabKey) => void
}) {
  const { id } = useParams()
  const navigate = useNavigate()
  const paneKeys = PANE_TABS[pane]
  const tab: WorkspaceTabKey = paneKeys.includes(sub as WorkspaceTabKey) ? (sub as WorkspaceTabKey) : paneKeys[0]
  const [draft, setDraft] = useState<Novel | null>(null)
  const draftRef = useRef<Novel | null>(null)
  const baseRef = useRef<Novel | null>(null)
  const savingPromiseRef = useRef<Promise<boolean> | null>(null)
  const activeIdRef = useRef(id)
  activeIdRef.current = id
  const [saveError, setSaveError] = useState('')
  const [presets, setPresets] = useState<Presets | null>(null)
  const [styleRec, setStyleRec] = useState<StyleRecommendation | null>(null)
  const [skills, setSkills] = useState<SkillPreset[]>([])
  const models = useModels()
  const [dirty, setDirty] = useState(false)
  // 记录大纲是否在本页面被编辑过；未编辑时保存其他设置不得提交旧的大纲快照
  const outlineDirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [savedTip, setSavedTip] = useState(false)
  const [showSmartImport, setShowSmartImport] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [showPlotImport, setShowPlotImport] = useState(false)
  const [showSkillImport, setShowSkillImport] = useState(false)
  const [showRefModal, setShowRefModal] = useState(false)
  // AI 设定助手栏的展开 / 收起只是界面偏好，记在本机
  const [assistOpen, setAssistOpen] = useState(() => {
    try {
      return localStorage.getItem(ASSIST_KEY) !== 'closed'
    } catch {
      return true
    }
  })
  const toggleAssist = (next: boolean) => {
    setAssistOpen(next)
    try {
      localStorage.setItem(ASSIST_KEY, next ? 'open' : 'closed')
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  // 作品数据统一走 useNovel；加载成功后回填草稿并复位「有未保存修改」。
  // 保存时仍需 novel 作为 diff 基线，因此这里取它的返回值。
  const { novel, setNovel, loadError } = useNovel(id, n => {
    const next = structuredClone(n)
    baseRef.current = n
    draftRef.current = next
    setDraft(next)
    outlineDirtyRef.current = false
    setDirty(false)
  })

  useEffect(() => {
    if (loadError) alertDialog({ title: '加载作品失败', body: loadError, tone: 'error' })
  }, [loadError])

  const loadPresets = () =>
    api
      .getPresets()
      .then(setPresets)
      .catch(() => {})
  const loadSkills = () =>
    api
      .getSkills()
      .then(setSkills)
      .catch(() => {})

  useEffect(() => {
    loadPresets()
    loadSkills()
  }, [])

  // 文风推荐：题材/书名/简介变化后防抖请求，按分类粗筛 + 关键词加权给出 top3
  const recGenre = draft?.genre || ''
  const recTitle = draft?.title || ''
  const recSynopsis = draft?.synopsis || ''
  useEffect(() => {
    if (!recGenre && !recTitle && !recSynopsis) {
      setStyleRec(null)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api
        .recommendStyle({ genre: recGenre, title: recTitle, synopsis: recSynopsis })
        .then(r => {
          if (alive) setStyleRec(r)
        })
        .catch(() => {})
    }, 350)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [recGenre, recTitle, recSynopsis])

  const save = async (): Promise<boolean> => {
    if (!id || activeIdRef.current !== id) return false
    // 切页补存 / Ctrl+S 等待同一笔请求，失败不得被吞掉；成功后再检查新输入。
    if (savingPromiseRef.current) {
      if (!(await savingPromiseRef.current)) return false
      return save()
    }
    const captured = draftRef.current
    const baseline = baseRef.current
    if (!captured || !baseline || captured.id !== id) return false
    const base = baseline as unknown as Record<string, unknown>
    const fields = captured as unknown as Record<string, unknown>
    const payload: Record<string, unknown> = { id }
    for (const k of Object.keys(fields)) {
      if (k === 'chapters' || k === 'removedOids') continue
      if (JSON.stringify(fields[k]) !== JSON.stringify(base[k])) payload[k] = fields[k]
    }
    const removed = captured.removedOids || []
    if (removed.length) payload.removedOids = removed
    // 未在本页编辑大纲时，绝不提交可能过期的大纲快照。
    if (!outlineDirtyRef.current) delete payload.outline
    if (Object.keys(payload).length === 1) return true

    setSaving(true)
    setSaveError('')
    const promise = (async (): Promise<boolean> => {
      try {
        const n = await api.updateNovel(id, payload as unknown as Novel)
        if (activeIdRef.current !== id || draftRef.current?.id !== id) return false
        const latest = draftRef.current as unknown as Record<string, unknown>
        const merged = structuredClone(n) as unknown as Record<string, unknown>
        // 只回填自请求发出后未被再次编辑的字段，后续输入留在草稿里。
        for (const k of Object.keys(latest)) {
          if (k === 'removedOids') continue
          if (JSON.stringify(latest[k]) !== JSON.stringify(fields[k])) merged[k] = latest[k]
        }
        const pendingRemoved = (draftRef.current.removedOids || []).filter(oid => !removed.includes(oid))
        if (pendingRemoved.length) merged.removedOids = pendingRemoved
        else delete merged.removedOids
        const next = merged as unknown as Novel
        const stillDirty = Object.keys(merged).some(
          k =>
            k !== 'chapters' &&
            JSON.stringify(merged[k]) !== JSON.stringify((n as unknown as Record<string, unknown>)[k])
        )
        outlineDirtyRef.current =
          JSON.stringify(next.outline) !== JSON.stringify(n.outline) || pendingRemoved.length > 0
        baseRef.current = n
        draftRef.current = next
        dirtyRef.current = stillDirty
        setNovel(n)
        setDraft(next)
        setDirty(stillDirty)
        setSavedTip(!stillDirty)
        if (n.warnings?.length) {
          void alertDialog({ title: '保存时发现以下问题', body: n.warnings.join('\n'), tone: 'warning' })
        }
        return true
      } catch (e) {
        const message = (e as Error).message
        setSaveError(message)
        void alertDialog({ title: '保存失败，修改仍保留在当前页面', body: message, tone: 'error' })
        return false
      } finally {
        savingPromiseRef.current = null
        setSaving(false)
      }
    })()
    savingPromiseRef.current = promise
    return promise
  }

  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const saveRef = useRef(save)
  saveRef.current = save

  // 切页签 / 切路由会整体卸载本组件：手上的设定草稿（书名/简介/人物/大纲编辑…）
  // 不补存就静默丢了。与 Ctrl+S 同一条保存路径，只在确有修改时补一笔。
  useEffect(() => {
    return () => {
      if (dirtyRef.current) void saveRef.current()
    }
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirtyRef.current) saveRef.current()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  /**
   * 列表项回调工厂：把「按 id / 下标」的处理器缓存成稳定引用。
   * 子组件（OutlineRow / PlotlineCard / CharacterCard）已 memo 化，若每次渲染都新建内联箭头函数，
   * memo 会全部失效 —— 上百章大纲时每敲一个字都要重渲染整列。
   *
   * 工厂本身用 useCallback 缓存（必须声明在早返回之前，遵守 Hooks 调用顺序）；
   * 内部统一走 `ops` ref 取「当次渲染最新」的操作函数，因此依赖数组恒为空。
   */
  const ops = useRef({
    updateChar: (_cid: string, _patch: Partial<Character>) => {},
    removeChar: (_cid: string) => {},
    updateOutline: (_i: number, _patch: Partial<ChapterOutline>) => {},
    moveOutline: (_i: number, _dir: -1 | 1) => {},
    removeOutlineRow: (_i: number) => {},
    updateWith: (_fn: (d: Novel) => Partial<Novel>) => {}
  })

  const makeCharHandler = useCallback(
    (cid: string) => (patch: Partial<Character>) => ops.current.updateChar(cid, patch),
    []
  )
  const makeCharRemover = useCallback((cid: string) => () => ops.current.removeChar(cid), [])
  // 规划板直接传 (章序号, 补丁)，与旧的「每行一个回调」不同
  const patchOutline = useCallback((i: number, data: Partial<ChapterOutline>) => ops.current.updateOutline(i, data), [])
  const makePlotlineHandler = useCallback(
    (lid: string) => (patch: Partial<Plotline>) =>
      ops.current.updateWith(d => ({
        plotlines: (d.plotlines || []).map(x => (x.id === lid ? { ...x, ...patch } : x))
      })),
    []
  )
  const makePlotlineRemover = useCallback(
    (lid: string) => () => ops.current.updateWith(d => ({ plotlines: (d.plotlines || []).filter(x => x.id !== lid) })),
    []
  )

  if (!draft || !novel) return <div className="p-10 text-[var(--text-dim)]">加载中……</div>

  const applyPatch = (patch: Partial<Novel>) => {
    const d = draftRef.current
    if (!d) return
    draftRef.current = { ...d, ...patch }
    setDraft(draftRef.current)
    dirtyRef.current = true
    setDirty(true)
    setSavedTip(false)
    setSaveError('')
  }

  const update = (patch: Partial<Novel>) => applyPatch(patch)

  /**
   * 依据「最新 draft」计算补丁。
   * 所有由输入框连续触发的更新都必须走这里：若沿用渲染时捕获的 draft 闭包，
   * 多次 onChange 落到同一次渲染上时会互相覆盖，表现为输入框只能吃进第一个字符。
   */
  const updateWith = (fn: (d: Novel) => Partial<Novel>) => {
    const d = draftRef.current
    if (d) applyPatch(fn(d))
  }

  const updateProtagonist = (patch: Partial<Character>) =>
    updateWith(d => ({ protagonist: { ...d.protagonist, ...patch } }))

  const updateChar = (cid: string, patch: Partial<Character>) =>
    updateWith(d => ({ characters: (d.characters || []).map(c => (c.id === cid ? { ...c, ...patch } : c)) }))

  const addChar = () =>
    updateWith(d => ({
      characters: [
        ...(d.characters || []),
        { id: newId(), name: '', role: '', personality: '', appearance: '', background: '', notes: '' }
      ]
    }))

  const removeChar = (cid: string) => updateWith(d => ({ characters: (d.characters || []).filter(c => c.id !== cid) }))

  // AI 智能分配：把解析结果合并进设定表（非空字段才覆盖，配角按所选方式导入）
  const applyParsed = (p: ParsedSettings, replaceChars: boolean) => {
    const patch: Partial<Novel> = {}
    if (p.title) patch.title = p.title
    if (p.genre) patch.genre = p.genre
    if (p.pov) patch.pov = p.pov
    if (p.synopsis) patch.synopsis = p.synopsis
    if (p.worldview) patch.worldview = p.worldview
    if (p.elements) patch.elements = p.elements
    if (p.extraRequirements) patch.extraRequirements = p.extraRequirements

    const proto = { ...draft.protagonist }
    for (const k of ['name', 'role', 'personality', 'appearance', 'background', 'notes'] as const)
      if (p.protagonist[k]) proto[k] = p.protagonist[k]
    patch.protagonist = proto

    if (replaceChars) {
      patch.characters = p.characters.map(c => ({ id: newId(), ...c }))
    } else {
      const exist = new Set(draft.characters.map(c => c.name.trim()).filter(Boolean))
      patch.characters = [
        ...draft.characters,
        ...p.characters.filter(c => c.name && !exist.has(c.name.trim())).map(c => ({ id: newId(), ...c }))
      ]
    }
    update(patch)
    setShowSmartImport(false)
  }

  const updateOutline = (i: number, patch: Partial<ChapterOutline>) => {
    outlineDirtyRef.current = true
    updateWith(d => ({ outline: (d.outline || []).map((o, k) => (k === i ? { ...o, ...patch } : o)) }))
  }

  // 剧情线操作
  const addPlotline = () =>
    updateWith(d => ({
      plotlines: [
        ...(d.plotlines || []),
        { id: newId(), name: '', type: '主线', goal: '', description: '', status: 'pending', beats: [], characters: [] }
      ]
    }))

  const applyPlotlines = (lines: Plotline[], mode: 'replace' | 'append') => {
    if (!lines.length) return
    updateWith(d => ({ plotlines: mode === 'replace' ? lines : [...(d.plotlines || []), ...lines] }))
    setShowPlotImport(false)
  }

  // 应用参考作品分析：人物去重补入角色表、世界观/剧情元素/关系/主题追加到对应栏目
  const mergeBlock = (existing: string, label: string, fresh: string) => {
    const e = (existing || '').trim()
    const f = (fresh || '').trim()
    if (!f) return e
    return e ? `${e}\n\n【${label}】\n${f}` : `【${label}】\n${f}`
  }

  const spreadAnalysis = (a: ReferenceAnalysis, folder?: string) => {
    const patch: Partial<Novel> = {}
    if (folder) patch.folderPath = folder
    // 人物去重补入角色表；主角为空时第一个分析角色补为主角（与后端 apply-analysis 一致）
    patch.characters = draft.characters
    const existingNames = new Set<string>()
    draft.characters.forEach(c => c.name && existingNames.add(c.name))
    if (draft.protagonist?.name) existingNames.add(draft.protagonist.name)
    for (const c of a.characters || []) {
      if (!c?.name || existingNames.has(c.name)) continue
      if (!draft.protagonist?.name && !draft.protagonist?.role) {
        patch.protagonist = { id: newId(), ...c }
      } else {
        patch.characters = [...patch.characters, { id: newId(), ...c }]
      }
      existingNames.add(c.name)
    }
    // 剧情走向 → 补充简介（仅在尚无简介时）
    const sp = (a.plotSummary || '').trim()
    if (sp && !draft.synopsis.trim()) patch.synopsis = `【参考作品剧情走向】\n${sp}`
    // 世界观 / 剧情元素 / 文风 / 关系 / 主题 → 追加到对应栏目
    patch.worldview = mergeBlock(draft.worldview, '参考作品世界观', a.worldBuilding)
    patch.elements = mergeBlock(draft.elements, '参考作品剧情元素', a.plotEvents)
    const styleText = mergeBlock('', '参考作品文风', a.writingStyle)
    const relations = mergeBlock(draft.extraRequirements, '参考作品核心关系', a.keyRelationships)
    const themes = mergeBlock('', '参考作品主题', a.themes)
    patch.extraRequirements = [relations, styleText, themes].filter(Boolean).join('\n')
    update(patch)
    setShowRefModal(false)
  }

  const moveOutline = (i: number, dir: -1 | 1) => {
    outlineDirtyRef.current = true
    return updateWith(d => {
      const j = i + dir
      if (j < 0 || j >= (d.outline?.length || 0)) return {}
      const arr = [...(d.outline || [])]
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      return { outline: arr.map((o, k) => ({ ...o, index: k + 1 })) }
    })
  }

  // 删除大纲行：记录被删 oid，保存时告知服务端"这是用户明确删除，不是快照过期"。
  // 删除后后续章号立即重排，与已写正文的对应关系会错位——必须先确认
  const removeOutlineRow = async (i: number) => {
    const o = draft.outline?.[i]
    if (!o) return
    const written = (draft.chapters || []).find(c => c.index === o.index && (c.content || '').trim())
    const ok = await confirmDialog({
      title: `删除第 ${o.index} 章规划「${o.title || '未命名'}」？`,
      body: written
        ? `这一章已有 ${written.words || (written.content || '').replace(/\s/g, '').length} 字正文。删除规划不会删除正文，但后续章节规划会重新编号，与已写正文的章号对应关系将错位。`
        : '删除后，后续章节规划会立即重新编号。保存后生效。',
      confirmText: '删除规划',
      danger: true
    })
    if (!ok) return
    outlineDirtyRef.current = true
    updateWith(d => {
      const cur = d.outline?.[i]
      if (!cur) return {}
      return {
        outline: d.outline.filter((_, k) => k !== i).map((x, k) => ({ ...x, index: k + 1 })),
        removedOids: [...(d.removedOids || []), cur.oid]
      }
    })
  }

  const activeStyle = presets?.styles.find(s => s.id === draft.authorStyleId)
  const recIds = new Set(styleRec?.picks.map(p => p.id) || [])
  // 「自动」档当前会落到哪位作家（按题材+标题+简介实时推荐）
  const autoStyleName =
    draft.authorStyleId === 'auto' ? presets?.styles.find(s => s.id === styleRec?.top)?.name || '待定' : ''
  const activeTemplate = presets?.templates.find(t => t.id === draft.templateId)
  // 已写到的最远章号：剧情线泳道据此标出「当前进度」所在的节点
  const writtenUpTo = (draft.chapters || []).reduce(
    (max, c) => (c.index > max && (c.words > 0 || !!(c.content || '').trim()) ? c.index : max),
    0
  )

  // 把当次渲染的最新操作函数写回工厂用的 ref（就地覆盖，不改 ref 引用本身）
  ops.current.updateChar = updateChar
  ops.current.removeChar = removeChar
  ops.current.updateOutline = updateOutline
  ops.current.moveOutline = moveOutline
  ops.current.removeOutlineRow = removeOutlineRow
  ops.current.updateWith = updateWith

  // AI 设定助手：不在这里调模型。先保存设定，再把问题写进「与 AI 讨论」将要打开的会话草稿（与讨论页
  // 「续上次会话，否则最新一个」的规则一致；本书还没有会话就新建一个），最后跳过去，由作者确认后发送。
  const askAssistant = async (question: string): Promise<string | void> => {
    if (!id) return '未找到当前作品。'
    if (!(await save())) return '设定没有保存成功，问题还在输入框里，请重试。'
    const { sessions } = await api.listChatSessions(id)
    const remembered = getLastSession(id)
    let sid = (sessions.find(s => s.id === remembered) || sessions[0])?.id
    if (!sid) {
      sid = (await api.createChatSession(id, '设定讨论')).session.id
      setLastSession(id, sid)
    }
    const prev = getChatDraft(id, sid).input.trim()
    setChatDraft(id, { input: prev ? `${prev}\n\n${question}` : question }, sid)
    navigate('/butler?id=' + id)
  }

  const statusText = saving
    ? '正在保存… 可继续编辑'
    : saveError
      ? '保存失败，修改未丢失，请重试'
      : savedTip
        ? '已保存'
        : dirty
          ? '有未保存的修改 · Ctrl+S'
          : '已与保存版本同步'
  const statusTone = saveError ? ' ink-status ink-status--seal' : savedTip ? ' ink-status ink-status--jade' : ''
  const saveStatus = (
    <span
      className={`plan-status${statusTone}${dirty && !saving && !saveError ? ' text-[var(--gold)]' : ''}`}
      role="status"
    >
      {statusText}
    </span>
  )
  const smartImportBtn = (
    <button
      onClick={() => setShowSmartImport(true)}
      className={`btn ${pane === 'bible' ? 'btn--outline' : 'btn--ghost'} btn--md`}
      title="粘贴一大段自由格式的设定，AI 自动分拣填入各字段（AI 智能分配）"
    >
      <Icon name="clipboard" size={16} /> 批量粘贴解析
    </button>
  )
  const saveBtn = (
    <button onClick={save} disabled={saving || !dirty} className="btn btn--primary btn--md">
      {saving ? '保存中……' : '保存'}
    </button>
  )
  // 切子页签前先补存（与原行为一致：保存失败就留在当前页）
  const switchSub = async (key: WorkspaceTabKey) => {
    if (await save()) onSub(key)
  }
  const subTabs = WORKSPACE_TABS.filter(t => paneKeys.includes(t.key))
  const tabLabel = WORKSPACE_TABS.find(t => t.key === tab)?.label

  // 设定工作台：左栏子导航 + 中间页头（┃ 标题、批量粘贴解析、保存）
  const bibleHead = (
    <>
      <div className="plan-subnav">
        <h1 className="plan-subnav__title">设定工作台</h1>
        <div className="plan-subnav__orn" aria-hidden="true" />
        <div className="ink-subnav" role="group" aria-label="设定分类">
          {subTabs.map(t => (
            <button
              key={t.key}
              className="ink-subnav-item"
              aria-pressed={tab === t.key}
              aria-controls="planning-panel"
              onClick={() => void switchSub(t.key)}
            >
              {BIBLE_NAV[t.key] && <Icon name={BIBLE_NAV[t.key]!.icon} size={17} />}
              {BIBLE_NAV[t.key]?.label || t.label}
            </button>
          ))}
        </div>
      </div>
      <header className="plan-head">
        <div className="plan-head__title">
          <h2 className="ink-bar-title plan-head__h">{tabLabel}</h2>
          {smartImportBtn}
        </div>
        <div className="plan-head__actions">
          {saveStatus}
          {saveBtn}
          <button
            className="btn btn--ghost btn--md plan-head__assist"
            onClick={() => toggleAssist(true)}
            aria-expanded={false}
          >
            <Icon name="sparkle" size={15} /> AI 设定助手
          </button>
        </div>
        {SECTION_DESC[tab] && <p className="plan-head__desc">{SECTION_DESC[tab]}</p>}
      </header>
    </>
  )

  // 规划：标题 + 下划线页签（总纲 / 剧情线 / 章节大纲）+ 保存，同一行
  const outlineHead = (
    <header className="plan-outline-head">
      <div className="plan-outline-head__brand">
        <h1 className="ink-display plan-outline-head__title">规划</h1>
        <CloudScroll className="plan-outline-head__cloud" />
      </div>
      <div className="ink-tabs plan-tabs" role="group" aria-label="规划分类">
        {subTabs.map(t => (
          <button
            key={t.key}
            className="ink-tab"
            aria-pressed={tab === t.key}
            aria-controls="planning-panel"
            onClick={() => void switchSub(t.key)}
          >
            {t.label}
            {t.key === 'outline' && draft.outline.length > 0 && (
              <span className="plan-tab__count mono">{draft.outline.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="plan-outline-head__actions">
        {saveStatus}
        {smartImportBtn}
        {saveBtn}
      </div>
    </header>
  )

  return (
    <div
      className={`planning-page plan-page${pane === 'bible' ? ' plan-bible' : ' plan-outline'}`}
      data-assist={pane === 'bible' ? (assistOpen ? 'open' : 'closed') : undefined}
    >
      {pane === 'bible' ? bibleHead : outlineHead}

      {/* 切 Tab 属于高频操作：以前这里挂 reveal 会在每次切换时重播 400ms 入场，
          面板像"重新加载"了一次，这里改为直接切换 */}
      <div key={tab} id="planning-panel" className="planning-panel">
        {tab === 'basic' && (
          <div className="ink-card plan-sec space-y-4">
            <h3 className="ink-section-title">作品资料</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="书名">
                <input
                  className={`${inputCls} plan-input--title`}
                  value={draft.title}
                  onChange={e => update({ title: e.target.value })}
                />
              </Field>
              <Field label="类型">
                <input
                  className={inputCls}
                  value={draft.genre}
                  onChange={e => update({ genre: e.target.value })}
                  placeholder="玄幻 / 都市 / 悬疑……"
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="叙事视角">
                <MenuSelect
                  className={inputCls}
                  value={draft.pov}
                  onChange={v => update({ pov: v as 'first' | 'third' })}
                  ariaLabel="叙事视角"
                  options={[
                    { value: 'third', label: '第三人称' },
                    { value: 'first', label: '第一人称' }
                  ]}
                />
              </Field>
              <label className="planning-model-field">
                <span>本书使用模型</span>
                <ModelSelect
                  value={draft.modelId}
                  onChange={v => updateWith(() => ({ modelId: v }))}
                  models={models}
                  placeholder="请选择模型"

                  className={inputCls}
                />
              </label>
            </div>
            <Field label="故事简介">
              <textarea
                className={inputCls}
                rows={5}
                value={draft.synopsis}
                onChange={e => update({ synopsis: e.target.value })}
                placeholder="用一段话概括整个故事的核心冲突与走向"
              />
            </Field>
            <hr className="ink-rule !my-5" />
            <h3 className="ink-section-title">写作规模</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="计划章节数">
                <input
                  type="number"
                  min={1}
                  className={inputCls}
                  value={draft.chapterCount}
                  onChange={e => update({ chapterCount: e.target.value === '' ? 0 : Number(e.target.value) })}
                  onBlur={e => {
                    // 只做「至少 1」的下限保护，不设上限：这个数字是全书规模参考，
                    // 由作者自己定，不参与任何生成配额，也不会被大纲条数改写。
                    const v = Math.max(1, Math.floor(Number(e.target.value) || 1))
                    e.target.value = String(v)
                    if (v !== draft.chapterCount) update({ chapterCount: v })
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
              </Field>
              <Field label="每章目标字数">
                <MenuSelect
                  className={inputCls}
                  value={String(draft.targetWords)}
                  onChange={v => update({ targetWords: Number(v) })}
                  ariaLabel="每章目标字数"
                  options={WORD_OPTIONS.map(w => ({ value: String(w), label: `${w} 字` }))}
                />
              </Field>
            </div>
            <p className="plan-sec__note">
              「计划章节数」与「每章目标字数」只是<b>全书规模参考</b>
              ——用来让 AI 知道你打算写多长、每章大约多少字，
              它不参与任何生成配额，也不会被大纲条数改写。大纲可直接在本页手动编排，或在「与 AI 讨论」里让 AI
              逐段写出并存入，连载不写死； 文笔与指令在「文风与指令」页配置。
            </p>
          </div>
        )}

        {tab === 'chars' && (
          <div className="plan-chars">
            <CharacterCard title="主角" char={draft.protagonist} onChange={updateProtagonist} lead />
            {draft.characters.map((c, i) => (
              <CharacterCard
                key={c.id}
                title={`配角 ${i + 1}${c.name ? ` · ${c.name}` : ''}`}
                char={c}
                onChange={makeCharHandler(c.id)}
                onRemove={makeCharRemover(c.id)}
              />
            ))}
            <button onClick={addChar} className="plan-char-add">
              <span className="plan-char-add__icon" aria-hidden="true">
                <SIcon name="plus" size={18} />
              </span>
              添加配角
            </button>
          </div>
        )}

        {tab === 'master' && (
          <section className="ink-paper ink-on-paper plan-master" aria-labelledby="plan-master-title">
            <InkLandscape className="plan-master__art" moon={false} pagoda />
            <div className="plan-master__head">
              <h2 id="plan-master-title" className="plan-master__title">
                总纲
              </h2>
              <p className="plan-master__desc">
                记录故事核心、成长线、关键阶段、伏笔与结局。总纲为章节规划和 AI 写作提供参考。
              </p>
            </div>
            <textarea
              className="plan-master__text"
              rows={16}
              aria-label="总纲（可直接编辑）"
              value={draft.masterOutline}
              onChange={e => update({ masterOutline: e.target.value })}
              placeholder={
                '一、故事核心\n……\n\n二、主角成长线\n……\n\n三、剧情阶段\n……\n\n四、关键伏笔清单\n……\n\n五、最终结局构想\n……'
              }
            />
            <div className="plan-master__foot">
              <span className="mono">
                {draft.masterOutline ? `${draft.masterOutline.replace(/\s/g, '').length.toLocaleString()} 字` : '空'}
              </span>
              <span>建议 800~1600 字</span>
            </div>
          </section>
        )}

        {tab === 'plot' && (
          <div>
            <div className="plan-toolbar">
              <div className="plan-toolbar__text">
                <h2 className="ink-bar-title">剧情线</h2>
                <p>
                  剧情线是贯穿全书的并行线索（主线、感情线、悬念线……）。每条线拆成带章号的推进节点，排纲与逐章写作时 AI
                  会对照节点推进，多线不乱。可由 AI 从总纲拆解生成，也可手动添加。
                </p>
              </div>
              <div className="plan-toolbar__actions">
                <button onClick={() => setShowPlotImport(true)} className="btn btn--outline btn--md">
                  <Icon name="sparkle" size={15} /> AI 规划剧情线
                </button>
                <button onClick={addPlotline} className="btn btn--ghost btn--md">
                  <SIcon name="plus" size={14} /> 手动添加
                </button>
              </div>
            </div>
            {(draft.plotlines || []).length === 0 ? (
              <div className="ink-empty">
                <h3>暂无剧情线</h3>
                <p>建议：先在「总纲」页完成总纲，再点「AI 规划剧情线」由 AI 拆解；或手动添加。</p>
              </div>
            ) : (
              <div className="ink-card plan-lanes">
                {(draft.plotlines || []).map(l => (
                  <PlotlineCard
                    key={l.id}
                    line={l}
                    onChange={makePlotlineHandler(l.id)}
                    onRemove={makePlotlineRemover(l.id)}
                    progress={writtenUpTo}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'outline' && (
          <div>
            <div className="plan-toolbar">
              <div className="plan-toolbar__text">
                <h2 className="ink-bar-title">章节大纲</h2>
                <p>章节框架描述要发生的事件；本章指令补充具体写法。编辑后点击保存，再进入正文写作。</p>
              </div>
            </div>
            <OutlineBoard
              items={draft.outline || []}
              chapters={draft.chapters}
              onChange={patchOutline}
              onMove={moveOutline}
              onRemove={removeOutlineRow}
              onAdd={() => {
                outlineDirtyRef.current = true
                updateWith(d => ({
                  outline: [
                    ...(d.outline || []),
                    { index: d.outline.length + 1, title: '', summary: '', customPrompt: '', oid: newId() }
                  ]
                }))
              }}
              onOpenChapter={async idx => {
                if (!(await save())) return
                const target = (draft.chapters || []).find(c => c.index === idx)
                navigate('/novel/' + id + '/chapter/' + (target?.index || idx))
              }}
            />
          </div>
        )}

        {tab === 'world' && <WorldSection draft={draft} update={update} />}

        {tab === 'ref' && (
          <div className="plan-stack">
            <div className="ink-card plan-sec">
              <h3 className="ink-section-title">参考小说</h3>
              <p className="plan-sec__hint">
                指定一个文件夹存放想参考的小说（如原著、同类作品），AI
                会阅读并分析其中的人物设定、剧情事件、世界观、写作风格与人物关系。
                分析结果可一键补充进本书的「人物设定」「世界观与剧情元素」「额外要求」，辅助你创作同人文。生成的正文与大纲也会把参考内容作为语料注入提示词。
              </p>
              <Field label="参考小说文件夹路径">
                <div className="flex gap-2">
                  <input
                    aria-label="参考小说文件夹路径"
                    value={draft.folderPath || ''}
                    onChange={e => update({ folderPath: e.target.value })}
                    placeholder="例：D:/参考作品（支持 .txt / .md 文件）"
                    className={inputCls}
                  />
                  <button
                    onClick={async () => {
                      const shell = desktop()
                      if (shell?.pickFolder) {
                        const p = await shell.pickFolder().catch(() => null)
                        if (p) update({ folderPath: p })
                      } else {
                        alertDialog({
                          title: '当前无法选择文件夹',
                          body: '浏览器模式下没有文件夹选择能力，请手动输入路径，或改用桌面版应用。',
                          tone: 'warning'
                        })
                      }
                    }}
                    type="button"
                    className="btn btn--ghost btn--md shrink-0"
                  >
                    浏览…
                  </button>
                </div>
              </Field>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line-soft)] pt-4">
                <p className="plan-sec__note">
                  把参考小说文件放进上方文件夹后，点「开始分析」。分析可能耗时 30~120 秒，期间可离开本页。
                </p>
                <button onClick={() => setShowRefModal(true)} className="btn btn--outline btn--md">
                  <Icon name="sparkle" size={15} /> 开始分析
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'prompt' && presets && (
          <div className="plan-stack">
            {/* 文笔风格 */}
            <section className="ink-card plan-sec">
              <div className="plan-sec__head">
                <h3 className="ink-section-title">文笔风格</h3>
                <button
                  onClick={() => setEditTarget({ type: 'style', item: { name: '', tag: '', desc: '', prompt: '' } })}
                  className="plan-textbtn plan-textbtn--gold"
                >
                  <SIcon name="plus" size={12} /> 自建文风
                </button>
              </div>
              <p className="plan-sec__hint">
                {draft.authorStyleId === 'auto'
                  ? `按题材自动推荐${autoStyleName ? `：当前偏向「${autoStyleName}」` : ''}。题材、书名或简介变化时会自动调整。`
                  : activeStyle
                    ? activeStyle.desc
                    : '从众多名家的文风中挑选一种，或自建专属文风；AI 将在句式、节奏、意象与情绪处理上模仿其特征。'}
              </p>

              {/* 按题材 + 标题 + 简介的实时推荐 */}
              {styleRec && styleRec.picks.length > 0 && (
                <div className="style-rec reveal">
                  <div className="style-rec__head">
                    <Icon name="sparkle" size={14} />
                    <span>
                      为《{draft.title || '本书'}》推荐
                      {styleRec.genre ? `（${styleRec.genre}）` : ''}
                    </span>
                  </div>
                  <div className="style-rec__picks">
                    {styleRec.picks.map((p, i) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`style-rec__pick${draft.authorStyleId === p.id ? ' is-on' : ''}`}
                        onClick={() => update({ authorStyleId: p.id })}
                        title={p.reason}
                      >
                        <span className="style-rec__rank">{i + 1}</span>
                        <span className="style-rec__name">{p.name}</span>
                        <span className="style-rec__reason">{p.reason}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={`style-rec__auto${draft.authorStyleId === 'auto' ? ' is-on' : ''}`}
                    onClick={() => update({ authorStyleId: 'auto' })}
                  >
                    <Icon name="sparkle" size={13} /> 按题材自动（推荐随书名/简介变化）
                  </button>
                </div>
              )}

              <div className="plan-tiles">
                {presets.styles.map(s => (
                  <PresetTile
                    key={s.id}
                    name={s.name}
                    selected={draft.authorStyleId === s.id}
                    onSelect={() => update({ authorStyleId: s.id })}
                    title={s.desc}
                    custom={
                      <>
                        {!s.builtIn && <span className="plan-tile__badge">自建</span>}
                        {recIds.has(s.id) && <span className="plan-tile__badge plan-tile__badge--rec">推荐</span>}
                      </>
                    }
                    onEdit={
                      s.builtIn
                        ? undefined
                        : () =>
                            setEditTarget({
                              type: 'style',
                              item: {
                                id: s.id,
                                name: s.name,
                                tag: s.tag || '',
                                desc: s.desc || '',
                                prompt: s.prompt || ''
                              }
                            })
                    }
                    onDelete={
                      s.builtIn
                        ? undefined
                        : async () => {
                            const ok = await confirmDialog({
                              title: `删除自建文风「${s.name}」？`,
                              body: '删除后该书将回落到默认文风。',
                              confirmText: '删除',
                              danger: true
                            })
                            if (!ok) return
                            await api
                              .deleteCustomStyle(s.id)
                              .catch(e => alertDialog({ title: '删除失败', body: e.message, tone: 'error' }))
                            if (draft.authorStyleId === s.id) update({ authorStyleId: '' })
                            loadPresets()
                          }
                    }
                  >
                    <span className="plan-tile__desc">{s.tag || '自定义'}</span>
                  </PresetTile>
                ))}
              </div>
            </section>

            {/* 写作模板 */}
            <section className="ink-card plan-sec">
              <div className="plan-sec__head">
                <h3 className="ink-section-title">写作模板</h3>
                <button
                  onClick={() => setEditTarget({ type: 'template', item: { name: '', desc: '', rules: '' } })}
                  className="plan-textbtn plan-textbtn--gold"
                >
                  <SIcon name="plus" size={12} /> 自建模板
                </button>
              </div>
              <p className="plan-sec__hint">
                {activeTemplate
                  ? activeTemplate.rules.join(' ')
                  : '决定每一章的结构方法：场景配比、对话密度、节奏与钩子设计。'}
              </p>
              <div className="plan-tiles">
                {presets.templates.map(t => (
                  <PresetTile
                    key={t.id}
                    name={t.name}
                    selected={draft.templateId === t.id}
                    onSelect={() => update({ templateId: t.id })}
                    title={t.rules.join('；')}
                    custom={!t.builtIn && <span className="plan-tile__badge">自建</span>}
                    onEdit={
                      t.builtIn
                        ? undefined
                        : () =>
                            setEditTarget({
                              type: 'template',
                              item: { id: t.id, name: t.name, desc: t.desc || '', rules: (t.rules || []).join('\n') }
                            })
                    }
                    onDelete={
                      t.builtIn
                        ? undefined
                        : async () => {
                            const ok = await confirmDialog({
                              title: `删除自建模板「${t.name}」？`,
                              body: '删除后该书将回落到默认模板。',
                              confirmText: '删除',
                              danger: true
                            })
                            if (!ok) return
                            await api
                              .deleteCustomTemplate(t.id)
                              .catch(e => alertDialog({ title: '删除失败', body: e.message, tone: 'error' }))
                            if (draft.templateId === t.id) update({ templateId: 'balanced' })
                            loadPresets()
                          }
                    }
                  >
                    <span className="plan-tile__desc">{t.desc}</span>
                  </PresetTile>
                ))}
              </div>
            </section>

            {/* 写作技能 */}
            <section className="ink-card plan-sec">
              <div className="plan-sec__head">
                <h3 className="ink-section-title">写作技能</h3>
                <div className="plan-sec__actions">
                  <button onClick={() => setShowSkillImport(true)} className="plan-textbtn">
                    导入技能
                  </button>
                  <button
                    onClick={() =>
                      setEditTarget({ type: 'skill', item: { name: '', description: '', tags: [], content: '' } })
                    }
                    className="plan-textbtn plan-textbtn--gold"
                  >
                    <SIcon name="plus" size={12} /> 自建技能
                  </button>
                </div>
              </div>
              <p className="plan-sec__hint">
                可多选：选中的技能会把其指令注入每一章的生成、续写、润色与修改提示词（如「钩子开场」「章末钩子」等，自建技能即自定义提示词）。
              </p>
              <div className="plan-tiles">
                {skills.map(s => (
                  <PresetTile
                    key={s.id}
                    name={s.name}
                    tone="jade"
                    selected={(draft.skillIds || []).includes(s.id)}
                    onSelect={() =>
                      updateWith(d => {
                        const cur = d.skillIds || []
                        return { skillIds: cur.includes(s.id) ? cur.filter(x => x !== s.id) : [...cur, s.id] }
                      })
                    }
                    title={s.description}
                    custom={
                      <>
                        {!s.builtIn && <span className="plan-tile__badge">自建</span>}
                        {s.sourceRepo && (
                          <span
                            className="plan-tile__badge"
                            title={`来源：${s.sourceRepo}\n许可：${s.sourceLicense || '见仓库'}`}
                          >
                            内置
                          </span>
                        )}
                      </>
                    }
                    onEdit={
                      s.builtIn
                        ? undefined
                        : () =>
                            setEditTarget({
                              type: 'skill',
                              item: {
                                id: s.id,
                                name: s.name,
                                description: s.description || '',
                                tags: s.tags || [],
                                content: s.content || ''
                              }
                            })
                    }
                    onDelete={
                      s.builtIn
                        ? undefined
                        : async () => {
                            const ok = await confirmDialog({
                              title: `删除自建技能「${s.name}」？`,
                              body: '删除后会从本书的技能列表中移除。',
                              confirmText: '删除',
                              danger: true
                            })
                            if (!ok) return
                            await api
                              .deleteCustomSkill(s.id)
                              .catch(e => alertDialog({ title: '删除失败', body: e.message, tone: 'error' }))
                            if ((draft.skillIds || []).includes(s.id))
                              update({ skillIds: (draft.skillIds || []).filter(x => x !== s.id) })
                            loadSkills()
                          }
                    }
                  >
                    <span className="plan-tile__desc">{s.description}</span>
                    {s.tags?.length > 0 && (
                      <span className="plan-tile__tags">
                        {s.tags.slice(0, 3).map(t => (
                          <span key={t} className="ink-pill">
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </PresetTile>
                ))}
              </div>
              {(draft.skillIds || []).length > 0 && (
                <p className="mt-3 text-[12px] text-[var(--jade)]">
                  已启用 {draft.skillIds.length} 个技能：
                  {(draft.skillIds || [])
                    .map(id => skills.find(s => s.id === id)?.name)
                    .filter(Boolean)
                    .join('、')}
                </p>
              )}
            </section>

            {/* 全局自定义指令 */}
            <section className="ink-card plan-sec">
              <h3 className="ink-section-title">自定义写作指令</h3>
              <p className="plan-sec__hint">
                对每一章都生效的私人要求，与所选风格叠加使用；单章的特殊要求请写在「章节大纲」的各章专属指令里。
              </p>
              <textarea
                className={inputCls}
                rows={5}
                aria-label="自定义写作指令"
                value={draft.customPrompt ?? ''}
                onChange={e => updateWith(() => ({ customPrompt: e.target.value }))}
                placeholder={
                  '例如：\n· 多写人物之间的潜台词，少直白抒情\n· 战斗场面控制在三段以内\n· 每章出现一次环境描写，要有季节感'
                }
              />
              <div className="plan-sec__foot">
                <span className="mono">
                  {(draft.customPrompt ?? '').replace(/\s/g, '').length.toLocaleString()} 字 · 与所选文风叠加生效
                </span>
                <span>每行一条，尽量具体</span>
              </div>
            </section>
          </div>
        )}

        {tab === 'prompt' && !presets && (
          <div className="ink-card py-16 text-center text-[13px] text-[var(--text-faint)]">风格库加载中……</div>
        )}
      </div>

      {/* 收起时只是隐藏，输入框里没发出去的问题不丢 */}
      {pane === 'bible' && <AssistPanel onAsk={askAssistant} onCollapse={() => toggleAssist(false)} />}

      {showSmartImport && (
        <SmartImportModal
          novelId={id || ''}
          modelId={draft.modelId || ''}
          onClose={() => setShowSmartImport(false)}
          onApply={applyParsed}
        />
      )}

      {showPlotImport && (
        <PlotlineImportModal
          masterReady={!!draft.masterOutline?.trim()}
          onClose={() => setShowPlotImport(false)}
          onApply={applyPlotlines}
        />
      )}

      {showSkillImport && (
        <SkillImportModal
          onClose={() => setShowSkillImport(false)}
          onImported={(count, failed, skipped) => {
            loadSkills()
            const parts = [`成功导入 ${count} 个技能`]
            if (skipped.length) parts.push(`${skipped.length} 个重复已跳过（${skipped.join('、')}）`)
            if (failed.length) parts.push(`${failed.length} 个失败（${failed.join('、')}）`)
            if (count > 0 || skipped.length || failed.length) {
              alertDialog({
                title: '技能导入完成',
                body: parts.join('；'),
                tone: failed.length ? 'warning' : 'success'
              })
            }
          }}
        />
      )}

      {showRefModal && (
        <ReferenceAnalysisModal
          novelId={id || ''}
          initialFolder={draft.folderPath || ''}
          modelId={draft.modelId || ''}
          onClose={() => setShowRefModal(false)}
          onSpread={spreadAnalysis}
        />
      )}

      {editTarget && (
        <PresetModal
          key={`${editTarget.type}:${editTarget.item.id ?? 'new'}`}
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            loadPresets()
            loadSkills()
          }}
        />
      )}
    </div>
  )
}

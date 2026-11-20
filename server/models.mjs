// 模型配置与预置库（风格 / 模板 / 技能）管理。
//
// 从 app.mjs 拆出：这块是「配置读写 + 少量网络探测」，与小说/章节/任务等
// 领域逻辑无关，且被 ai.mjs 的解析器注入（setStyleResolver 等）依赖。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { normalizeOpenAIBase, streamChat } from './ai.mjs'
import { CODEX_PROVIDER, getCodexClient } from './codex-responses.mjs'
import { codexError } from './codex-oauth.mjs'
import { probeLocalEndpoint, scanLocalEndpoints } from './local-models.mjs'
import {
  AUTHOR_STYLES,
  PROMPT_TEMPLATES,
  BUILTIN_SKILLS,
  makeCustomStore,
  recommendStyles,
  GENRE_AUTHOR_MAP,
  STYLE_GENRES
} from './presets.mjs'
import {
  DATA_DIR,
  NOVELS_DIR,
  MODELS_FILE,
  STATION_NAMES_FILE,
  STYLES_FILE,
  TEMPLATES_FILE,
  ID_RE,
  readJson,
  writeJson,
  updateJson,
  withFile,
  readJsonAsync,
  writeJsonAsync
} from './store.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGED_SKILLS_DIR = path.join(__dirname, 'skills')

let secureStorage = null
try {
  const electron = await import('electron')
  secureStorage = electron.safeStorage
} catch {
  secureStorage = null
}

function protectApiKey(value) {
  const key = String(value || '').trim()
  if (!key || !secureStorage?.isEncryptionAvailable?.()) return key
  // 解密失败被保留下来的 enc: 串原样透传，不能再加密一层（否则变成 enc:enc:… 永久损坏）
  if (key.startsWith('enc:')) return key
  try {
    return `enc:${secureStorage.encryptString(key).toString('base64')}`
  } catch {
    return key
  }
}

function revealApiKey(value) {
  const key = String(value || '').trim()
  if (!key.startsWith('enc:') || !secureStorage?.isEncryptionAvailable?.()) return key
  try {
    return secureStorage.decryptString(Buffer.from(key.slice(4), 'base64'))
  } catch {
    // 解密失败（如数据来自另一台机器 / 另一个系统账户）：保留原 enc: 串。
    // 返回空串会让 mutateModels 的全表重加密把密钥永久清空——任何一次设默认 / 删模型都触发
    return key
  }
}

// ---------- 多模型管理 ----------
// 用户给中转站自定义的名字（不改 models.json 结构，独立文件互不影响）
function readStationNames() {
  const o = readJson(STATION_NAMES_FILE, {})
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
}

// 分组键：provider + 去尾部斜杠的地址（与前端分组一致）
function stationKey(m) {
  const base = (m.baseUrl || '').replace(/\/+$/, '')
  return `${m.provider}||${base}`
}

// 规范化模型配置：密钥/地址去空白（复制粘贴常带换行空格，导致 401 Invalid token）
// OpenAI 兼容地址自动补 /v1：用户只填中转站裸域名（https://relay.xxx）也能正常工作
//
// local=true 表示本地推理服务（Ollama / LM Studio / llama.cpp …）：
//  - 不要求 API Key（绝大多数本机服务不鉴权）
//  - 记录 contextTokens：本地模型上下文普遍比云端小，提示词要按它裁剪，
//    否则会直接撑爆上下文、表现成「本地模型答非所问或截断」
export function normalizeModel(m) {
  const provider = m.provider === 'gemini' ? 'gemini' : 'openai'
  const thinkingLevel = ['LOW', 'MEDIUM', 'HIGH'].includes(m.thinkingLevel) ? m.thinkingLevel : 'MEDIUM'
  const reasoningEffort = ['default', 'low', 'medium', 'high'].includes(m.reasoningEffort)
    ? m.reasoningEffort
    : 'default'
  if (m.provider === CODEX_PROVIDER) {
    const connectionRef =
      typeof m.connectionRef === 'string' && /^[a-f0-9]{64}$/.test(m.connectionRef) ? m.connectionRef : ''
    return {
      id: m.id,
      name: String(m.name || '').trim(),
      model: String(m.model || '').trim(),
      isDefault: !!m.isDefault,
      baseUrl: '',
      apiKey: '',
      temperature: 0.8,
      provider: CODEX_PROVIDER,
      local: false,
      contextTokens: 0,
      reasoningEffort,
      connectionRef
    }
  }
  const base = String(m.baseUrl || '').trim()
  const local = !!m.local && provider === 'openai'
  const rawCtx = Number(m.contextTokens)
  const contextTokens = Number.isFinite(rawCtx) && rawCtx >= 2048 ? Math.min(Math.floor(rawCtx), 1_048_576) : 0
  return {
    id: m.id,
    isDefault: !!m.isDefault,
    name: String(m.name || '').trim(),
    baseUrl: provider === 'gemini' ? base : normalizeOpenAIBase(base),
    apiKey: revealApiKey(m.apiKey),
    model: String(m.model || '').trim(),
    temperature: typeof m.temperature === 'number' ? m.temperature : 0.8,
    provider,
    local,
    contextTokens,
    thinkingLevel,
    reasoningEffort
  }
}

export function listModels() {
  const arr = readJson(MODELS_FILE, [])
  const names = readStationNames()
  return (Array.isArray(arr) ? arr : []).map(m => {
    const n = normalizeModel(m)
    return { ...n, stationName: names[stationKey(n)] || '' }
  })
}

// 对外展示时掩码密钥，避免明文外泄
export function maskModel(m) {
  const k = m.apiKey || ''
  const masked = k.length >= 8 ? `${k.slice(0, 3)}****${k.slice(-4)}` : k ? '****' : ''
  const {
    id,
    name,
    model,
    baseUrl,
    temperature,
    provider,
    local,
    isDefault,
    contextTokens,
    thinkingLevel,
    reasoningEffort,
    stationName
  } = m
  const publicModel = {
    id,
    name,
    model,
    baseUrl,
    temperature,
    provider,
    local,
    isDefault,
    contextTokens,
    thinkingLevel,
    reasoningEffort,
    stationName: stationName || '',
    apiKey: masked,
    hasKey: !!k
  }
  if (provider !== CODEX_PROVIDER) return publicModel
  const status = getCodexClient()?.status()
  const connectionState =
    !status || status.state === 'unavailable'
      ? 'unavailable'
      : status.state === 'disconnect-error'
        ? 'disconnect-error'
        : status.state !== 'connected'
          ? 'reconnect'
          : status.connectionRef === m.connectionRef
            ? 'connected'
            : 'account-mismatch'
  return { ...publicModel, connectionRef: m.connectionRef, connectionState }
}

export function validModel(m) {
  // 本地模型允许空密钥：要求填 Key 会把绝大多数本机推理服务挡在门外
  if (m?.provider === CODEX_PROVIDER) return Boolean(m.name && m.model && m.connectionRef)
  return !!(m && m.name && m.baseUrl && m.model && (m.apiKey || m.local))
}

function validateModelBinding(model, previous) {
  if (
    model.provider !== CODEX_PROVIDER ||
    (previous?.provider === CODEX_PROVIDER && previous.connectionRef === model.connectionRef)
  )
    return
  const status = getCodexClient()?.status()
  if (!status || status.state === 'unavailable') throw codexError('CODEX_UNAVAILABLE')
  if (status.state !== 'connected') throw codexError(status.code || 'CODEX_RECONNECT')
  if (status.connectionRef !== model.connectionRef) throw codexError('CODEX_ACCOUNT_MISMATCH')
}

function subscriptionRouteError(res, error) {
  const issue = codexError(String(error?.code || 'CODEX_INVALID_RESPONSE'))
  return res.status(400).json({ error: issue.message, code: issue.code })
}

function subscriptionCatalogOnly(res) {
  return res.status(400).json({ error: '请从 ChatGPT Subscription 的账号连接中选择模型。' })
}

function validationError(res, model) {
  return res.status(400).json({
    error:
      model?.provider === CODEX_PROVIDER
        ? '请填写名称、模型 ID 并绑定一个 ChatGPT 账号。'
        : '名称、地址、模型名不能为空（非本地部署还需 API Key）'
  })
}

/**
 * 所有 models.json 修改统一走这个事务：读→改→保护密钥→写在同一个文件队列里完成。
 * 旧写法是「listModels() → （往往还跨着 20 秒网络探测）→ writeJson」，
 * 期间别的保存/导入落盘的模型会被过期快照整表覆盖（连 API key 一起丢）。
 * fn 收到明文密钥的数组，返回值即新表。
 */
async function mutateModels(fn) {
  return updateJson(
    MODELS_FILE,
    raw => {
      const list = (Array.isArray(raw) ? raw : []).map(normalizeModel)
      const out = fn(list) || list
      return out.map(x => ({ ...x, apiKey: protectApiKey(x.apiKey) }))
    },
    []
  )
}

/** 删除/变更模型后，把引用它的作品回落到默认模型，避免静默降级。
 *  逐本走 withFile 队列：这些重写发生在章节保存 / 任务写库的同一时间，
 *  直接 readJson+writeJson 会把对方事务的在途结果整档盖掉。 */
async function detachNovelsFromModels(idSet) {
  let files = []
  try {
    files = fs.readdirSync(NOVELS_DIR).filter(x => x.endsWith('.json'))
  } catch {
    return
  }
  for (const f of files) {
    const p = path.join(NOVELS_DIR, f)
    try {
      await withFile(p, async () => {
        const n = await readJsonAsync(p, null)
        if (n && idSet.has(n.modelId)) {
          n.modelId = ''
          await writeJsonAsync(p, n)
        }
      })
    } catch {
      /* 单本清理失败不影响其余 */
    }
  }
}

/** 解析书名→模型连接信息（app.mjs 的任务执行器要用） */
export function resolveConn(modelId) {
  const list = listModels()
  const key = String(modelId || '').trim()
  const m =
    list.find(x => x.id === key) ||
    list.find(x => String(x.name || '').trim() === key) ||
    list.find(x => x.isDefault) ||
    list[0]
  return m ? modelConnection(m) : null
}

function modelConnection(m) {
  return {
    id: m.id,
    ...(m.provider === CODEX_PROVIDER && { connectionRef: m.connectionRef }),
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.model,
    temperature: m.temperature,
    provider: m.provider,
    local: !!m.local,
    contextTokens: m.contextTokens || 0,
    thinkingLevel: m.thinkingLevel,
    reasoningEffort: m.reasoningEffort
  }
}

export function registerModelRoutes(app) {
  app.get('/api/models', (_req, res) => {
    res.json(listModels().map(maskModel))
  })

  app.post('/api/models', async (req, res) => {
    const m = normalizeModel({ ...req.body, id: req.body?.id || crypto.randomUUID() })
    if (!validModel(m)) return validationError(res, m)
    try {
      validateModelBinding(m)
    } catch (error) {
      return subscriptionRouteError(res, error)
    }
    let dup = false
    await mutateModels(list => {
      // 同 id 两条会让 PUT 只改第一条、DELETE 删全部、resolveConn 永远命中第一条
      if (list.some(x => x.id === m.id)) {
        dup = true
        return list
      }
      if (m.isDefault) list.forEach(x => (x.isDefault = false))
      return [...list, { ...m, isDefault: !!m.isDefault }]
    })
    if (dup) return res.status(409).json({ error: '已存在相同 id 的模型，请刷新后重试' })
    res.status(201).json(maskModel(m))
  })

  app.put('/api/models/:id', async (req, res) => {
    let status = 200
    let payload = null
    let bindingError = null
    await mutateModels(list => {
      const i = list.findIndex(x => x.id === req.params.id)
      if (i < 0) {
        status = 404
        return
      }
      const incoming = { ...req.body, id: req.params.id }
      if (incoming.provider === CODEX_PROVIDER && incoming.connectionRef === undefined) {
        incoming.connectionRef = list[i].connectionRef
      }
      // 前端拿到的是掩码密钥；未修改时沿用原密钥
      if (!incoming.apiKey || /\*\*\*\*/.test(incoming.apiKey)) incoming.apiKey = list[i].apiKey
      const m = normalizeModel(incoming)
      if (!validModel(m)) {
        status = 400
        payload = m
        return
      }
      try {
        validateModelBinding(m, list[i])
      } catch (error) {
        bindingError = error
        return
      }
      if (m.isDefault)
        list.forEach((x, index) => {
          if (index !== i) x.isDefault = false
        })
      list[i] = { ...m, isDefault: !!m.isDefault }
      payload = maskModel(m)
      return list
    })
    if (status === 404) return res.status(404).json({ error: '模型不存在' })
    if (status === 400) return validationError(res, payload)
    if (bindingError) return subscriptionRouteError(res, bindingError)
    res.json(payload)
  })

  app.delete('/api/models/:id', async (req, res) => {
    await mutateModels(list => list.filter(x => x.id !== req.params.id))
    await detachNovelsFromModels(new Set([req.params.id]))
    res.json({ ok: true })
  })

  // 批量删除模型：body { ids: string[] }，支持全选全删
  app.delete('/api/models', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : []
    if (!ids.length) return res.status(400).json({ error: '请选择要删除的模型' })
    const idSet = new Set(ids)
    await mutateModels(list => list.filter(x => !idSet.has(x.id)))
    await detachNovelsFromModels(idSet)
    res.json({ ok: true, deleted: ids.length })
  })

  // 探测某个地址+密钥可用的模型名（不落盘）
  app.post('/api/models/probe', async (req, res) => {
    if (req.body?.provider === CODEX_PROVIDER) return subscriptionCatalogOnly(res)
    const provider = req.body?.provider === 'gemini' ? 'gemini' : 'openai'
    const baseRaw = String(req.body?.baseUrl || '').trim()
    const baseUrl = provider === 'gemini' ? baseRaw : normalizeOpenAIBase(baseRaw)
    const apiKey = String(req.body?.apiKey || '').trim()
    const local = !!req.body?.local && provider === 'openai'
    if (!baseUrl || (!apiKey && !local)) return res.json({ ok: false, error: '请先填写地址与密钥' })

    // 本地服务：走专用探测（不带鉴权头，Ollama 会退回原生 /api/tags）
    if (local) {
      const r = await probeLocalEndpoint(baseUrl, { timeoutMs: 4000 })
      return res.json({ ok: r.online, models: r.models || [], error: r.error || '', runtime: r.runtime || '' })
    }

    try {
      const headers = provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }
      const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        return res.json({ ok: false, error: `HTTP ${r.status} ${t.slice(0, 160)}`, models: [] })
      }
      const data = await r.json().catch(() => null)
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
      const models = arr
        .map(x => String(x?.id || x?.name || '').replace(/^models\//, ''))
        .filter(Boolean)
        .sort()
      res.json({ ok: true, models })
    } catch (e) {
      res.json({ ok: false, error: String(e.message || e), models: [] })
    }
  })

  // 扫描本机常见推理服务（Ollama / LM Studio / llama.cpp / vLLM …），只返回在线的
  app.post('/api/models/local/scan', async (req, res) => {
    const extra = Array.isArray(req.body?.extra) ? req.body.extra.map(String).slice(0, 8) : []
    try {
      const found = await scanLocalEndpoints({ extra, timeoutMs: 1500 })
      res.json({ ok: true, found })
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) })
    }
  })

  // 把扫描结果里的模型批量加入连接（缺省模型自动设为默认）
  app.post('/api/models/local/add', async (req, res) => {
    if (req.body?.provider === CODEX_PROVIDER) return subscriptionCatalogOnly(res)
    const baseUrl = normalizeOpenAIBase(String(req.body?.baseUrl || '').trim())
    const names = Array.isArray(req.body?.models)
      ? req.body.models
          .map(String)
          .map(s => s.trim())
          .filter(Boolean)
      : []
    const contextTokens = Number(req.body?.contextTokens) || 16384
    if (!baseUrl) return res.status(400).json({ error: '地址不能为空' })
    if (!names.length) return res.status(400).json({ error: '请选择要添加的模型' })
    let added = 0
    let skipped = 0
    await mutateModels(list => {
      const have = new Set(list.filter(m => m.baseUrl === baseUrl).map(m => m.model))
      const hasDefault = list.some(m => m.isDefault)
      const next = [...list]
      for (const model of names) {
        if (have.has(model)) {
          skipped++
          continue
        }
        have.add(model)
        added++
        next.push(
          normalizeModel({
            id: crypto.randomUUID(),
            name: model,
            baseUrl,
            apiKey: '',
            model,
            provider: 'openai',
            local: true,
            contextTokens,
            temperature: 0.8,
            isDefault: !hasDefault && added === 1,
            reasoningEffort: 'default'
          })
        )
      }
      return next
    })
    res.json({ ok: true, added, skipped })
  })

  // 给中转站起名 / 清空名字（清空后前端回落显示域名）
  app.post('/api/models/stations/name', (req, res) => {
    if (req.body?.provider === CODEX_PROVIDER) return subscriptionCatalogOnly(res)
    const provider = req.body?.provider === 'gemini' ? 'gemini' : 'openai'
    const baseUrl = String(req.body?.baseUrl || '')
      .trim()
      .replace(/\/+$/, '')
    const name = String(req.body?.name || '')
      .trim()
      .slice(0, 40)
    if (!baseUrl) return res.status(400).json({ error: '地址不合法' })
    const names = readStationNames()
    const key = `${provider}||${baseUrl}`
    if (name) names[key] = name
    else delete names[key]
    writeJson(STATION_NAMES_FILE, names)
    res.json({ ok: true, name, stationName: name })
  })

  app.post('/api/models/import', async (req, res) => {
    if (req.body?.provider === CODEX_PROVIDER) return subscriptionCatalogOnly(res)
    const provider = req.body?.provider === 'gemini' ? 'gemini' : 'openai'
    const rawBaseUrl = String(req.body?.baseUrl || '').trim()
    const baseUrl = provider === 'gemini' ? rawBaseUrl.replace(/\/+$/, '') : normalizeOpenAIBase(rawBaseUrl)
    const apiKey = String(req.body?.apiKey || '').trim()
    if (!baseUrl || !apiKey) return res.status(400).json({ error: '地址与密钥不能为空' })
    try {
      const headers = provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }
      const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(20000) })
      if (!r.ok) return res.status(400).json({ error: `拉取模型列表失败：HTTP ${r.status}` })
      const data = await r.json().catch(() => null)
      const remote = (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [])
        .map(x =>
          String(x?.id || x?.name || '')
            .replace(/^models\//, '')
            .trim()
        )
        .filter(Boolean)
      let addedCount = 0
      let skippedCount = 0
      await mutateModels(list => {
        const have = new Set(list.filter(mm => mm.provider === provider && mm.baseUrl === baseUrl).map(mm => mm.model))
        const added = []
        let skipped = 0
        for (const model of remote) {
          if (have.has(model)) {
            skipped++
            continue
          }
          have.add(model)
          added.push(
            normalizeModel({
              id: crypto.randomUUID(),
              name: model,
              baseUrl,
              apiKey,
              model,
              provider,
              temperature: 0.8,
              thinkingLevel: 'MEDIUM',
              reasoningEffort: 'default',
              isDefault: false
            })
          )
        }
        addedCount = added.length
        skippedCount = skipped
        return added.length ? [...list, ...added] : list
      })
      res.json({ ok: true, added: addedCount, skipped: skippedCount })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // 一键导入「此站新模型」：复用该站已有密钥，只补齐未收录的模型名，重复跳过
  app.post('/api/models/import-group', async (req, res) => {
    if (req.body?.provider === CODEX_PROVIDER) return subscriptionCatalogOnly(res)
    const baseUrl = String(req.body?.baseUrl || '')
      .trim()
      .replace(/\/+$/, '')
    if (!baseUrl) return res.status(400).json({ error: '地址不合法' })
    const list = listModels()
    const siblings = list.filter(
      m => m.provider !== CODEX_PROVIDER && (m.baseUrl || '').replace(/\/+$/, '') === baseUrl
    )
    if (!siblings.length) return res.status(400).json({ error: '这个地址还没有模型，请先手动添加一个' })
    const tpl = siblings[0] // 复用同站第一个模型的密钥与 provider
    try {
      // 本地站点没有密钥：直接按本地协议探测（Ollama 还会退回 /api/tags）
      const headers =
        tpl.local || !tpl.apiKey
          ? {}
          : tpl.provider === 'gemini'
            ? { 'x-goog-api-key': tpl.apiKey }
            : { Authorization: `Bearer ${tpl.apiKey}` }
      const r = await fetch(`${tpl.baseUrl}/models`, { headers, signal: AbortSignal.timeout(20000) })
      let remote = []
      if (r.ok) {
        const data = await r.json().catch(() => null)
        const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
        remote = arr.map(x => String(x?.id || x?.name || '').replace(/^models\//, '')).filter(Boolean)
      } else if (tpl.local) {
        // 本地服务有时不实现 /v1/models（或走原生协议）：退回本地探测
        const probe = await probeLocalEndpoint(tpl.baseUrl, { timeoutMs: 4000 })
        if (!probe.online) return res.status(400).json({ error: probe.error || `拉取模型列表失败：HTTP ${r.status}` })
        remote = probe.models
      } else {
        return res.status(400).json({ error: `拉取模型列表失败：HTTP ${r.status}` })
      }
      // 去重与合并必须在写锁内基于**最新**列表计算：20 秒探测期间新增的模型
      // 若按探测前的旧列表写回会被整表抹掉
      let addedCount = 0
      let skippedCount = 0
      await mutateModels(live => {
        const have = new Set(live.filter(mm => (mm.baseUrl || '').replace(/\/+$/, '') === baseUrl).map(mm => mm.model))
        const added = []
        let skipped = 0
        for (const model of remote) {
          if (have.has(model)) {
            skipped++
            continue
          }
          have.add(model)
          added.push(normalizeModel({ ...tpl, id: crypto.randomUUID(), name: model, model, isDefault: false }))
        }
        addedCount = added.length
        skippedCount = skipped
        return added.length ? [...live, ...added] : live
      })
      res.json({ ok: true, added: addedCount, skipped: skippedCount })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // 用指定配置试一次最小请求，验证密钥可用。
  // 必须按 id 精确查找：resolveConn 有「默认→列表第一个」的兜底链路，
  // 拿它测试不存在的 id 会拿别的模型发真实请求并返回 ok，误导用户以为被测配置可用。
  app.post('/api/models/:id/test', async (req, res) => {
    const m = listModels().find(x => x.id === req.params.id)
    if (!m) return res.status(404).json({ error: '模型不存在' })
    const conn = modelConnection(m)
    try {
      const out = conn.provider === CODEX_PROVIDER ? await probeSubscription(conn) : await probeChat(conn)
      res.json({ ok: true, reply: out })
    } catch (e) {
      if (conn.provider === CODEX_PROVIDER) return subscriptionRouteError(res, e)
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // 拉取该配置下可用的模型列表（用于「从站点导入」）
  app.post('/api/models/:id/list', async (req, res) => {
    const list = listModels()
    const m = list.find(x => x.id === req.params.id)
    if (!m) return res.status(404).json({ error: '模型不存在' })
    if (m.provider === CODEX_PROVIDER) return subscriptionCatalogOnly(res)
    try {
      const headers = m.provider === 'gemini' ? { 'x-goog-api-key': m.apiKey } : { Authorization: `Bearer ${m.apiKey}` }
      const r = await fetch(`${m.baseUrl}/models`, { headers, signal: AbortSignal.timeout(20000) })
      if (!r.ok) return res.status(400).json({ error: `HTTP ${r.status}` })
      const data = await r.json().catch(() => null)
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
      res.json({
        models: arr
          .map(x => String(x?.id || x?.name || '').replace(/^models\//, ''))
          .filter(Boolean)
          .sort()
      })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })
}

async function probeSubscription(conn) {
  let reply = ''
  const messages = [
    { role: 'system', content: '这是一条连接测试，回答一个短句。' },
    { role: 'user', content: '请回复你好。' }
  ]
  try {
    for await (const event of streamChat(conn, { messages, signal: AbortSignal.timeout(60_000) })) {
      if (event.type === 'content') reply = (reply + event.text).slice(0, 80)
    }
  } catch (error) {
    if (error.name === 'TimeoutError') throw codexError('CODEX_NETWORK')
    throw error
  }
  if (!reply.trim()) throw codexError('CODEX_INVALID_RESPONSE')
  return reply
}

/** 发一次极小的对话请求，验证密钥/地址可用 */
async function probeChat(conn) {
  const base = String(conn.baseUrl || '').replace(/\/+$/, '')
  if (conn.provider === 'gemini') {
    const r = await fetch(`${base}/models/${encodeURIComponent(conn.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': conn.apiKey },
      body: JSON.stringify({ contents: [{ role: 'USER', parts: [{ text: '你好' }] }] }),
      signal: AbortSignal.timeout(25000)
    })
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`)
    const j = await r.json().catch(() => null)
    return String(j?.candidates?.[0]?.content?.parts?.[0]?.text || '').slice(0, 80)
  }
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
    body: JSON.stringify({ model: conn.model, messages: [{ role: 'user', content: '你好' }], max_tokens: 16 }),
    signal: AbortSignal.timeout(25000)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`)
  const j = await r.json().catch(() => null)
  return String(j?.choices?.[0]?.message?.content || '').slice(0, 80)
}

// ---------- 风格与模板（含作者自建） ----------
// 作者自建库与内置库同 id 时，作者自建的优先（允许覆盖内置文风而不改代码）
export const customStyles = makeCustomStore({
  fs,
  dir: DATA_DIR,
  file: STYLES_FILE,
  required: ['id', 'name', 'desc', 'prompt']
})
export const customTemplates = makeCustomStore({
  fs,
  dir: DATA_DIR,
  file: TEMPLATES_FILE,
  required: ['id', 'name', 'desc', 'rules']
})

export function resolveStyle(id) {
  return customStyles.list().find(s => s.id === id) || AUTHOR_STYLES.find(s => s.id === id) || null
}

export function resolveTemplate(id) {
  return customTemplates.list().find(t => t.id === id) || PROMPT_TEMPLATES.find(t => t.id === id) || null
}

export function registerPresetRoutes(app) {
  app.get('/api/presets', (_req, res) => {
    res.json({
      styles: [...AUTHOR_STYLES, ...customStyles.list()],
      templates: [...PROMPT_TEMPLATES, ...customTemplates.list()],
      skills: allSkills(),
      genres: STYLE_GENRES,
      genreMap: GENRE_AUTHOR_MAP
    })
  })

  // 按题材+标题+简介推荐文风（无状态：接受未保存的草稿字段，前端实时调用）
  app.post('/api/recommend-style', (req, res) => {
    const { genre, title, synopsis, style } = req.body || {}
    const all = [...AUTHOR_STYLES, ...customStyles.list()]
    res.json(recommendStyles({ genre, title, synopsis, style }, all))
  })

  app.post('/api/presets/styles', (req, res) => {
    const item = { ...req.body, id: req.body?.id || `custom_${crypto.randomUUID().slice(0, 8)}` }
    if (!customStyles.valid(item)) return res.status(400).json({ error: '名称与提示词内容不能为空' })
    res.status(201).json(customStyles.save(item))
  })

  app.put('/api/presets/styles/:id', (req, res) => {
    const item = { ...req.body, id: req.params.id }
    if (!customStyles.valid(item)) return res.status(400).json({ error: '名称与提示词内容不能为空' })
    res.json(customStyles.save(item))
  })

  app.delete('/api/presets/styles/:id', (req, res) => {
    customStyles.remove(req.params.id)
    res.json({ ok: true })
  })

  app.post('/api/presets/templates', (req, res) => {
    const body = { ...req.body }
    if (typeof body.rules === 'string')
      body.rules = body.rules
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    const item = { ...body, id: body.id || `custom_${crypto.randomUUID().slice(0, 8)}` }
    if (!customTemplates.valid(item)) return res.status(400).json({ error: '名称与规则不能为空' })
    res.status(201).json(customTemplates.save(item))
  })

  app.put('/api/presets/templates/:id', (req, res) => {
    const body = { ...req.body }
    if (typeof body.rules === 'string')
      body.rules = body.rules
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    const item = { ...body, id: req.params.id }
    if (!customTemplates.valid(item)) return res.status(400).json({ error: '名称与规则不能为空' })
    res.json(customTemplates.save(item))
  })

  app.delete('/api/presets/templates/:id', (req, res) => {
    customTemplates.remove(req.params.id)
    res.json({ ok: true })
  })
}

// ---------- 写作技能（Markdown 文件，存于 data/skills/，像 opencode 的 skill 一样） ----------
const SKILLS_DIR = path.join(DATA_DIR, 'skills')

/** 解析技能 Markdown：YAML frontmatter（name/description/tags/id/version…）+ 正文为技能指令 */
export function parseSkillMd(text) {
  const t = String(text || '')
  const m = t.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/)
  if (!m)
    return {
      id: '',
      name: '',
      description: '',
      tags: [],
      content: t.trim(),
      version: '',
      sourceRepo: '',
      sourceLicense: ''
    }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const raw = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (key === 'tags')
      meta.tags = raw
        .replace(/^\[|\]$/g, '')
        .split(/[,\s、]+/)
        .map(s => s.trim())
        .filter(Boolean)
    else meta[key] = raw
  }
  return {
    id: meta.id || '',
    name: meta.name || '',
    description: meta.description || '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    content: m[2].trim(),
    version: meta.version || '',
    sourceRepo: meta.sourceRepo || '',
    sourceLicense: meta.sourceLicense || ''
  }
}

/** 扫描目录下的 .md 技能文件（id 优先取 frontmatter 的 id，回退文件名） */
export function listMarkdownSkills(dir, builtIn) {
  try {
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .map(f => {
        const fileId = f.slice(0, -3)
        if (!ID_RE.test(fileId)) return null
        const parsed = parseSkillMd(fs.readFileSync(path.join(dir, f), 'utf8'))
        const id = parsed.id && ID_RE.test(parsed.id) ? parsed.id : fileId
        if (!parsed.name || !parsed.content) return null
        return {
          id,
          name: parsed.name,
          description: parsed.description || '',
          tags: parsed.tags || [],
          content: parsed.content,
          version: parsed.version || '',
          sourceRepo: parsed.sourceRepo || '',
          sourceLicense: parsed.sourceLicense || '',
          builtIn
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  } catch {
    return []
  }
}

/** 随应用打包发布的技能（server/skills/*.md），视为内置 */
export function listPackagedSkills() {
  return listMarkdownSkills(PACKAGED_SKILLS_DIR, true)
}

/** 作者自建技能（data/skills/ 下的 .md） */
export function listCustomSkills() {
  return listMarkdownSkills(SKILLS_DIR, false)
}

/**
 * 全部技能：打包 Markdown 优先 → 旧 JS 内置技能兜底 → 作者自建。
 * 按 id 去重，先出现的胜出（这样 server/skills/*.md 可覆盖同 id 的 JS 内置）。
 *
 * 缓存 3 秒 + 目录 mtime：每次对话都会读技能清单，但技能文件几乎不变；
 * 目录 mtime 变化（新建/删除/导入）会立即失效，编辑已有文件最多延迟 3 秒。
 */
let allSkillsCache = { key: '', at: 0, list: [] }
function dirMtime(dir) {
  try {
    return String(fs.statSync(dir).mtimeMs)
  } catch {
    return '0'
  }
}
export function allSkills() {
  const key = `${dirMtime(PACKAGED_SKILLS_DIR)}|${dirMtime(SKILLS_DIR)}`
  if (allSkillsCache.key === key && Date.now() - allSkillsCache.at < 3000) return allSkillsCache.list
  const out = []
  const seen = new Set()
  for (const s of [
    ...listPackagedSkills(),
    ...BUILTIN_SKILLS.map(s => ({ ...s, builtIn: true })),
    ...listCustomSkills()
  ]) {
    if (!s?.id || seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  allSkillsCache = { key, at: Date.now(), list: out }
  return out
}

export function resolveSkill(id) {
  return allSkills().find(s => s.id === id) || null
}

/** 技能 Markdown 序列化：frontmatter + 正文 */
export function skillToMd(s) {
  const tags = Array.isArray(s.tags) && s.tags.length ? `tags: ${s.tags.join(', ')}\n` : ''
  return `---\nname: ${s.name}\ndescription: ${s.description || ''}\n${tags}---\n\n${s.content}`
}

/** 技能文件路径（data/skills/<id>.md） */
export function customSkillFile(id) {
  if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('技能 ID 不合法'), { status: 400 })
  return path.join(SKILLS_DIR, `${id}.md`)
}

/** 保存/覆盖一个作者自建技能，返回归一化后的对象 */
export function saveCustomSkill(item) {
  if (!String(item.name || '').trim()) throw Object.assign(new Error('技能名称不能为空'), { status: 400 })
  if (!String(item.content || '').trim()) throw Object.assign(new Error('技能内容不能为空'), { status: 400 })
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
  const id = item.id || `custom_${crypto.randomUUID().slice(0, 8)}`
  const normalized = {
    id,
    name: String(item.name).trim(),
    description: String(item.description || '').trim(),
    tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
    content: String(item.content).trim()
  }
  fs.writeFileSync(customSkillFile(id), skillToMd(normalized), 'utf8')
  return { ...normalized, builtIn: false }
}

export function registerSkillRoutes(app) {
  app.get('/api/skills', (_req, res) => {
    res.json(allSkills())
  })

  app.post('/api/skills', (req, res) => {
    try {
      res.status(201).json(saveCustomSkill(req.body))
    } catch (e) {
      res.status(e.status || 400).json({ error: String(e.message || e) })
    }
  })

  app.put('/api/skills/:id', (req, res) => {
    try {
      if (!fs.existsSync(customSkillFile(req.params.id))) return res.status(404).json({ error: '技能不存在' })
      res.json(saveCustomSkill({ ...req.body, id: req.params.id }))
    } catch (e) {
      res.status(e.status || 400).json({ error: String(e.message || e) })
    }
  })

  app.delete('/api/skills/:id', (req, res) => {
    try {
      if (fs.existsSync(customSkillFile(req.params.id))) fs.unlinkSync(customSkillFile(req.params.id))
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // 批量导入技能 Markdown：body { items: [{ name?, text }] }
  // 同名技能视为重复：跳过并计入 skipped，避免同一份 .md 反复导入产生多份副本
  app.post('/api/skills/import', (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!items.length) return res.status(400).json({ error: '没有可导入的内容' })
    const saved = []
    const failed = []
    const skipped = []
    const seen = new Set()
    for (const it of items) {
      const raw = String(it?.text || '')
      if (!raw.trim()) continue
      const parsed = parseSkillMd(raw)
      const fallbackName = String(it?.name || '')
        .replace(/\.md$/i, '')
        .trim()
      const name = parsed.name || fallbackName
      if (!name || !parsed.content.trim()) {
        failed.push(fallbackName || name || '未命名')
        continue
      }
      if (seen.has(name) || resolveSkill(`custom_${name}`) || allSkills().some(s => s.name === name)) {
        skipped.push(name)
        continue
      }
      seen.add(name)
      try {
        saved.push(
          saveCustomSkill({ name, description: parsed.description, tags: parsed.tags, content: parsed.content })
        )
      } catch {
        failed.push(fallbackName || name)
      }
    }
    if (!saved.length) {
      if (skipped.length && !failed.length)
        return res.status(409).json({ error: `全部为重复技能（${skipped.join('、')}），未导入任何新内容` })
      return res
        .status(422)
        .json({ error: `未能导入任何技能${failed.length ? `（${failed.join('、')} 缺少名称或内容）` : ''}` })
    }
    res.json({ ok: true, saved, failed, skipped })
  })
}

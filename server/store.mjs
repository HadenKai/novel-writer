// 存储层：JSON 持久化（写串行化 + 读缓存）、路径解析、版本快照、对话存储。
//
// 从 app.mjs 拆出的原因：这些是**基础设施**，被 novels / jobs / chat / recycle 等
// 所有领域模块共用，而 app.mjs 里的路由是**领域逻辑**。两者混在一个 4200 行的文件里，
// 改一处路由要在一整屏无关代码里找位置。拆开后本文件只关心「数据怎么安全落盘」。
//
// 关键设计（都是有具体 bug 背景的，改动前请读注释）：
//  1. 写串行化 withFile —— 消除「读-改-写」并发覆盖（见 readJson/writeJson 注释）
//  2. 内容寻址的版本快照 —— 避免 30 × 80 万字的 history.json（见 pushHistory 注释）
//  3. readJson 的 .bak 回退 —— 因此「清空」必须覆写而非 unlink
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { countTextUnits } from './ai.mjs'

// ---------- 数据目录 ----------
// 桌面版由 Electron 指向用户数据目录；独立运行时用项目内 data/
// 注意：基准必须是「本文件所在目录的上一级」（即 server/.. = 项目根），
// 不能依赖 process.cwd()——从别处（打包后的 asar、快捷方式）启动时 cwd 会变。
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
export let DATA_DIR = process.env.NOVEL_DATA_DIR || path.join(ROOT, 'data')
/** 非空 = 原目录不可写、已静默搬迁过的证据（用户视角「书架全空」多半是这个） */
export let DATA_DIR_RELOCATED = ''
try {
  fs.mkdirSync(path.join(DATA_DIR, 'novels'), { recursive: true })
} catch {
  // 目录不可写（如被打进 asar 归档）时回退到用户主目录，避免崩溃
  const orig = DATA_DIR
  DATA_DIR = path.join(os.homedir(), '.novel-writer-data')
  fs.mkdirSync(path.join(DATA_DIR, 'novels'), { recursive: true })
  DATA_DIR_RELOCATED = orig
  console.error(`[novel-writer] 数据目录 ${orig} 不可写，已回退到 ${DATA_DIR}`)
}

export const NOVELS_DIR = path.join(DATA_DIR, 'novels')
export const HISTORY_DIR = path.join(DATA_DIR, 'history')
export const CHATS_DIR = path.join(DATA_DIR, 'chats')
export const RECYCLE_DIR = path.join(DATA_DIR, 'recycle')
export const BACKUP_DIR = path.join(DATA_DIR, 'backups')
export const LOGS_DIR = path.join(DATA_DIR, 'logs')
/** 作品封面图（用户上传的原图，按 `<作品id>.<ext>` 命名） */
export const COVERS_DIR = path.join(DATA_DIR, 'covers')
/** 管家对话附件（作者随消息发的图片，按随机 id 命名） */
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments')
/** 人物照片（作者给角色上传的图，按随机 id 命名；作品 JSON 的 character.portrait 只存文件名） */
export const PORTRAITS_DIR = path.join(DATA_DIR, 'portraits')
/** 参考作品拆书报告（<作品id>/拆书报告-<时间>.md） */
export const REFBOOKS_DIR = path.join(DATA_DIR, 'refbooks')
export const SHELF_FILE = path.join(DATA_DIR, 'shelf.json')
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
export const MODELS_FILE = path.join(DATA_DIR, 'models.json')
export const STATION_NAMES_FILE = path.join(DATA_DIR, 'station_names.json')
export const STYLES_FILE = path.join(DATA_DIR, 'custom_styles.json')
export const TEMPLATES_FILE = path.join(DATA_DIR, 'custom_templates.json')
/** 每日码字统计（'YYYY-MM-DD' → { novelId: 净增字数 }） */
export const STATS_FILE = path.join(DATA_DIR, 'daily_stats.json')

for (const d of [
  HISTORY_DIR,
  CHATS_DIR,
  RECYCLE_DIR,
  LOGS_DIR,
  COVERS_DIR,
  ATTACHMENTS_DIR,
  PORTRAITS_DIR,
  REFBOOKS_DIR
]) {
  try {
    fs.mkdirSync(d, { recursive: true })
  } catch {
    /* 只读介质上不阻断启动 */
  }
}

/**
 * 追加一行诊断日志到 <data>/logs/app.log。
 *
 * 为什么必须有：AI 调用失败原先只写进内存里的 job.error，任务清理后线索就没了，
 * 界面只显示一句「AI 接口错误」，既无法自查也无法远程排查。日志是只追加的纯文本，
 * 不参与任何业务读写，失败也绝不影响主流程。
 */
// 诊断日志只追加会无限增长（长期挂机 + 每次 AI 失败都写），这里做体量控制：
// 每追加约 LOG_ROTATE_CHECK 字节检查一次，超过 LOG_MAX_BYTES 就截断只保留尾部。
const LOG_MAX_BYTES = 4 * 1024 * 1024
let logBytesSinceCheck = 0
export function appendLog(tag, msg) {
  try {
    const line = `${new Date().toISOString()} [${tag}] ${msg}\n`
    const file = path.join(LOGS_DIR, 'app.log')
    fs.appendFileSync(file, line, 'utf8')
    logBytesSinceCheck += Buffer.byteLength(line)
    if (logBytesSinceCheck >= 256 * 1024) {
      logBytesSinceCheck = 0
      const size = fs.statSync(file).size
      if (size > LOG_MAX_BYTES) {
        const buf = fs.readFileSync(file)
        fs.writeFileSync(file, buf.subarray(size - LOG_MAX_BYTES / 2), 'utf8')
      }
    }
  } catch {
    /* 日志失败不影响业务 */
  }
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// ---------- JSON 持久化：写串行化 + 读缓存 ----------
//
// 背景（原实现的真 BUG）：
//  1. 并发写竞争 —— 同一份 JSON 可能被多个请求/任务同时 read-modify-write。
//     例如「管家动作落库」与「章节生成任务完成」同时改同一本书：两边都先读到旧内容，
//     各自改完再写回，后写的那份会静默覆盖前一份的改动（丢章、丢设定）。
//  2. 同步 IO —— readFileSync/writeFileSync 跑在请求热路径上，一本大书的
//     novel.json + history.json 序列化会阻塞事件循环，界面随之卡顿。
//
// 方案：
//  - 每个文件一条「写队列」：同一文件的 read-modify-write 事务按到达顺序串行执行，
//    彻底消除丢更新（lost update）。
//  - 写盘走「临时文件 → 原子 rename」，并让读缓存失效；旧版 content 先写 .bak。
//  - 读走 mtime + size 指纹缓存：文件未被外部改动时不重复解析大 JSON。
//  - 对外保持**同步签名**（readJson/writeJson 仍可直接调用），因此无需改动 30+ 个调用点；
//    真正的异步化通过 withFile() 事务接口暴露给新增代码。
const jsonReadCache = new Map() // file -> { mtimeMs, size, value }
const fileWriteChain = new Map() // file -> Promise（串行尾指针）

// 缓存上限 + LRU：长期挂机时逐本翻完整个书柜，解析过的大对象会全量驻留内存
const JSON_CACHE_MAX = 120
function cacheGet(file) {
  const hit = jsonReadCache.get(file)
  if (hit) {
    jsonReadCache.delete(file)
    jsonReadCache.set(file, hit)
  }
  return hit
}
function cacheSet(file, entry) {
  jsonReadCache.delete(file)
  jsonReadCache.set(file, entry)
  while (jsonReadCache.size > JSON_CACHE_MAX) {
    const oldest = jsonReadCache.keys().next()
    if (oldest.done) break
    jsonReadCache.delete(oldest.value)
  }
}

/** 仅供离线回归测试观察队列是否在事务完成后回收。 */
export function invalidateJsonCache() {
  jsonReadCache.clear()
}

export function pendingFileWriteCount() {
  return fileWriteChain.size
}

function statFingerprint(file) {
  try {
    const st = fs.statSync(file)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

function parseJsonFile(file, fallback) {
  const fp = statFingerprint(file)
  if (!fp) return fallback
  const cached = cacheGet(file)
  if (cached && cached.mtimeMs === fp.mtimeMs && cached.size === fp.size) return cached.value
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // 主文件损坏/截断时尝试读取上一次的备份
    try {
      value = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'))
    } catch {
      return fallback
    }
  }
  cacheSet(file, { mtimeMs: fp.mtimeMs, size: fp.size, value })
  return value
}

export function readJson(file, fallback) {
  return parseJsonFile(file, fallback)
}

/**
 * 把 file 的读写包成串行事务：同一文件的 fn 按调用顺序依次执行，
 * 保证「读到的一定是上一个事务写完的」。fn 可以 async。
 * 注意：fn 内部请用 readJson/readJsonAsync/writeJsonAsync 直接操作该文件。
 */
export function withFile(file, fn) {
  const prev = fileWriteChain.get(file) || Promise.resolve()
  const next = prev.then(fn, fn)
  // 队列尾只用来串行化，不把失败传播给后续事务。
  // 保存尾 Promise 本身，清理时必须比较同一个对象；否则每个文件的条目都会泄漏。
  const tail = next.then(
    () => {},
    () => {}
  )
  fileWriteChain.set(file, tail)
  // 队列自然清空后回收，避免 Map 无限增长；若期间有新事务，则保留新尾部。
  tail
    .finally(() => {
      if (fileWriteChain.get(file) === tail) fileWriteChain.delete(file)
    })
    .catch(() => {})
  return next
}

// 同步原子写：临时文件 → fsync → 备份旧版 → rename
export function writeJsonSync(file, data) {
  // tmp 名带 pid+时间戳：事务外并发写同一文件时不会互踩同一个 .tmp
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const text = JSON.stringify(data, null, 2)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
  } catch {
    /* 备份失败不阻塞写入 */
  }
  fs.renameSync(tmp, file)
  // 写入后指纹必然变化，主动失效缓存（省一次 stat，也避免同 mtime 的边界情况）
  jsonReadCache.delete(file)
}

// 兼容旧签名的原子写（同步语义，立即落盘）
export function writeJson(file, data) {
  writeJsonSync(file, data)
}

/** 异步原子写：不阻塞事件循环，供 withFile 事务与新代码使用 */
export async function writeJsonAsync(file, data) {
  // tmp 名带 pid+时间戳：与 writeJsonSync 同样的防互踩——万一有调用绕过写队列，
  // 也不会把别的并发写入正写到一半的 ${file}.tmp 截走（固定的 tmp 名是潜伏竞态）
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const text = JSON.stringify(data, null, 2)
  const fh = await fs.promises.open(tmp, 'w')
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fs.promises.copyFile(file, file + '.bak')
  } catch {
    /* 备份失败不阻塞写入（首次写入没有旧文件） */
  }
  await fs.promises.rename(tmp, file)
  jsonReadCache.delete(file)
}

/** 异步读（同样走指纹缓存） */
export async function readJsonAsync(file, fallback) {
  const fp = await fs.promises.stat(file).catch(() => null)
  if (!fp) return fallback
  const cached = cacheGet(file)
  if (cached && cached.mtimeMs === fp.mtimeMs && cached.size === fp.size) return cached.value
  let value
  try {
    value = JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch {
    try {
      value = JSON.parse(await fs.promises.readFile(file + '.bak', 'utf8'))
    } catch {
      return fallback
    }
  }
  cacheSet(file, { mtimeMs: fp.mtimeMs, size: fp.size, value })
  return value
}

/**
 * 原子「读-改-写」：在写队列内读取 → 交给 mutate 修改 → 异步落盘。
 * 这是消除并发写竞争的推荐入口，返回 mutate 的返回值（若 mutate 返回 undefined 则返回更新后的数据）。
 */
export async function updateJson(file, mutate, fallback = null) {
  return withFile(file, async () => {
    const current = await readJsonAsync(file, fallback)
    const next = await mutate(current)
    // null 是「放弃本次修改」的约定（如目标文件已不存在），不能把字面量 null 写进盘
    if (next === null) return null
    const data = next === undefined ? current : next
    await writeJsonAsync(file, data)
    return data
  })
}

/** 清空文件：覆写为空结构并清掉残留 .bak（不能只 unlink，否则 readJson 会从 .bak 复活旧数据） */
export async function clearJsonFile(file, emptyValue) {
  await writeJsonAsync(file, emptyValue)
  try {
    const bak = file + '.bak'
    if (fs.existsSync(bak)) fs.unlinkSync(bak)
  } catch {
    /* 备份清理失败不影响清空结果 */
  }
}

// ---------- 单本小说的目录解析 ----------
// 所有持久化文件（小说主文件、版本历史、对话记录）统一放在 NOVELS_DIR 下。
//
// 历史：旧数据里残留过 libraryDir 字段，早期这里会「目录存在且放着该书文件就沿用」，
// 试图兼容老用户搬家数据。但它造成了**读写分叉**：getNovel/updateNovel/historyFile 传
// id 字符串一律落在 NOVELS_DIR，而 saveNovel 传 novel 对象会落进 legacy 目录——
// 写进去的副本没有任何读取路径会再碰到（恢复/导入表现为「无效」）。旧数据里
// 只有 legacy 目录有文件的书，本就因 getNovel 只读 NOVELS_DIR 而不可见，该分支
// 帮不了任何人，只会吞写盘。故统一固定为 NOVELS_DIR。
export function novelDir(_novel) {
  return NOVELS_DIR
}

export function novelFile(novelOrId) {
  const id = typeof novelOrId === 'string' ? novelOrId : novelOrId?.id
  if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('作品 ID 不合法'), { status: 400 })
  const dir = typeof novelOrId === 'string' ? NOVELS_DIR : novelDir(novelOrId)
  return path.join(dir, `${id}.json`)
}

export function historyFile(novelOrId) {
  const id = typeof novelOrId === 'string' ? novelOrId : novelOrId?.id
  if (!ID_RE.test(String(id || ''))) throw new Error('作品 ID 不合法')
  const dir = typeof novelOrId === 'string' ? HISTORY_DIR : novelDir(novelOrId)
  return path.join(dir, `${id}.json`)
}

export function chatFile(novelOrId) {
  const id = typeof novelOrId === 'string' ? novelOrId : novelOrId?.id
  if (!ID_RE.test(String(id || ''))) throw new Error('作品 ID 不合法')
  const dir = typeof novelOrId === 'string' ? CHATS_DIR : novelDir(novelOrId)
  return path.join(dir, `${id}.json`)
}

export function recycleDir(id) {
  if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('作品 ID 不合法'), { status: 400 })
  return path.join(RECYCLE_DIR, String(id))
}

export function skillFile(id) {
  if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('技能 ID 不合法'), { status: 400 })
  return path.join(SKILLS_DIR, `${id}.md`)
}

export const SKILLS_DIR = path.join(DATA_DIR, 'skills')

export const HISTORY_LIMIT = 20
export const CHAT_SESSION_LIMIT = 60 // 每本书最多保留的会话数
export const CHAT_MSG_LIMIT = 400 // 单个会话最多保留的消息条数

// ---------- 版本快照的正文存储：按内容去重的内容寻址块 ----------
// 早期实现把 masterOutline + outline + 全部 chapters（含正文）整份深拷进每一份快照，
// 一本 80 万字的书会写出「30 × 80 万字 ≈ 60MB」的 history.json，且每次 push 都是
// 全量序列化 + 同步写盘（阻塞事件循环）。
//
// 这里改为两级结构：
//   history/<bookId>.json        —— 快照只存结构 + { title, words, ref: hash }
//   history/<bookId>.blobs/      —— 正文按内容哈希去重，只在内容变化时新增
// 同一章连续多次快照只占一份正文；回滚时按 ref 取回。旧格式快照（chapters 内嵌 content）
// 仍然可读，回滚逻辑对两种格式都兼容。
//
// 注意：正文块目录必须与快照 JSON 始终相邻（都用 id 走 HISTORY_DIR）。
// 若改用 novelDir(novel) 解析，会被 libraryDir 旧数据拆到别的目录，导致回滚读不到正文。
export function historyBlobDir(novelOrId) {
  const id = typeof novelOrId === 'string' ? novelOrId : novelOrId?.id
  if (!ID_RE.test(String(id || ''))) throw new Error('作品 ID 不合法')
  return path.join(HISTORY_DIR, `${id}.blobs`)
}

function blobPath(dir, hash) {
  return path.join(dir, `${hash}.txt`)
}

/** 写入正文块；内容相同则复用已有文件（去重），失败时返回 null（调用方退化为内嵌存储） */
export function putBlob(dir, text) {
  try {
    const body = String(text ?? '')
    if (!body) return ''
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)
    const p = blobPath(dir, hash)
    if (!fs.existsSync(p)) {
      fs.mkdirSync(dir, { recursive: true })
      // 正文块不需要 .bak（内容寻址天然幂等，写一半的残留不会匹配任何 ref）
      fs.writeFileSync(p, body, 'utf8')
    }
    return hash
  } catch {
    return null
  }
}

export function readBlob(dir, hash) {
  try {
    return fs.readFileSync(blobPath(dir, hash), 'utf8')
  } catch {
    return ''
  }
}

/** 删除所有快照都不再引用的正文块（快照裁剪后调用） */
export function gcBlobs(dir, snapshots) {
  try {
    if (!fs.existsSync(dir)) return
    const live = new Set()
    for (const h of snapshots) {
      for (const c of h.snapshot?.chapters || []) {
        if (c && typeof c.ref === 'string' && c.ref) live.add(c.ref)
      }
    }
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.txt')) continue
      const hash = f.slice(0, -4)
      if (!live.has(hash)) {
        try {
          fs.unlinkSync(path.join(dir, f))
        } catch {
          /* 占用/权限失败均可忽略 */
        }
      }
    }
  } catch {
    /* 回收失败不影响主流程 */
  }
}

/**
 * 覆盖类操作前自动快照。
 * 正文走内容寻址（putBlob），标题/字数/状态等结构信息很小，直接内嵌。
 * ref === null 表示 blob 写入失败，此时退化为内嵌 content，保证快照仍可回滚。
 *
 * context 刻意不入快照：它的 summary / endingHook 会摘抄正文约 500 字，
 * 存进快照等于把正文又抄了一遍，正好抵消掉 blob 去重的收益。context 是
 * 「由正文派生」的连续性快照，回滚后由 buildChapterContext 重新生成即可，
 * 不需要版本化（作者手改后 manualEdits 计数也随 context 重建）。
 */
export function pushHistory(novel, label) {
  try {
    // 统一用 id 解析路径：historyFile / historyBlobDir 在传 id 字符串时都落在 HISTORY_DIR，
    // 保证快照 JSON 与正文块目录始终相邻。传 novel 对象会被 novelDir() 拆到小说目录去。
    const id = novel?.id
    if (!id) return
    const file = historyFile(id)
    const list = readJson(file, [])
    const blobDir = historyBlobDir(id)

    const chapters = (novel.chapters || []).map(c => {
      const ref = putBlob(blobDir, c.content)
      const meta = {
        index: c.index,
        oid: c.oid,
        title: c.title,
        words: c.words,
        status: c.status
      }
      return ref === null ? { ...meta, content: c.content || '' } : { ...meta, ref }
    })

    const snapshot = {
      masterOutline: novel.masterOutline || '',
      outline: novel.outline || [],
      chapters
    }
    list.unshift({ id: crypto.randomUUID(), at: Date.now(), label, snapshot })
    const kept = list.slice(0, HISTORY_LIMIT)
    writeJson(file, kept)
    gcBlobs(blobDir, kept)
  } catch {
    /* 历史记录失败不影响主流程 */
  }
}

/**
 * 把一份快照还原成可直接赋给 novel.chapters 的数组。
 * 兼容三种形态：
 *  - 新版：chapters[].ref 指向正文块（history/<id>.blobs/）
 *  - 中间版：chapters[].content 内嵌正文
 *  - 旧版：chapters[].context 内嵌派生摘要（新版已不再存，回滚时按正文重建）
 */
export function snapshotChapters(novel, snapshot, buildContext) {
  const blobDir = historyBlobDir(novel?.id)
  const outline = snapshot?.outline || []
  return (snapshot?.chapters || []).map(c => {
    const content = typeof c.ref === 'string' && c.ref ? readBlob(blobDir, c.ref) : String(c.content || '')
    return {
      index: c.index,
      oid: c.oid,
      title: c.title,
      content,
      words: countTextUnits(content),
      status: c.status,
      // 新版快照不存 context（它摘抄正文，会抵消去重收益），回滚时按还原出的正文重建；
      // 旧快照里带了 context 就沿用，保持与原状态一致。
      context: c.context || (buildContext ? buildContext({ outline }, c.index, content, 'generated') : undefined)
    }
  })
}

/** 快照里是否有正文块读取失败（用于决定回滚要不要整体放弃） */
export function snapshotIntact(novel, snapshot) {
  const blobDir = historyBlobDir(novel?.id)
  return (snapshot?.chapters || []).every(c => {
    if (!(typeof c.ref === 'string' && c.ref)) return true
    const text = readBlob(blobDir, c.ref)
    return text.length > 0
  })
}

// ---------- 创作研讨对话存储 ----------
// 存储结构 v2：{ version:2, activeId, sessions:[{ id, title, createdAt, updatedAt, messages:[…] }] }
// 兼容 v1（纯消息数组）：读取时自动归一化成一个会话。

/** 由首条用户消息推导会话标题（去掉附带的选段原文，压缩空白） */
export function deriveSessionTitle(messages) {
  const first = (messages || []).find(m => m && m.role === 'user' && String(m.content || '').trim())
  if (!first) return '新对话'
  const t = String(first.content)
    .replace(/【选中的原文】[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return '新对话'
  return t.length > 24 ? `${t.slice(0, 24)}…` : t
}

/** 归一化存储：兼容 v1 数组与缺失/损坏数据，始终返回 v2 结构（含上限截断） */
export function normalizeChatStore(raw) {
  const now = Date.now()
  if (Array.isArray(raw)) {
    if (!raw.length) return { version: 2, activeId: '', sessions: [] }
    const id = crypto.randomUUID()
    return {
      version: 2,
      activeId: id,
      sessions: [
        {
          id,
          title: deriveSessionTitle(raw),
          createdAt: Number(raw[0]?.at) || now,
          updatedAt: Number(raw[raw.length - 1]?.at) || now,
          messages: raw.slice(-CHAT_MSG_LIMIT)
        }
      ]
    }
  }
  if (raw && Array.isArray(raw.sessions)) {
    const sessions = raw.sessions
      .filter(s => s && typeof s.id === 'string' && Array.isArray(s.messages))
      .map(s => ({
        id: s.id,
        title: s.title || deriveSessionTitle(s.messages),
        createdAt: Number(s.createdAt) || Number(s.messages[0]?.at) || now,
        updatedAt: Number(s.updatedAt) || Number(s.messages[s.messages.length - 1]?.at) || now,
        messages: s.messages.slice(-CHAT_MSG_LIMIT)
      }))
      // 读取侧同样施加会话数上限：即使文件被手工改大或损坏，接口返回也有界
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, CHAT_SESSION_LIMIT)
    const activeId = sessions.some(s => s.id === raw.activeId) ? raw.activeId : sessions[0]?.id || ''
    return { version: 2, activeId, sessions }
  }
  return { version: 2, activeId: '', sessions: [] }
}

export function readChatStore(novelId) {
  const raw = readJson(chatFile(novelId), null)
  const store = normalizeChatStore(raw)
  // 需要落盘整理的情况：v1 迁移，或文件里存了超出上限的数据
  const rawSessionCount = Array.isArray(raw) ? 1 : Array.isArray(raw?.sessions) ? raw.sessions.length : 0
  const rawMaxMsgs = Array.isArray(raw)
    ? raw.length
    : Array.isArray(raw?.sessions)
      ? raw.sessions.reduce((m, s) => Math.max(m, Array.isArray(s?.messages) ? s.messages.length : 0), 0)
      : 0
  const needsRewrite =
    (Array.isArray(raw) && raw.length > 0) || rawSessionCount > CHAT_SESSION_LIMIT || rawMaxMsgs > CHAT_MSG_LIMIT
  if (needsRewrite) {
    try {
      writeJson(chatFile(novelId), { version: 2, activeId: store.activeId, sessions: store.sessions })
    } catch {
      /* 整理失败不影响本次读取 */
    }
  }
  return store
}

/** 直接覆写会话存储（按更新时间排序 + 截断上限），返回归一化后的结构 */
export function writeChatStore(novelId, store) {
  const sessions = (store.sessions || [])
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, CHAT_SESSION_LIMIT)
  const activeId = sessions.some(s => s.id === store.activeId) ? store.activeId : sessions[0]?.id || ''
  writeJson(chatFile(novelId), { version: 2, activeId, sessions })
  return { version: 2, activeId, sessions }
}

/** 定位会话：给了 sid 就按 sid，否则回退到 activeId 指向的会话 */
export function findSession(store, sid) {
  if (sid) return store.sessions.find(s => s.id === sid) || null
  return store.sessions.find(s => s.id === store.activeId) || null
}

/** 会话元信息（不含消息体，供列表展示） */
export function sessionMeta(s) {
  const last = s.messages[s.messages.length - 1]
  return {
    id: s.id,
    title: s.title || '新对话',
    createdAt: s.createdAt || 0,
    updatedAt: s.updatedAt || Number(last?.at) || s.createdAt || 0,
    count: s.messages.length,
    preview: String(last?.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, 60)
  }
}

/**
 * 会话记录的读-改-写事务：同一本书的对话文件串行化。
 * 原实现里「流式回复落盘」与「新建/切换会话」并发时会互相覆盖
 * （表现：刷新后新会话不见了，或最后一轮回复丢失）。
 */
export async function updateChatStore(novelId, mutate) {
  const file = chatFile(novelId)
  return withFile(file, async () => {
    const raw = await readJsonAsync(file, null)
    const store = normalizeChatStore(raw)
    const result = await mutate(store)
    // mutate 返回 false 表示「本次无需落盘」（例如只读操作或目标不存在）
    if (result === false) return store
    const sessions = (store.sessions || [])
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, CHAT_SESSION_LIMIT)
    const activeId = sessions.some(s => s.id === store.activeId) ? store.activeId : sessions[0]?.id || ''
    await writeJsonAsync(file, { version: 2, activeId, sessions })
    return { version: 2, activeId, sessions }
  })
}

/**
 * 写入某个会话的消息（书级串行事务）。
 * sid 为空时会自动新建一个会话（用于「没有活跃会话时直接发消息」的场景）。
 * 返回 { store, session }，便于调用方回传会话 id。
 */
export async function saveChat(novelId, messages, sid) {
  let savedSessionId = ''
  const store = await updateChatStore(novelId, s => {
    let target = findSession(s, sid)
    if (!target) {
      target = { id: crypto.randomUUID(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
      s.sessions.push(target)
    }
    target.messages = (messages || []).slice(-CHAT_MSG_LIMIT)
    target.updatedAt = Date.now()
    // 标题在首条用户消息落盘后固化；仍为占位标题时按内容推导
    if (!target.title || target.title === '新对话') target.title = deriveSessionTitle(target.messages)
    s.activeId = target.id
    savedSessionId = target.id
  })
  return { store, session: findSession(store, savedSessionId) }
}

/** 新建会话并置为活跃；返回完整会话对象 */
export async function createChatSession(novelId, title) {
  let newId = ''
  const store = await updateChatStore(novelId, s => {
    const session = {
      id: crypto.randomUUID(),
      title: String(title || '').trim() || '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    }
    s.sessions.push(session)
    s.activeId = session.id
    newId = session.id
  })
  return findSession(store, newId)
}

// ---------- 素材与草稿库（跨书共享） ----------
// 共用同一套全局 JSON：kind 分为 'material'（素材）与 'draft'（草稿）
export function readShelf() {
  const all = readJson(SHELF_FILE, { items: [] })
  return Array.isArray(all.items) ? all.items : []
}

export function saveShelf(items) {
  writeJson(SHELF_FILE, { items })
}

// ---------- 回收站 ----------
// 软删除：整本书（正文/大纲/版本历史/研讨对话/正文块）移进 RECYCLE_DIR/<id>/，
// 保留 meta.json 用于列表展示与恢复。

/** 把一个文件/目录移到回收站目录下；返回是否搬成功 */
function moveInto(from, to) {
  try {
    if (!fs.existsSync(from)) return false
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    return true
  } catch {
    // 跨盘 rename 会 EXDEV，退化为复制 + 删除
    try {
      fs.cpSync(from, to, { recursive: true })
      fs.rmSync(from, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
}

/** 整本小说移入回收站（连同 history / chat / blobs），返回回收站条目元信息 */
export function recycleNovel(novelId) {
  const id = String(novelId || '')
  if (!ID_RE.test(id)) throw Object.assign(new Error('作品 ID 不合法'), { status: 400 })
  const src = path.join(NOVELS_DIR, `${id}.json`)
  const novel = readJson(src, null)
  const dest = recycleDir(id)
  fs.mkdirSync(dest, { recursive: true })

  moveInto(src, path.join(dest, `${id}.json`))
  moveInto(historyFile(id), path.join(dest, `${id}.history.json`))
  moveInto(path.join(HISTORY_DIR, `${id}.blobs`), path.join(dest, `${id}.blobs`))
  moveInto(chatFile(id), path.join(dest, `${id}.chat.json`))
  // 清理**源目录**里残留的 .bak，避免「彻底删除后旧正文复活」。
  // 旧实现删的是回收站目录 dest 下的 .bak —— 但 moveInto 搬走的是主文件，那几个名字在
  // dest 下根本不存在；真正的 <id>.json.bak 留在 data/novels/ 里，带完整正文，
  // 而且永远不会被「只保留最近 7 份」的备份清理碰到（它只匹配 auto_*.json）。
  // 结果是每走一次「删除 → 彻底删除」，data/ 里就多一份已删作品的完整副本。
  for (const f of [`${src}.bak`, `${historyFile(id)}.bak`, `${chatFile(id)}.bak`]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* 不存在即可 */
    }
  }

  const meta = {
    id,
    title: novel?.title || '未命名小说',
    genre: novel?.genre || '',
    at: Date.now(),
    deletedAt: Date.now(),
    chapters: (novel?.chapters || []).length
  }
  writeJson(path.join(dest, 'meta.json'), meta)
  return meta
}

/** 回收站列表（按删除时间倒序） */
export function recycleList() {
  const out = []
  let dirs = []
  try {
    dirs = fs.readdirSync(RECYCLE_DIR)
  } catch {
    return out
  }
  for (const d of dirs) {
    const meta = readJson(path.join(RECYCLE_DIR, d, 'meta.json'), null)
    if (meta && meta.id) out.push(meta)
  }
  return out.sort((a, b) => (b.deletedAt || b.at || 0) - (a.deletedAt || a.at || 0))
}

/** 从回收站恢复一本小说，返回元信息（不存在则返回 null） */
export function restoreRecycle(novelId) {
  const id = String(novelId || '')
  if (!ID_RE.test(id)) return null
  const dir = recycleDir(id)
  const meta = readJson(path.join(dir, 'meta.json'), null)
  if (!meta) return null

  const entries = [
    [path.join(dir, `${id}.json`), path.join(NOVELS_DIR, `${id}.json`)],
    [path.join(dir, `${id}.history.json`), historyFile(id)],
    [path.join(dir, `${id}.blobs`), path.join(HISTORY_DIR, `${id}.blobs`)],
    [path.join(dir, `${id}.chat.json`), chatFile(id)]
  ]
  if (!fs.existsSync(entries[0][0])) throw new Error('回收站缺少作品原件，已保留现有恢复文件')
  const present = entries.filter(([source]) => fs.existsSync(source))
  // 先检查目标，禁止覆盖已经存在的作品；全部复制成功才删除回收站。
  for (const [, target] of present) {
    if (fs.existsSync(target)) throw new Error('目标位置已有同 ID 数据，请先处理冲突；回收站原件已保留')
  }
  const copied = []
  try {
    for (const [source, target] of present) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      copied.push(target)
      fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
    }
  } catch (error) {
    for (const target of copied.reverse()) {
      try {
        fs.rmSync(target, { recursive: true, force: true })
      } catch {
        /* 原件仍在回收站 */
      }
    }
    throw new Error('恢复未完成，回收站原件已保留：' + error.message)
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 残留目录无害 */
  }
  return meta
}

/**
 * 彻底删除回收站里的一项；顺带扫掉源目录里遗留的 .bak。
 * 返回是否真的删掉了东西，供调用方判断「本来就是空的」还是「删干净了」。
 */
export function purgeRecycle(novelId) {
  const id = String(novelId || '')
  if (!ID_RE.test(id)) return false
  let removed = false
  try {
    fs.rmSync(recycleDir(id), { recursive: true, force: true })
    removed = true
  } catch {
    /* 已不存在 */
  }
  // 软删除把主文件搬进回收站，源目录只会剩 .bak。它们带着完整正文，留着等于「删了但没删干净」。
  // 这里兜底再扫一次：老版本留下的残留、以及 recycleNovel 那次 unlink 失败的漏网文件都能清掉。
  for (const f of [
    path.join(NOVELS_DIR, `${id}.json.bak`),
    path.join(HISTORY_DIR, `${id}.json.bak`),
    path.join(CHATS_DIR, `${id}.json.bak`)
  ]) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f)
        removed = true
      }
    } catch {
      /* 清理失败不阻塞删除 */
    }
  }
  return removed
}

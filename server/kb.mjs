// 知识库（对标 ima）：可检索的文档库。
//
// 与素材库的区别：素材库是零散灵感（量小，整体塞进提示词）；知识库是**成篇文档**，
// 必须按需检索——这也是为什么它需要分块与打分，而不是像素材那样直接拼。
//
// 技术选型：**零依赖的字符级检索**。中文没有现成分词器，用「2-gram + 英文/数字词」做词项，
// TF × 逆文档频率打分。对写作场景这种粒度足够（查询通常是"金手指/节奏/打脸"这类短查询），
// 且不引入任何向量库或 embedding 依赖 —— 桌面应用里那是过度设计。
//
// 存储：data/kb/<kbId>/kb.json —— { meta, docs, chunks }，chunk 文本内联。
// 单个知识库封顶 40 篇文档 / 600 块，防止单文件膨胀到不可读。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR, withFile } from './store.mjs'

export const KB_DIR = path.join(DATA_DIR, 'kb')

const MAX_DOCS = 40
const MAX_CHUNKS = 600
const CHUNK_CHARS = 480
const MAX_DOC_CHARS = 300000

const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function bump(map, term, n = 1) {
  map.set(term, (map.get(term) || 0) + n)
}

/** 词项化：英文/数字词 + 中文 2-gram（标点剔除） */
export function terms(text) {
  const out = new Map()
  const s = String(text || '')
  for (const w of s.toLowerCase().match(/[a-z0-9]{2,}/g) || []) bump(out, w)
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    if (seg.length < 2) continue
    for (let i = 0; i < seg.length - 1; i++) bump(out, seg.slice(i, i + 2))
  }
  return out
}

const kbFile = id => path.join(KB_DIR, id, 'kb.json')

function readKb(id) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(id || ''))) return null
  try {
    const kb = JSON.parse(fs.readFileSync(kbFile(id), 'utf8'))
    return kb && kb.id === id ? kb : null
  } catch {
    return null
  }
}

function writeKb(kb) {
  const file = kbFile(kb.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 先写临时文件再 rename：崩溃/并发时不会留下半截 kb.json
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(kb))
  fs.renameSync(tmp, file)
}

/** 列出全部知识库（只回元信息，不带块文本） */
export function listKb() {
  let dirs = []
  try {
    dirs = fs.readdirSync(KB_DIR, { withFileTypes: true }).filter(e => e.isDirectory())
  } catch {
    return []
  }
  const out = []
  for (const d of dirs) {
    const kb = readKb(d.name)
    if (!kb) continue
    out.push({
      id: kb.id,
      name: kb.name,
      description: kb.description || '',
      createdAt: kb.createdAt || 0,
      docs: (kb.docs || []).map(({ id, name, chars, chunks, addedAt }) => ({ id, name, chars, chunks, addedAt })),
      chunkCount: (kb.chunks || []).length
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function createKb(name, description) {
  const kb = {
    id: rid(),
    name:
      String(name || '')
        .trim()
        .slice(0, 60) || '未命名知识库',
    description: String(description || '')
      .trim()
      .slice(0, 300),
    createdAt: Date.now(),
    docs: [],
    chunks: []
  }
  writeKb(kb)
  return kb
}

export function deleteKb(id) {
  // 删除也要进队列：否则「删除整库」与「正在入库的批量导入」并发时会复活半截库
  return mutateKbFile(id, () => deleteKbInner(id))
}

function deleteKbInner(id) {
  const kb = readKb(id)
  if (!kb) return false
  try {
    fs.rmSync(path.join(KB_DIR, id), { recursive: true, force: true })
  } catch {
    return false
  }
  return true
}

/** 按段落聚合切块：段落优先，超长段按字数硬切 */
function chunkText(content) {
  const paras = String(content || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{1,}/)
    .map(p => p.trim())
    .filter(Boolean)
  const out = []
  let cur = ''
  for (const p of paras) {
    let piece = p
    // 单段超长：按 CHUNK_CHARS 硬切
    while (piece.length > CHUNK_CHARS) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      out.push(piece.slice(0, CHUNK_CHARS))
      piece = piece.slice(CHUNK_CHARS)
    }
    if (!piece) continue
    if ((cur + '\n' + piece).length > CHUNK_CHARS) {
      out.push(cur)
      cur = piece
    } else {
      cur = cur ? cur + '\n' + piece : piece
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 把 kb.json 的读-改-写包进 store 的每文件写队列（与小说/对话同一套基建）。
 * 原实现 addDoc/removeDoc/pushQa 是裸「read → 改 → write」：批量导入文件夹与
 * 用户同时贴文本加文档、或与问答历史落盘并发时，后写者整档覆盖先写者（丢文档/丢记录）。
 * 注意：这些函数因此变为 **async**，调用方必须 await。
 */
function mutateKbFile(kbId, fn) {
  return withFile(kbFile(kbId), () => fn())
}

/** 往知识库里加一篇文档：切块 + 建词项索引 */
/** 新增文档（切块 + 建索引）。**异步**：走 kb.json 的写队列，调用方必须 await */
export async function addDoc(kbId, doc) {
  return mutateKbFile(kbId, () => addDocInner(kbId, doc))
}

function addDocInner(kbId, { name, content }) {
  const kb = readKb(kbId)
  if (!kb) return { error: '知识库不存在' }
  if ((kb.docs || []).length >= MAX_DOCS) return { error: `一个知识库最多 ${MAX_DOCS} 篇文档` }
  if ((kb.chunks || []).length >= MAX_CHUNKS)
    return { error: `该知识库块数已达上限（${MAX_CHUNKS}），请删除部分文档后再加` }

  const text = String(content || '').trim()
  if (text.length < 50) return { error: '内容太短（至少 50 字）' }
  const clipped = text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text

  const docId = rid()
  const pieces = chunkText(clipped).slice(0, Math.max(0, MAX_CHUNKS - (kb.chunks || []).length))
  if (!pieces.length) return { error: '切块失败：内容为空' }

  kb.docs = [
    ...(kb.docs || []),
    {
      id: docId,
      name: String(name || '未命名').slice(0, 120),
      chars: clipped.length,
      chunks: pieces.length,
      addedAt: Date.now()
    }
  ]
  kb.chunks = [
    ...(kb.chunks || []),
    ...pieces.map(text2 => ({
      docId,
      docName: kb.docs[kb.docs.length - 1].name,
      text: text2,
      tf: Object.fromEntries(terms(text2))
    }))
  ]
  writeKb(kb)
  return { ok: true, doc: kb.docs[kb.docs.length - 1], chunks: pieces.length }
}

/** 删除文档及其块。**异步**：走 kb.json 的写队列，调用方必须 await */
export async function removeDoc(kbId, docId) {
  return mutateKbFile(kbId, () => removeDocInner(kbId, docId))
}

function removeDocInner(kbId, docId) {
  const kb = readKb(kbId)
  if (!kb) return { error: '知识库不存在' }
  const before = (kb.docs || []).length
  kb.docs = (kb.docs || []).filter(d => d.id !== docId)
  if (kb.docs.length === before) return { error: '文档不存在' }
  kb.chunks = (kb.chunks || []).filter(c => c.docId !== docId)
  writeKb(kb)
  return { ok: true }
}

// ---------- 问答历史（每本书库独立，随 kb.json 落盘） ----------
const QA_LIMIT = 30

/** 读问答历史。同步读缓存，与 listKb 同源；不参与写队列 */
export function listQa(kbId) {
  const kb = readKb(kbId)
  return kb && Array.isArray(kb.qa) ? kb.qa : []
}

/** 追加一条问答记录。**异步**：走 kb.json 的写队列，调用方必须 await */
export async function pushQa(kbId, entry) {
  return mutateKbFile(kbId, () => pushQaInner(kbId, entry))
}

function pushQaInner(kbId, entry) {
  const kb = readKb(kbId)
  if (!kb) return { error: '知识库不存在' }
  kb.qa = [...(Array.isArray(kb.qa) ? kb.qa : []), { id: rid(), at: Date.now(), ...entry }].slice(-QA_LIMIT)
  writeKb(kb)
  return { ok: true }
}

/** 清空问答记录。**异步**：走 kb.json 的写队列，调用方必须 await */
export async function clearQa(kbId) {
  return mutateKbFile(kbId, () => clearQaInner(kbId))
}

function clearQaInner(kbId) {
  const kb = readKb(kbId)
  if (!kb) return { error: '知识库不存在' }
  kb.qa = []
  writeKb(kb)
  return { ok: true }
}

/**
 * 检索：默认跨全部知识库打分；传 kbIds 则只在这些库内检索（知识库页的「库内问答」用）。
 * 打分 = Σ(块内词频 × 查询词频 × 稀有度)，稀有度 = 1 + log(总块数 / 含该词的块数)。
 * 返回按预算截断的命中块（带上知识库与文档名，便于模型引用来源）。
 */
export function searchKb(query, { topK = 6, budget = 1600, kbIds = null } = {}) {
  const wanted = Array.isArray(kbIds) && kbIds.length ? new Set(kbIds) : null
  const kbs = []
  try {
    for (const d of fs.readdirSync(KB_DIR, { withFileTypes: true })) {
      if (d.isDirectory()) {
        const kb = readKb(d.name)
        if (!kb || !(kb.chunks || []).length) continue
        if (wanted && !wanted.has(kb.id)) continue
        kbs.push(kb)
      }
    }
  } catch {
    return { hits: [], used: 0 }
  }
  const totalChunks = kbs.reduce((s, k) => s + k.chunks.length, 0)
  if (!totalChunks) return { hits: [], used: 0 }

  const q = terms(query)
  if (!q.size) return { hits: [], used: 0 }

  // 每个词项的文档频率（含它的块数）——一次性统计
  const df = new Map()
  for (const kb of kbs) {
    for (const c of kb.chunks) {
      for (const term of Object.keys(c.tf || {})) if (q.has(term)) bump(df, term)
    }
  }

  const scored = []
  for (const kb of kbs) {
    for (const c of kb.chunks) {
      let score = 0
      for (const [term, qtf] of q) {
        const tf = c.tf?.[term]
        if (!tf) continue
        const rarity = 1 + Math.log(totalChunks / Math.max(1, df.get(term) || 1))
        score += tf * qtf * rarity
      }
      if (score > 0) scored.push({ kb, c, score })
    }
  }
  scored.sort((a, b) => b.score - a.score)

  // 按预算贪心装箱：同文档只取最高分的一块优先，避免整份报告被同一段刷屏
  const seen = new Set()
  const hits = []
  let used = 0
  for (const s of scored) {
    if (hits.length >= topK) break
    if (seen.has(s.c.docId) && hits.length < topK - 1) continue // 留一个名额给同文档的第二块
    seen.add(s.c.docId)
    let text = s.c.text
    if (used + text.length > budget) text = text.slice(0, Math.max(80, budget - used)) + '…'
    used += text.length
    hits.push({ kbId: s.kb.id, kbName: s.kb.name, docName: s.c.docName, text, score: +s.score.toFixed(2) })
    if (used >= budget) break
  }
  return { hits, used }
}

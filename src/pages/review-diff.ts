/**
 * 审校对照的句级差异：按 。！？ 与换行切句，对两侧句子做 LCS，标出原稿删改句与候选稿新增句。
 *
 * 先剥掉首尾相同的句子再做 LCS（续写只在末尾追加、修改多是局部改动，剩下的中段通常很短）；
 * 中段仍过大时整段标为改动，保证六千字以上的章节也不卡界面。
 */

export interface DiffPart {
  text: string
  /** 被删改（原稿侧）或新增（候选稿侧）的句子 */
  changed: boolean
}

export interface SentenceDiff {
  original: DiffPart[]
  candidate: DiffPart[]
  /** 原稿中被删改的句数 */
  removed: number
  /** 候选稿中新增的句数 */
  added: number
}

/** 中段 LCS 表的上限（约 16MB 的 Int32Array）；超过就退化为整段标记 */
const MAX_CELLS = 4_000_000

// 句末标点后的收尾引号、括号归入本句；连续的标点（如「！？」）也算同一句
const SENTENCE = /[^。！？!?\n]*(?:[。！？!?]+[”’」』）》】]*)?\n*/g

/** 切句：每句带上句末标点和随后的换行，所有片段首尾相接即原文 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let carry = ''
  SENTENCE.lastIndex = 0
  for (let m = SENTENCE.exec(text); m && m[0]; m = SENTENCE.exec(text)) {
    const piece = m[0]
    if (!piece.trim()) {
      // 纯空白（空行、段首缩进）并到上一句，不单独参与比较
      if (out.length) out[out.length - 1] += piece
      else carry += piece
      continue
    }
    out.push(carry + piece)
    carry = ''
  }
  if (carry) {
    if (out.length) out[out.length - 1] += carry
    else out.push(carry)
  }
  return out
}

/** 比较用的键：忽略首尾空白，段首缩进或空行的变化不算改动 */
const keyOf = (s: string) => s.trim()

/** 改动句只给正文上底色：首尾空白（缩进、换行）留在标记之外，免得整行都被染色 */
function pushToken(parts: DiffPart[], token: string, changed: boolean) {
  if (!changed) {
    const last = parts[parts.length - 1]
    if (last && !last.changed) last.text += token
    else parts.push({ text: token, changed: false })
    return
  }
  const lead = token.length - token.trimStart().length
  const tail = token.length - token.trimEnd().length
  if (lead) pushToken(parts, token.slice(0, lead), false)
  parts.push({ text: token.slice(lead, token.length - tail), changed: true })
  if (tail) pushToken(parts, token.slice(token.length - tail), false)
}

export function diffSentences(original: string, candidate: string): SentenceDiff {
  const a = splitSentences(original)
  const b = splitSentences(candidate)
  // 句子映射成整数，LCS 内层循环只比较数字
  const ids = new Map<string, number>()
  const idOf = (s: string) => {
    const k = keyOf(s)
    let v = ids.get(k)
    if (v === undefined) {
      v = ids.size
      ids.set(k, v)
    }
    return v
  }
  const ia = a.map(idOf)
  const ib = b.map(idOf)
  const keepA = new Uint8Array(a.length)
  const keepB = new Uint8Array(b.length)

  let head = 0
  while (head < a.length && head < b.length && ia[head] === ib[head]) {
    keepA[head] = 1
    keepB[head] = 1
    head++
  }
  let tailA = a.length
  let tailB = b.length
  while (tailA > head && tailB > head && ia[tailA - 1] === ib[tailB - 1]) {
    tailA--
    tailB--
    keepA[tailA] = 1
    keepB[tailB] = 1
  }

  const n = tailA - head
  const m = tailB - head
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_CELLS) {
    // dp[i][j]：a[head+i..] 与 b[head+j..] 的 LCS 长度（后缀表，便于从前往后回溯）
    const w = m + 1
    const dp = new Int32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      const ai = ia[head + i]
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          ai === ib[head + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (ia[head + i] === ib[head + j]) {
        keepA[head + i] = 1
        keepB[head + j] = 1
        i++
        j++
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
      else j++
    }
  }

  const result: SentenceDiff = { original: [], candidate: [], removed: 0, added: 0 }
  a.forEach((s, k) => {
    const changed = !keepA[k] && !!keyOf(s)
    if (changed) result.removed++
    pushToken(result.original, s, changed)
  })
  b.forEach((s, k) => {
    const changed = !keepB[k] && !!keyOf(s)
    if (changed) result.added++
    pushToken(result.candidate, s, changed)
  })
  return result
}

import { Fragment, memo, useMemo, type ReactNode } from 'react'
import './markdown.css'

// 轻量 Markdown：只认对话里常见的块（标题 / 列表 / 引用 / 代码 / 分隔线 / 表格）与行内粗体、代码、链接。
// 全部输出 React 元素，不拼 HTML 字符串，模型回复里混进的标签只会按原文显示。
// 段内单个换行保留为换行：中文写作一行一句很常见，按 CommonMark 合并会把排版挤成一团。

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; lines: string[] }
  | { t: 'ul' | 'ol'; items: string[]; start: number }
  | { t: 'quote'; lines: string[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' }
  | { t: 'table'; head: string[]; rows: string[][] }

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)/
const HEADING = /^(#{1,4})\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>/
const UL = /^\s*[-*+•]\s+/
const OL = /^\s*(\d{1,3})[.、)]\s+/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}/

function isBlockStart(lines: string[], i: number) {
  const l = lines[i]
  return (
    FENCE.test(l) ||
    HEADING.test(l) ||
    RULE.test(l) ||
    QUOTE.test(l) ||
    UL.test(l) ||
    OL.test(l) ||
    (TABLE_ROW.test(l) && TABLE_SEP.test(lines[i + 1] || ''))
  )
}

const cells = (s: string) =>
  s
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim())

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = line.match(FENCE)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++])
      i++ // 收尾围栏；流式输出时可能还没到，越界无妨
      out.push({ t: 'code', lang: fence[2], text: buf.join('\n') })
      continue
    }
    const h = line.match(HEADING)
    if (h) {
      out.push({ t: 'h', level: h[1].length, text: h[2].replace(/\s*#+\s*$/, '') })
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ t: 'quote', lines: buf })
      continue
    }
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] || '')) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]))
      out.push({ t: 'table', head, rows })
      continue
    }
    if (UL.test(line) || OL.test(line)) {
      const ordered = !UL.test(line)
      const re = ordered ? OL : UL
      const start = ordered ? Number(line.match(OL)![1]) : 1
      const items: string[] = []
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i++].replace(re, '')
        // 缩进的续行并进同一项
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i]))
          item += `\n${lines[i++].trim()}`
        items.push(item)
      }
      out.push({ t: ordered ? 'ol' : 'ul', items, start })
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && (buf.length === 0 || !isBlockStart(lines, i))) buf.push(lines[i++])
    out.push({ t: 'p', lines: buf })
  }
  return out
}
// 行内：`代码`、**粗体**、*斜体*、[文字](http链接)、裸 http 链接、引用角标 [1]。只放行 http(s)，别的协议按原文显示
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>()（）「」，。]+)|\[(\d{1,2})\]/g

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const k = `${key}-${n++}`
    const [all, code, strong, em, link, bare, cite] = m
    if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>)
    else if (strong) out.push(<strong key={k}>{inline(strong.slice(2, -2), k)}</strong>)
    else if (em) out.push(<em key={k}>{inline(em.slice(1, -1), k)}</em>)
    else if (link) {
      const mm = link.match(/^\[([^\]]+)\]\((.+)\)$/)
      out.push(
        <a key={k} href={mm?.[2]} target="_blank" rel="noreferrer">
          {mm?.[1] || link}
        </a>
      )
    } else if (bare)
      out.push(
        <a key={k} href={bare} target="_blank" rel="noreferrer">
          {bare}
        </a>
      )
    // 资料库问答的引用编号：与回答下方「引用来源」列表的序号一一对应
    else if (cite)
      out.push(
        <sup key={k} className="md-cite" aria-label={`引用 ${cite}`}>
          {cite}
        </sup>
      )
    else out.push(all)
    last = at + all.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function lines(ls: string[], key: string) {
  return ls.map((l, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {inline(l, `${key}-${i}`)}
    </Fragment>
  ))
}

function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parse(text || ''), [text])
  return (
    <div className={`md ${className || ''}`}>
      {blocks.map((b, i) => {
        const k = `b${i}`
        switch (b.t) {
          case 'h':
            return b.level <= 2 ? <h3 key={k}>{inline(b.text, k)}</h3> : <h4 key={k}>{inline(b.text, k)}</h4>
          case 'p':
            return <p key={k}>{lines(b.lines, k)}</p>
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{lines(it.split('\n'), `${k}-${j}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={k} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{lines(it.split('\n'), `${k}-${j}`)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return <blockquote key={k}>{lines(b.lines, k)}</blockquote>
          case 'code':
            return (
              <pre key={k} data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            )
          case 'hr':
            return <hr key={k} />
          case 'table':
            return (
              <div key={k} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>{inline(c, `${k}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, j) => (
                          <td key={j}>{inline(c, `${k}-${ri}-${j}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}

export default memo(Markdown)

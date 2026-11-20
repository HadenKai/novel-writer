// 写作 Agent：把「一章正文」拆成 构思 → 起草 → 自检 → 修订 四个阶段。
//
// 为什么值得多花两次调用：
//  - 一次性生成长文时，模型会一边想结构一边写句子，结构问题（漏事件、视角漂移）
//    在成文后已经很难补救；
//  - 先出一份很短的「执行方案」，再照着方案写，大纲覆盖率和人物一致性明显更稳；
//  - 写完让模型以审稿人身份挑刺，只改被指出的问题，比让作者自己逐段找问题快得多。
//
// 这三段都刻意做成小提示词：本地模型上下文小，方案与审稿不该抢正文的预算。
import { section, assemblePrompt, countTextUnits } from '../ai.mjs'

function tailText(text, n = 700) {
  const s = String(text || '').trim()
  return s.length > n ? s.slice(-n) : s
}

/** 方案与审稿共用的小预算：只带必要上下文，避免本地模型被长提示词拖慢 */
const BRIEF_LIMIT = 12000

function authorRequest(extraPrompt) {
  return section(
    '本次要求',
    extraPrompt ? `【作者本次写作补充要求】（作为正文要求，当前阶段仍按规定格式输出）\n${extraPrompt}` : '',
    { keep: true }
  )
}

function outlineOf(novel, idx) {
  return (novel.outline || []).find(o => o.index === idx)
}

function prevTail(novel, idx, chars = 700) {
  const prev = (novel.chapters || [])
    .filter(c => c.index < idx && c.content?.trim())
    .sort((a, b) => b.index - a.index)[0]
  return prev ? `第 ${prev.index} 章结尾：\n${tailText(prev.content, chars)}` : '（本章是开篇，没有前文）'
}

function castText(novel) {
  const all = [novel.protagonist, ...(novel.characters || [])].filter(c => c?.name)
  if (!all.length) return '（未设定人物）'
  return all
    .slice(0, 12)
    .map(c => `- ${c.name}（${c.role || '角色'}）：${(c.personality || c.background || '').slice(0, 80) || '无描述'}`)
    .join('\n')
}

function plotlineText(novel) {
  const lines = (novel.plotlines || [])
    .filter(p => p?.name && p.status !== 'done')
    .slice(0, 6)
    .map(
      p =>
        `- ${p.name}（${p.status === 'active' ? '进行中' : '待展开'}）：${(p.goal || p.description || '').slice(0, 100)}`
    )
  return lines.length ? lines.join('\n') : ''
}

/**
 * 第一阶段：本章执行方案。
 * 输出严格 JSON，字段少而明确——小模型也能稳定照做。
 */
export function chapterBriefMessages(novel, chapterIndex, opts = {}) {
  const cur = outlineOf(novel, chapterIndex)
  const next = outlineOf(novel, chapterIndex + 1)
  const targetWords = novel.targetWords || 2000

  const sections = [
    section('任务', `为长篇小说《${novel.title || '未命名'}》第 ${chapterIndex} 章设计一份可直接照着写的执行方案。`),
    section(
      '全书',
      `【类型】${novel.genre || '未指定'}\n【视角】${novel.pov === 'first' ? '第一人称' : '第三人称'}\n【简介】${(novel.synopsis || '').slice(0, 400) || '（无）'}`
    ),
    section('人物', castText(novel)),
    section('剧情线', plotlineText(novel)),
    section('本章大纲', cur ? `《${cur.title}》\n${cur.summary}` : '（没有本章大纲，按前文自然推进）', { keep: true }),
    authorRequest(opts.extraPrompt),
    section('下一章', next ? `《${next.title}》\n${(next.summary || '').slice(0, 300)}` : '（暂无）'),
    // 作者关掉「关联前文」时，方案也不该读上一章，否则等于换个地方违反这个开关
    section(
      '前文',
      opts.linkContext === false
        ? '（作者已关闭「关联前文」：只依据大纲与设定设计，不要依赖上一章情节）'
        : prevTail(novel, chapterIndex),
      { keep: true }
    ),
    section(
      '要求',
      `设计 ${Math.max(3, Math.min(6, Math.round(targetWords / 600)))} 个场景节拍，覆盖本章大纲里的全部关键事件。
只要方案，不要写正文。严格输出 JSON，不要代码块、不要解释：
{"goal":"本章一句话目标","beats":[{"label":"开场/发展/转折/收束","event":"发生什么","purpose":"对人物或主线的作用"}],"turningPoint":"本章最重要的转折","hook":"结尾悬念","callbacks":["必须回收的前文伏笔"],"avoid":["本章不该出现的内容"]}`,
      { keep: true }
    )
  ]
  return [
    { role: 'system', content: '你是资深小说策划编辑，擅长把章节大纲拆成可执行、有张力的场景节拍。只输出 JSON。' },
    { role: 'user', content: assemblePrompt(sections, { limit: opts.limit || BRIEF_LIMIT }) }
  ]
}

/** 第二阶段之后的审稿：只挑真正影响阅读的问题，避免模型为了凑数而重写 */
export function chapterReviewMessages(novel, chapterIndex, draft, opts = {}) {
  const cur = outlineOf(novel, chapterIndex)
  const text = String(draft || '')
  const sections = [
    section(
      '任务',
      `你是审稿编辑。审阅《${novel.title || '未命名'}》第 ${chapterIndex} 章的初稿，指出必须修改的问题。`
    ),
    section('本章大纲', cur ? `《${cur.title}》\n${cur.summary}` : '（无）', { keep: true }),
    section(
      '写作约束',
      `视角：${novel.pov === 'first' ? '第一人称' : '第三人称'}；目标字数约 ${novel.targetWords || 2000} 字；当前 ${countTextUnits(text)} 字。`
    ),
    authorRequest(opts.extraPrompt),
    section('初稿', text, { keep: true }),
    section(
      '审查维度',
      `1. 大纲落实：本章大纲的关键事件是否都写了，有没有漏或写偏
2. 人物一致：言行是否符合设定，有没有突然的性格漂移
3. 连贯：与上一章的衔接、时间地点、道具与伤势是否自洽
4. 节奏：是否有大段解释、无效对话、重复描写
5. AI 腔：动作后补解读、堆砌修饰、整齐排比、空泛抒情
6. 作者本次要求：检查是否已落实。篇幅优先参考本次明确要求，否则检查是否低于默认目标的 85% 或高于 115%`,
      { keep: true }
    ),
    section(
      '输出',
      `只报确实需要改的问题，最多 5 条；没有问题时 issues 为空数组。不要重写正文。
同时顺手记录章末状态（供后续章节核对连续性，只依据初稿里真实发生的内容）：
- characterState：主要人物截至本章结尾的状态，每人一句（位置/伤势/持有物/情绪/关系变化），只写本章出场的人物
- openThreads：本章埋下尚未回收的伏笔，用顿号分隔；没有就写"无"
严格输出 JSON，不要代码块：
{"score":0-100,"summary":"一句话总评","issues":[{"type":"大纲|人物|连贯|节奏|AI腔|篇幅","severity":"high|medium|low","quote":"原文片段（不超过40字）","fix":"具体怎么改"}],"characterState":"……","openThreads":"……"}`,
      { keep: true }
    )
  ]
  return [
    { role: 'system', content: '你是严格但有建设性的小说审稿编辑。只输出 JSON。' },
    {
      role: 'user',
      content: assemblePrompt(sections, { limit: opts.limit || Math.min(40000, Math.max(12000, text.length + 6000)) })
    }
  ]
}

/** 第三阶段：带着问题清单改稿。要求只改问题，不重写没问题的部分 */
export function chapterFixMessages(novel, chapterIndex, draft, issues, opts = {}) {
  const cur = outlineOf(novel, chapterIndex)
  const list = (issues || [])
    .slice(0, 6)
    .map(
      (it, i) =>
        `${i + 1}. [${it.severity || 'medium'}/${it.type || '问题'}] ${it.fix || it.quote || ''}${it.quote ? `（原文：「${it.quote}」）` : ''}`
    )
    .join('\n')
  const sections = [
    section(
      '任务',
      `按审稿意见修改《${novel.title || '未命名'}》第 ${chapterIndex} 章。只改被指出的问题，其余段落尽量保持原样。`
    ),
    section('本章大纲', cur ? `《${cur.title}》\n${cur.summary}` : '（无）'),
    authorRequest(opts.extraPrompt),
    section('审稿意见', list, { keep: true }),
    section('原稿', draft, { keep: true }),
    section(
      '要求',
      `1. 逐条落实上面的意见；没被指出的段落不要改写、不要调整顺序
2. 不要新增人物、设定或支线；不要删掉大纲里的关键事件
3. 保持原有视角与文风；字数保持在原稿的 90%~110%
4. 直接输出修改后的完整正文，不要标题、序号、说明或修改清单`,
      { keep: true }
    )
  ]
  return [
    { role: 'system', content: '你是小说改稿编辑，能精准执行审稿意见而不破坏作者原有笔触。' },
    {
      role: 'user',
      content: assemblePrompt(sections, {
        limit: opts.limit || Math.min(60000, Math.max(12000, String(draft).length + 6000))
      })
    }
  ]
}

/** 把审稿 JSON 收敛成「值得改的问题」；解析失败就当没意见，不让 Agent 卡死 */
export function pickActionableIssues(report, { max = 5 } = {}) {
  const issues = Array.isArray(report?.issues) ? report.issues : []
  return issues
    .filter(it => it && (it.severity === 'high' || it.severity === 'medium'))
    .filter(it => String(it.fix || it.quote || '').trim())
    .slice(0, max)
}

// 「作者亲笔样本 + 一键落库」回归测试
//
// 覆盖三件事：
//  1. 作者在成书页手改过的章节，context.source 标记为 manual（AI 据此识别「作者亲笔」）
//  2. 管家提示词里出现【作者亲笔 · 文风对齐样本】，且引用的是手改章节的原文
//  3. 一键落库端点：把一段正文写进指定章节（replace / append）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-author-style-'))
process.env.NOVEL_DATA_DIR = tmpData

const { startServer, stopServer, looksLikeDeliveredProse } = await import('../server/app.mjs')
const { chatMessages } = await import('../server/ai.mjs')

let base = ''

async function j(url, method = 'GET', body) {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let data = null
  try {
    data = await r.json()
  } catch {
    /* 无响应体 */
  }
  return { status: r.status, data }
}

/** 手写正文（带动作与对白，方便和讨论性文字区分开） */
const AUTHOR_PROSE =
  '他把碗放下，放得很轻。窗外有人在收摊，铁皮卷帘门哗啦啦砸下来。她没抬头，只把袖口又挽了一圈。'.repeat(6)

test('作者亲笔样本与一键落库', { timeout: 60000 }, async () => {
  const port = await startServer(0)
  base = `http://127.0.0.1:${port}`

  const created = await j('/api/novels', 'POST', { title: '文风测试书', genre: '都市' })
  const id = created.data.id
  assert.ok(id)

  // 建两条大纲，其中第 1 章写好正文
  const seeded = JSON.parse(fs.readFileSync(path.join(tmpData, 'novels', `${id}.json`), 'utf8'))
  seeded.outline = [
    { index: 1, title: '开端', summary: '开场', customPrompt: '' },
    { index: 2, title: '推进', summary: '冲突', customPrompt: '' }
  ]
  seeded.chapters = [
    {
      index: 1,
      title: '开端',
      content: '这是 AI 第一次写的正文，堆了很多神秘的、深邃的、璀璨的形容词。'.repeat(4),
      words: 120,
      status: 'done'
    }
  ]
  fs.writeFileSync(path.join(tmpData, 'novels', `${id}.json`), JSON.stringify(seeded))

  // ---------- 1. AI 产出后再手改 → source 应为 manual ----------
  const put = await j(`/api/novels/${id}/chapters/1`, 'PUT', { content: AUTHOR_PROSE })
  assert.equal(put.status, 200)
  assert.equal(put.data.chapter.context.source, 'manual', '手改后 source 应为 manual')
  assert.ok(put.data.chapter.context.manualEdits >= 1, '应记录手改次数')

  // ---------- 2. 管家提示词应引用作者亲笔 ----------
  const novel = (await j(`/api/novels/${id}`)).data
  const msgs = chatMessages(novel, [])
  const sys = msgs[0].content
  assert.ok(sys.includes('【作者亲笔 · 文风对齐样本】'), '提示词应有作者亲笔样本区')
  assert.ok(sys.includes('他把碗放下，放得很轻'), '应引用手改章节的原文')
  // 未手改过的第 2 章原文不应被当作样本
  assert.ok(!sys.includes('神秘的、深邃的、璀璨的'), 'AI 产出的旧正文不应出现在亲笔样本里')

  // ---------- 3. 一键落库：replace 写入第 2 章 ----------
  const persist = await j(`/api/novels/${id}/chat/persist`, 'POST', { chapter: 2, text: AUTHOR_PROSE, mode: 'replace' })
  assert.equal(persist.status, 200)
  assert.equal(persist.data.chapter.index, 2)
  assert.equal(persist.data.chapter.context.source, 'generated', '经作者点按落库的 AI 正文仍是 generated')
  assert.ok(persist.data.chapter.words > 100)

  // ---------- 4. 一键落库：append 追加 ----------
  const append = await j(`/api/novels/${id}/chat/persist`, 'POST', {
    chapter: 2,
    text: '她终于抬头看了一眼窗外。',
    mode: 'append'
  })
  assert.equal(append.status, 200)
  assert.ok(append.data.chapter.content.includes('她终于抬头看了一眼窗外。'), '追加应接在原正文后')
  assert.ok(append.data.chapter.content.includes('他把碗放下'), '追加后原正文应保留')

  // ---------- 5. 参数校验 ----------
  const noChapter = await j(`/api/novels/${id}/chat/persist`, 'POST', { chapter: 0, text: 'x' })
  assert.equal(noChapter.status, 400)
  const noText = await j(`/api/novels/${id}/chat/persist`, 'POST', { chapter: 1, text: '   ' })
  assert.equal(noText.status, 400)

  await stopServer()
})

test('needsPersist 识别：成段正文算，讨论/清单不算', () => {
  // 成段连续叙述（足够长、句读密集、无问句）→ 应识别为交付正文
  const prose = [
    '他把碗放下，放得很轻。窗外有人在收摊，铁皮卷帘门哗啦啦砸下来，震得窗棂发麻。他没看她，只是把筷子摆正，又摆正了一次。',
    '她没抬头，只把袖口又挽了一圈，指尖在桌沿上敲了两下，又停住。灶上的水开了，咕嘟咕嘟顶着盖子，她伸手把火拧小，动作很慢。',
    '门没锁。他推开门的时候，屋里那股潮气先涌了出来，混着隔夜的烟味。墙角的纸箱还是去年搬来时的样子，胶带翘起了边。',
    '屋里只有一盏灯。灯罩上落了灰，光打下来是黄的，照得桌沿一圈发亮。他把报纸铺开，压平了翘起的角。',
    '「你回来得早。」她背对着他说。「嗯。」他把外套挂在门后的钩子上，钩子松了，他扶了一下才挂稳。'
  ].join('\n\n')
  assert.equal(looksLikeDeliveredProse(prose), true, '成段连续叙述应识别为交付正文')

  // 讨论式回复（多问句）→ 不算
  const discussion =
    '你觉得这一章的问题在哪？\n\n节奏是不是太快了？\n\n或者你更想先处理人物动机？我建议先想清楚她为什么要走，你觉得呢。'
  assert.equal(looksLikeDeliveredProse(discussion), false, '讨论式多问句不应识别为正文')

  // 方案清单 → 不算
  const plan = [
    '- 方案一：让她主动摊牌，把矛盾挑明，冲突放在本章高潮',
    '- 方案二：让他先离开，把冲突留到下一章，本章只留钩子',
    '- 方案三：借第三个人的口把真相说出来，主角被动接收'
  ].join('\n')
  assert.equal(looksLikeDeliveredProse(plan), false, '方案清单不应识别为正文')

  // 太短 → 不算
  assert.equal(looksLikeDeliveredProse('他把碗放下。'), false, '过短不应识别为正文')

  // 带代码围栏（已含动作块）→ 不算
  assert.equal(looksLikeDeliveredProse(prose + '\n```json\n{"actions":[]}\n```'), false, '已含围栏不应再标记')

  fs.rmSync(tmpData, { recursive: true, force: true })
})

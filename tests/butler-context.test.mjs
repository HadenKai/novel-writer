// 创作管家「上下文充分性」回归测试
//
// 背景：早期实现只把「最近 3 章的摘要 + 结尾 400~900 字」塞进提示词，全书正文实际进入
// 提示词的不到两千字。作者新开会话时对话上下文为空，模型手里几乎没有真实文本，
// 只能凭题材套路瞎续——表现为"新话题不读我的文章"。
//
// 本测试锁定：提示词必须让管家真正读到书。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-butler-ctx-'))
process.env.NOVEL_DATA_DIR = tmpData

const { chatMessages } = await import('../server/ai.mjs')

function buildNovel() {
  // 5 章，每章 900 字（正文各不相同），最后一章要能整章进入提示词
  const mk = (i, word) => ({
    index: i,
    title: `第${i}章标题`,
    content: `第${i}章开头。${word.repeat(300)}第${i}章结尾钩子。`,
    words: 900,
    status: 'done',
    context: {
      summary: `第${i}章摘要：主角推进剧情`,
      endingHook: `第${i}章末尾悬念`,
      source: 'generated',
      updatedAt: 1000 + i
    }
  })
  return {
    id: 'ctx-test',
    title: '上下文测试书',
    genre: '都市',
    pov: 'third',
    chapterCount: 5,
    targetWords: 2000,
    synopsis: '一个关于选择的故事',
    protagonist: { name: '林川', role: '主角' },
    characters: [],
    worldview: '',
    elements: '',
    extraRequirements: '',
    styleProfile: '',
    masterOutline: '起承转合',
    outline: [1, 2, 3, 4, 5].map(i => ({
      index: i,
      title: `第${i}章标题`,
      summary: `第${i}章大纲摘要`,
      customPrompt: ''
    })),
    chapters: [1, 2, 3, 4, 5].map(i => mk(i, '文')),
    plotlines: []
  }
}

test('管家提示词必须包含足够多的真实正文', () => {
  const novel = buildNovel()
  // 模拟「新开会话」：对话历史为空
  const msgs = chatMessages(novel, [])
  const sys = msgs[0].content

  // ---------- 1. 最后一章应整章进入提示词，而不是只剩结尾 ----------
  const last = novel.chapters[4]
  assert.ok(sys.includes(last.content), '最近一章正文应整章进入提示词（而非只剩结尾片段）')

  // ---------- 2. 每一章都应有可读的摘要，不允许「（略）」糊弄 ----------
  assert.ok(sys.includes('【全书章节速览】'), '应有全书章节速览')
  for (const c of novel.chapters) {
    assert.ok(sys.includes(`第${c.index}章《${c.title}》`), `速览应包含第${c.index}章`)
    assert.ok(sys.includes(`第${c.index}章摘要`), `速览应带第${c.index}章的摘要`)
  }
  assert.ok(!sys.includes('：\n（略）'), '大纲摘要不允许再用「（略）」糊弄')

  // ---------- 3. 必须明确告诉模型：新会话也要读正文 ----------
  assert.ok(sys.includes('新开一个会话'), '应提示「新开会话时也要以正文为准」')
  assert.ok(sys.includes('那个"刚才"在你这里是空的'), '应说明新会话里没有对话历史')

  // ---------- 4. 大纲全文都应有摘要（不再只给最近 8 条） ----------
  for (const o of novel.outline) {
    assert.ok(sys.includes(`第${o.index}章大纲摘要`), `大纲第${o.index}章摘要不应被省略`)
  }

  // ---------- 5. 被省略的更早章节要有明示 ----------
  // 5 章 × 900 字 = 4500 字，预算 14000 足够全部装下，因此不应出现省略提示
  assert.ok(!sys.includes('章正文未展开'), '预算充足时不应省略任何一章')
})

test('超长书：预算用尽时明确标注省略，但仍保留最近章节全文', () => {
  const novel = buildNovel()
  // 12 章 × 2600 字 = 31200 字，远超 14000 预算
  novel.outline = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    title: `第${i + 1}章标题`,
    summary: `第${i + 1}章大纲摘要`,
    customPrompt: ''
  }))
  novel.chapters = novel.outline.map(o => ({
    index: o.index,
    title: o.title,
    content: `第${o.index}章开头。${'文'.repeat(2400)}第${o.index}章结尾钩子。`,
    words: 2600,
    status: 'done',
    context: { summary: `第${o.index}章摘要`, endingHook: '', source: 'generated', updatedAt: 1000 + o.index }
  }))

  const sys = chatMessages(novel, [])[0].content
  // 最近一章（第 12 章）应整章在场
  assert.ok(sys.includes(novel.chapters[11].content), '最近一章正文应整章在场')
  // 必须明示还有更早章节被省略，并指路章节速览
  assert.ok(/章正文未展开/.test(sys), '预算不足时应明示省略了多少章')
  // 章节速览仍应覆盖全部 12 章
  for (const c of novel.chapters) {
    assert.ok(sys.includes(`第${c.index}章《${c.title}》`), `速览仍应包含第${c.index}章`)
  }
})

fs.rmSync(tmpData, { recursive: true, force: true })

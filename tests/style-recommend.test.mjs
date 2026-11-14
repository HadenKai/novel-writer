// 分类作家推荐 + 作者笔性×名家自动融合
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHOR_STYLES,
  STYLE_GENRES,
  GENRE_AUTHOR_MAP,
  recommendStyles,
  normalizeGenre,
  resolveStyleId
} from '../server/presets.mjs'
import { chapterMessages, getNovelStyle, authorVoiceSection } from '../server/ai.mjs'

const novel = (over = {}) => ({
  id: 't',
  title: '测试书',
  genre: '玄幻',
  style: '',
  synopsis: '',
  pov: 'third',
  targetWords: 2000,
  chapterCount: 12,
  protagonist: { name: '主角', role: '主角', personality: '', appearance: '', background: '', notes: '' },
  characters: [],
  worldview: '',
  elements: '',
  extraRequirements: '',
  authorStyleId: '',
  templateId: '',
  customPrompt: '',
  skillIds: [],
  plotlines: [],
  masterOutline: '',
  outline: [{ index: 1, title: '第一章', summary: '开场', customPrompt: '', oid: 'o1' }],
  chapters: [
    { index: 1, title: '第一章', content: '正文第一段。\n\n正文第二段。', words: 12, status: 'done', oid: 'o1' }
  ],
  ...over
})

test('12 个分类各配 3 位作家，且 id 全部真实存在', () => {
  assert.equal(STYLE_GENRES.length, 12)
  assert.equal(Object.keys(GENRE_AUTHOR_MAP).length, 12)
  for (const g of STYLE_GENRES) {
    const ids = GENRE_AUTHOR_MAP[g]
    assert.equal(ids.length, 3, `${g} 应有 3 位作家`)
    for (const id of ids) {
      assert.ok(
        AUTHOR_STYLES.some(s => s.id === id && s.prompt),
        `${g} 的作家 ${id} 必须存在且有提示词`
      )
    }
  }
})

test('每位作家都带 genres 与 tags 元数据', () => {
  for (const s of AUTHOR_STYLES) {
    assert.ok(Array.isArray(s.genres) && s.genres.length, `${s.name} 缺 genres`)
    assert.ok(Array.isArray(s.tags) && s.tags.length, `${s.name} 缺 tags`)
  }
})

test('recommendStyles：同分类下不同简介偏向不同作家', () => {
  const shuang = recommendStyles(novel({ genre: '玄幻', title: '斗破', synopsis: '废柴逆袭，修炼升级打脸' }))
  assert.equal(shuang.genre, '玄幻')
  assert.equal(shuang.top, 'tudou', '升级爽感简介应偏向天蚕土豆')
  assert.equal(shuang.picks.length, 3)
  assert.ok(shuang.picks[0].reason.includes('升级爽感'))

  const yanqing = recommendStyles(novel({ genre: '言情', title: '重生之将门毒后', synopsis: '嫡女重生复仇，宅斗权谋' }))
  assert.equal(yanqing.top, 'qianshanchake', '重生复仇简介应偏向千山茶客')

  const kehuan = recommendStyles(novel({ genre: '科幻', title: '三体', synopsis: '宇宙文明存亡' }))
  assert.equal(kehuan.top, 'liucixin')
})

test('recommendStyles：无简介时回落分类代表作家', () => {
  const r = recommendStyles(novel({ genre: '军事', title: '某军事书', synopsis: '' }))
  assert.equal(r.genre, '军事')
  assert.ok(GENRE_AUTHOR_MAP['军事'].includes(r.top))
})

test('normalizeGenre：自由文本归一到 12 类', () => {
  assert.equal(normalizeGenre('玄幻奇幻'), '玄幻')
  assert.equal(normalizeGenre('都市言情'), '都市')
  assert.equal(normalizeGenre('武侠修真'), '仙侠')
  assert.equal(normalizeGenre('科幻灵异'), '科幻')
  assert.equal(normalizeGenre('玄幻'), '玄幻')
  assert.equal(normalizeGenre(''), '')
  assert.equal(normalizeGenre('完全不存在的分类'), '')
})

test('resolveStyleId：auto 走推荐，具体 id 直用，空值不套', () => {
  assert.equal(resolveStyleId(novel({ authorStyleId: 'gulong' })), 'gulong')
  assert.equal(resolveStyleId(novel({ authorStyleId: '' })), '')
  const auto = resolveStyleId(novel({ authorStyleId: 'auto', genre: '科幻', title: '三体', synopsis: '宇宙文明' }))
  assert.equal(auto, 'liucixin')
})

test('getNovelStyle：auto 档解析到推荐作家的完整提示词', () => {
  const s = getNovelStyle(novel({ authorStyleId: 'auto', genre: '悬疑', title: '坏小孩', synopsis: '犯罪推理悬疑' }))
  assert.ok(s && s.prompt)
  assert.equal(s.id, 'zijinchen')
})

test('chapterMessages：自动把作者笔性与名家技法融合（无需手动提炼）', () => {
  // 第 1 章是作者亲笔，写第 2 章时应自动取样第 1 章并与名家融合
  const n = novel({
    authorStyleId: 'tudou',
    chapters: [
      {
        index: 1,
        title: '第一章',
        content: '作者亲笔的独特句子，短句。很有个人风格。',
        words: 20,
        status: 'done',
        oid: 'o1'
      }
    ]
  })
  const msgs = chapterMessages(n, 2, {})
  const user = msgs.find(m => m.role === 'user').content
  assert.ok(user.includes('文风融合'), '应注入自动融合指令')
  assert.ok(user.includes('作者笔性样本'), '应取样作者亲笔正文')
  assert.ok(user.includes('作者亲笔的独特句子'), '样本应来自作者已有章节')
  assert.ok(user.includes('天蚕土豆'), '应同时保留名家技法')
  assert.ok(user.includes('融合，不是用名家腔覆盖作者腔'), '融合而非覆盖')
})

test('chapterMessages：auto 档按题材自动选用作家提示词', () => {
  const msgs = chapterMessages(novel({ authorStyleId: 'auto', genre: '仙侠', synopsis: '凡人修仙，谨慎求生' }), 1, {})
  const user = msgs.find(m => m.role === 'user').content
  assert.ok(user.includes('忘语'), '仙侠凡人流应自动选用忘语')
})

test('authorVoiceSection：无亲笔正文时返回空串（新书只套名家，不硬凑融合）', () => {
  assert.equal(authorVoiceSection(novel({ chapters: [] }), 1), '')
  // 只有当前章、没有更早的章 → 无样本
  assert.equal(authorVoiceSection(novel(), 1), '')
})

test('authorVoiceSection：有亲笔时自动取样并带融合指令', () => {
  const n = novel({
    authorStyleId: 'gulong',
    chapters: [
      { index: 1, title: '第一章', content: '冷。刀更冷。作者的短句风格。', words: 12, status: 'done', oid: 'o1' }
    ]
  })
  const t = authorVoiceSection(n, 2)
  assert.ok(t.includes('作者笔性样本'))
  assert.ok(t.includes('冷。刀更冷。'))
  assert.ok(t.includes('古龙'), '应引用所选名家')
  assert.ok(t.includes('融合'))
})

test('authorVoiceSection：未选名家时仍保持作者语感', () => {
  const n = novel({
    authorStyleId: '',
    chapters: [{ index: 1, title: '第一章', content: '作者自己的叙述腔调。', words: 9, status: 'done', oid: 'o1' }]
  })
  const t = authorVoiceSection(n, 2)
  assert.ok(t.includes('作者笔性'))
  assert.ok(t.includes('保持作者一贯语感'))
})

test('authorVoiceSection：关闭关联前文时不取样前文', () => {
  const n = novel({
    authorStyleId: 'gulong',
    chapters: [{ index: 1, title: '第一章', content: '他转身走入风雪。', words: 8, status: 'done', oid: 'o1' }]
  })
  assert.equal(authorVoiceSection(n, 2, false), '')
  const msgs = chapterMessages(n, 2, { linkContext: false })
  assert.ok(!msgs.find(m => m.role === 'user').content.includes('走入风雪'))
})

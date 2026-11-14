// 动作目录一致性：防止「新增一种管家动作，忘了同步某一处」造成的静默失败。
//
// 一种动作要同时出现在三处：
//   1. server/agent/tools.mjs 的 TOOLS 注册表（分级 / 归类 / text 形态）—— 单一真源
//   2. src/types.ts 的 ChatAction 类型联合（语义定义）
//   3. src/pages/butler/constants.tsx 的 ACTION_META（卡片外观与 payload 美化）
// 漏改第 2/3 处的表现都是「表面上一切正常，但动作静默不生效」，从现象几乎无法定位根因。
// 这个测试把三处对起来，任何一处漏了都会失败并指名道姓。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, ACTION_TIERS, actionHint, TIERS, TEXT_KIND } from '../server/agent/tools.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 取一段文本里的所有单引号标识符字面量 */
const identifiers = s => [...s.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1])

/** 截取源码里从 startPat 匹配处到其后第一个顶格 `}` 之间的内容 */
function block(source, startPat) {
  const i = source.search(startPat)
  assert.ok(i >= 0, `未找到锚点：${startPat}`)
  const j = source.indexOf('\n}', i)
  assert.ok(j > i, `锚点 ${startPat} 之后找不到顶格结束大括号`)
  return source.slice(i, j)
}

/** 取对象字面量里缩进两格的键名 */
const objectKeys = s => [...s.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map(m => m[1])

const typesSrc = read('src/types.ts')
const metaSrc = read('src/pages/butler/constants.tsx')

// 1. 注册表（唯一真源）
const registryKeys = new Set(TOOLS.map(t => t.name))

// 2. ChatAction.type 的联合成员
const chatAction = block(typesSrc, /export interface ChatAction \{/)
const typeUnion = new Set(
  identifiers(chatAction.slice(chatAction.indexOf('type:'), chatAction.indexOf('chapter: number')))
)

// 3. 前端卡片元数据
const metaKeys = new Set(objectKeys(block(metaSrc, /export const ACTION_META: Record</)))

test('动作目录：注册表结构合法（分级 / 归类 / text 形态 / 说明都不缺）', () => {
  assert.ok(TOOLS.length > 40, `注册表只解析到 ${TOOLS.length} 个动作，明显不完整`)
  assert.equal(registryKeys.size, TOOLS.length, '注册表里有重名动作')
  assert.ok(typeUnion.size > 40, `ChatAction 联合只解析到 ${typeUnion.size} 个成员，锚点可能已失效`)

  for (const t of TOOLS) {
    assert.ok(TIERS.includes(t.tier), `${t.name} 的 tier 非法：${t.tier}`)
    assert.ok(Object.values(TEXT_KIND).includes(t.kind), `${t.name} 的 kind 非法：${t.kind}`)
    assert.ok(typeof t.category === 'string' && t.category.length > 0, `${t.name} 缺 category`)
    assert.ok(typeof t.summary === 'string' && t.summary.length > 0, `${t.name} 缺 summary`)
  }
})

test('动作目录：注册表与 ACTION_TIERS 一一对应', () => {
  assert.deepEqual(Object.keys(ACTION_TIERS).sort(), [...registryKeys].sort())
})

test('动作目录：types.ts 的每种动作都在注册表与前端元数据里', () => {
  const noTool = [...typeUnion].filter(t => !registryKeys.has(t))
  assert.deepEqual(noTool, [], `以下动作不在 server/agent/tools.mjs 的注册表里：${noTool.join(', ')}`)

  const noMeta = [...typeUnion].filter(t => !metaKeys.has(t))
  assert.deepEqual(noMeta, [], `以下动作在 ACTION_META 里没有条目，卡片会回落到兜底样式：${noMeta.join(', ')}`)
})

test('动作目录：前端元数据不得包含 ChatAction 之外的动作', () => {
  const extra = [...metaKeys].filter(t => !typeUnion.has(t))
  assert.deepEqual(extra, [], `ACTION_META 里存在 types.ts 未定义的动作：${extra.join(', ')}`)
})

test('动作目录：注册表里超出类型联合的动作需要显式登记', () => {
  // createNovel / styleProfile 由后端支持（管家可能产出），但尚未进入 ChatAction 联合。
  // 显式列出：新增这类「后端独有动作」时测试会失败，提醒确认是否该升级为正式类型
  // （升级后还要同步 ACTION_META，否则上面那条测试会接着报）。
  const BACKEND_ONLY = ['createNovel', 'styleProfile']
  const extra = [...registryKeys].filter(t => !typeUnion.has(t)).sort()
  assert.deepEqual(extra, [...BACKEND_ONLY].sort(), '注册表里出现了未登记的动作，请确认是否加入 ChatAction 类型联合')
})

test('动作目录：自愈回环的形态提示对每种动作都有话说', () => {
  for (const t of TOOLS) {
    const hint = actionHint(t.name)
    if (t.kind === TEXT_KIND.none) {
      // 不需要 text 的动作不给提示，避免回执里塞无用信息
      assert.equal(hint, '', `${t.name} 的 kind 是 none，不该有形态提示`)
    } else {
      assert.ok(hint.length > 0, `${t.name} 缺少 text 形态提示，自愈回环将无法给出有效纠正建议`)
    }
  }
  // 未知动作（老服务端 / 新增未同步）不报错，返回空串
  assert.equal(actionHint('no-such-action'), '')
})

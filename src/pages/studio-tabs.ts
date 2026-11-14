/**
 * 作品工作台的信息架构定义（单一真源）。
 *
 * 这里描述「一本书有几个工作区、每个工作区有哪些子页签」。
 * Studio（工作区壳）、Workspace（设定类工作区）、App（侧栏 / 面包屑 / 快捷键）
 * 都从这里取——改结构只需要动这一个文件。
 */

/** 作品工作台的 5 个工作区 */
export type StudioTab = 'bible' | 'outline' | 'write' | 'refine' | 'book'

export const STUDIO_TABS: { key: StudioTab; label: string }[] = [
  { key: 'write', label: '正文' },
  { key: 'outline', label: '规划' },
  { key: 'bible', label: '设定' },
  { key: 'refine', label: '审校' },
  { key: 'book', label: '导出' }
]

/** 页头面包屑用的工作区名——必须与 STUDIO_TABS 的 label 同名，否则页签叫「规划」、面包屑叫「大纲」 */
export const STUDIO_SECTION: Record<StudioTab, string> = {
  bible: '设定',
  outline: '规划',
  write: '正文',
  refine: '审校',
  book: '导出'
}

export const isStudioTab = (v: string | null): v is StudioTab => !!v && STUDIO_TABS.some(t => t.key === v)

/**
 * 设定类工作区（构思 / 大纲）内部的子页签。
 * 原先 8 个页签平铺在一个页面里，现在按语义归到两个工作区。
 */
export const WORKSPACE_TABS = [
  { key: 'basic', label: '基本信息' },
  { key: 'chars', label: '人物设定' },
  { key: 'master', label: '总纲' },
  { key: 'plot', label: '剧情线' },
  { key: 'outline', label: '章节大纲' },
  { key: 'world', label: '世界观与元素' },
  { key: 'prompt', label: '文风与指令' },
  { key: 'ref', label: '参考作品' }
] as const

export type WorkspaceTabKey = (typeof WORKSPACE_TABS)[number]['key']

export type WorkspacePane = 'bible' | 'outline'

export const PANE_TABS: Record<WorkspacePane, WorkspaceTabKey[]> = {
  bible: ['basic', 'chars', 'world', 'prompt', 'ref'],
  outline: ['master', 'plot', 'outline']
}

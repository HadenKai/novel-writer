/**
 * 桌面端（Electron）通过 preload 暴露的窗口能力；浏览器里为 undefined。
 *
 * 原先这个类型断言在 App / Home / Workspace / ReferenceAnalysisModal 里各写了一遍，
 * 有的写全有的只写 pickFolder。统一到这里，改一处即可。
 */
export interface DesktopAPI {
  pickFolder?: () => Promise<string | null>
  winMinimize?: () => Promise<void>
  winMaximize?: () => Promise<boolean>
  winClose?: () => Promise<void>
  isMaximized?: () => Promise<boolean>
  onMaximized?: (cb: (v: boolean) => void) => () => void
}

/** 取桌面端能力。每次直接读 window，避免缓存到过期引用。 */
export function desktop(): DesktopAPI | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { novelAPI?: DesktopAPI }).novelAPI
}

/** 是否运行在桌面端（Electron 外壳内） */
export function isDesktop(): boolean {
  return !!desktop()
}

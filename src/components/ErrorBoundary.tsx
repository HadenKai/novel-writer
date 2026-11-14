import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * 全局错误边界：任何页面渲染抛错时给出可读兜底，而不是白屏。
 * 「重载」只刷新 renderer（本地数据在服务端进程里，不会丢任务结果）。
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[novel-writer] render error:', error, info.componentStack)
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] p-6">
        <div className="card-surface w-full max-w-md p-6">
          <h1 className="ink-section-title">界面出了点问题</h1>
          <p className="mt-2 text-[12.5px] leading-[1.7] text-[var(--text-dim)]">
            渲染发生异常，但你的书稿与数据都在本地磁盘上，没有丢失。可以重载界面继续；若反复出现，请查看日志。
          </p>
          <pre className="mono mt-3 max-h-28 overflow-y-auto rounded-[9px] bg-[var(--panel2)] p-2.5 text-[11px] leading-[1.6] text-[var(--text-faint)]">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => this.setState({ error: null })} className="btn btn--ghost btn--md">
              重试渲染
            </button>
            <button onClick={() => window.location.reload()} className="btn btn--primary btn--md">
              重载界面
            </button>
          </div>
        </div>
      </div>
    )
  }
}

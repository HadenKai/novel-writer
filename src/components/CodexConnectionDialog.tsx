import { useEffect, useRef, useState } from 'react'
import ModalShell from './ModalShell'
import type { CodexAttemptStatus, CodexDesktopAPI } from '../lib/desktop'
import { describeCodexError } from '../lib/errors'

export default function CodexConnectionDialog({
  codex,
  onClose,
  onConnected
}: {
  codex: CodexDesktopAPI
  onClose: () => void
  onConnected: () => void
}) {
  const [attempt, setAttempt] = useState<CodexAttemptStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const live = useRef(false)
  const attemptId = useRef<string | null>(null)
  const startingLock = useRef(false)
  const complete = useRef(onConnected)
  complete.current = onConnected

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (attemptId.current) void codex.cancel(attemptId.current).catch(() => {})
    }
  }, [codex])

  const pendingId = attempt && ['starting', 'pending', 'retrying'].includes(attempt.state) ? attempt.attemptId : null
  useEffect(() => {
    if (!pendingId) return
    let disposed = false
    let timer = 0
    const poll = async () => {
      try {
        const next = await codex.attempt(pendingId)
        if (disposed || attemptId.current !== pendingId) return
        if (!next) {
          setAttempt(null)
          setError('这次授权已结束，请重新获取设备码。')
          return
        }
        setAttempt(next)
        if (next.state === 'connected') complete.current()
        else if (['starting', 'pending', 'retrying'].includes(next.state)) timer = window.setTimeout(poll, 1000)
      } catch {
        if (disposed) return
        setAttempt(null)
        setError('无法读取授权状态，请重新获取设备码。')
        void codex.cancel(pendingId).catch(() => {})
      }
    }
    timer = window.setTimeout(poll, 1000)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [codex, pendingId])

  const begin = async () => {
    if (startingLock.current) return
    startingLock.current = true
    setStarting(true)
    setError('')
    setNotice('')
    try {
      const next = await codex.start()
      if (!live.current) {
        await codex.cancel(next.attemptId)
        return
      }
      attemptId.current = next.attemptId
      setAttempt(next)
      if (next.state === 'connected') complete.current()
    } catch {
      if (live.current) setError('暂时无法获取设备码，请稍后重试。')
    } finally {
      startingLock.current = false
      if (live.current) setStarting(false)
    }
  }

  const copy = async () => {
    if (!attempt?.userCode) return
    try {
      await navigator.clipboard.writeText(attempt.userCode)
      if (live.current) setNotice('已复制设备码。')
    } catch {
      if (live.current) setNotice('无法复制，可手动选中设备码。')
    }
  }

  const open = async () => {
    if (!attempt?.attemptId) return
    try {
      if (!(await codex.openVerification(attempt.attemptId)) && live.current) setNotice('设备码已失效，请重新获取。')
    } catch {
      if (live.current) setNotice('无法打开验证页面，请检查默认浏览器后重试。')
    }
  }

  const status =
    attempt?.state === 'retrying'
      ? '连接暂时中断，正在重试。'
      : attempt?.state === 'expired'
        ? '设备码已过期。'
        : attempt?.state === 'error'
          ? describeCodexError(attempt.code)
          : attempt?.state === 'cancelled'
            ? '授权已取消。'
            : pendingId
              ? '正在等待你在浏览器中完成授权。'
              : ''

  return (
    <ModalShell title="连接 ChatGPT" width={480} onClose={onClose} busy={starting}>
      <div className="resources-scope resources-form">
        <p className="resources-description">
          获取设备码后，在 OpenAI 官方页面输入验证码并授权。授权成功后，这里会自动更新。
        </p>
        {attempt?.userCode && pendingId && (
          <div className="resources-field">
            <span>一次性设备码</span>
            <p className="resources-notice">
              <strong
                style={{ fontFamily: 'monospace', fontSize: '1.25rem', letterSpacing: '.12em', userSelect: 'all' }}
              >
                {attempt.userCode}
              </strong>
            </p>
            {attempt.expiresAt && (
              <span className="resources-hint">有效至 {new Date(attempt.expiresAt).toLocaleTimeString()}</span>
            )}
            <div className="resources-actions">
              <button type="button" className="resources-button" onClick={copy}>
                复制设备码
              </button>
              <button type="button" className="resources-button" onClick={open}>
                打开官方验证页
              </button>
            </div>
          </div>
        )}
        {(status || notice) && (
          <p className="resources-hint" role="status">
            {[status, notice].filter(Boolean).join(' ')}
          </p>
        )}
        {error && (
          <p className="resources-notice resources-notice--error" role="alert">
            {error}
          </p>
        )}
        <div className="resources-modal-footer">
          <button
            type="button"
            className="resources-button resources-button--quiet"
            disabled={starting}
            onClick={onClose}
          >
            取消
          </button>
          {!pendingId && (
            <button
              type="button"
              className="resources-button resources-button--primary"
              disabled={starting}
              onClick={begin}
            >
              {starting ? '正在获取…' : attempt ? '重新获取设备码' : '获取设备码'}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  )
}

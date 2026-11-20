import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { groupOfModels, hostOf } from '../components/ModelSelect'
import { thinkingShortLabel } from '../lib/constants'
import { reasoningSteps, thinkingValue } from '../lib/thinking'
import { confirmDialog, alertDialog } from '../components/Dialog'
import ModalShell from '../components/ModalShell'
import CodexConnectionDialog from '../components/CodexConnectionDialog'
import CodexUsage from '../components/CodexUsage'
import { desktop, type CodexConnectionStatus } from '../lib/desktop'
import { codexModelStateLabel, describeCodexError } from '../lib/errors'
import type { ModelConfig, ModelProvider } from '../types'
import './resources.css'
import './resources-ink.css'

// 仅提供厂商公开地址；自建服务由用户自行填写。
const QUICK_BASES = [
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }
]
const GEMINI_BASE = { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }
// 本地推理服务的默认地址（与 server/local-models.mjs 的端口保持一致）
const LOCAL_QUICK = [
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' }
]
const LOCAL_CONTEXT_OPTIONS = [8192, 16384, 32768, 65536, 131072]
const catalogSyncMessage = (count: number) =>
  count ? `已同步 ${count} 个账号模型。` : '当前账号的上游目录没有可用模型。'
const catalogRestoreMessage = (count: number) =>
  count ? `已恢复 ${count} 个订阅模型。` : '当前账号没有可恢复的订阅模型。'
const emptyForm = {
  id: '',
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  temperature: 0.8,
  isDefault: false,
  provider: 'openai' as ModelProvider,
  local: false,
  contextTokens: 16384,
  thinkingLevel: 'MEDIUM' as const,
  reasoningEffort: 'default' as const
}
interface ModelGroup {
  key: string
  provider: ModelProvider
  baseUrl: string
  host: string
  label: string
  models: ModelConfig[]
}

function useLiveFlag() {
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  return live
}

function ModelForm({
  initial,
  onDone,
  onCancel,
  onConnectionChanged,
  onAccountChanged
}: {
  initial: ModelConfig | null
  onDone: () => void
  onCancel: () => void
  onConnectionChanged: () => void
  onAccountChanged: () => void
}) {
  const [form, setForm] = useState<ModelConfig>(initial ? { ...initial } : { ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [modelNames, setModelNames] = useState<{ id: string; label: string }[]>([])
  const [fetchMsg, setFetchMsg] = useState('')
  const [error, setError] = useState('')
  const live = useLiveFlag()
  const probeSeq = useRef(0)
  const saveLock = useRef(false)
  const codex = desktop()?.codex
  const subscription = form.provider === 'chatgpt-subscription'
  const [codexStatus, setCodexStatus] = useState<CodexConnectionStatus | null>(null)
  const [showCodex, setShowCodex] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [statusVersion, setStatusVersion] = useState(0)
  const activeRef = codexStatus?.state === 'connected' ? codexStatus.connectionRef : undefined
  const needsDisconnect = codexStatus?.state === 'disconnect-error'
  const connectionRef = form.connectionRef || activeRef
  const needsRebind = Boolean(activeRef && connectionRef && activeRef !== connectionRef)
  const showFields = !subscription || Boolean(initial && connectionRef)
  const effort = thinkingValue(form)
  const effortSteps = reasoningSteps(form)

  useEffect(() => {
    if (!subscription || !codex) return
    let cancelled = false
    void codex.status().then(
      status => {
        if (!cancelled) setCodexStatus(status)
      },
      () => {
        if (!cancelled) setCodexStatus({ state: 'unavailable' })
      }
    )
    return () => {
      cancelled = true
    }
  }, [subscription, codex, statusVersion])

  const patch = (p: Partial<typeof form>) => {
    if ('baseUrl' in p || 'apiKey' in p || 'provider' in p || 'connectionRef' in p) {
      probeSeq.current++
      setFetching(false)
      setModelNames([])
      setFetchMsg('')
    }
    setForm(f => ({
      ...f,
      ...p,
      ...(('model' in p || 'connectionRef' in p || 'provider' in p) && { supportedReasoningEfforts: undefined })
    }))
  }
  const switchProvider = (provider: ModelProvider) => {
    if (provider === form.provider) return
    setError('')
    if (provider === 'chatgpt-subscription') {
      setCodexStatus(null)
      patch({
        provider,
        baseUrl: '',
        apiKey: '',
        local: false,
        model: initial?.provider === provider ? initial.model : '',
        connectionRef: initial?.provider === provider ? initial.connectionRef : undefined
      })
    } else if (provider === 'gemini') {
      patch({
        provider,
        connectionRef: undefined,
        local: false,
        baseUrl: GEMINI_BASE.baseUrl,
        model: form.model || 'gemini-3.8-flash'
      })
    } else {
      patch({ provider, connectionRef: undefined, baseUrl: form.baseUrl === GEMINI_BASE.baseUrl ? '' : form.baseUrl })
    }
  }

  const resetConnectionState = () => {
    probeSeq.current++
    setFetching(false)
    setModelNames([])
    setFetchMsg('')
    setCodexStatus(null)
    setStatusVersion(value => value + 1)
  }

  const disconnect = async () => {
    if (!codex || accountBusy) return
    setAccountBusy(true)
    setError('')
    try {
      await codex.disconnect()
    } catch {
      if (live.current) setError(describeCodexError('CODEX_DISCONNECT_FAILED'))
    } finally {
      onAccountChanged()
      if (live.current) {
        resetConnectionState()
        setAccountBusy(false)
      }
      onConnectionChanged()
    }
  }
  const updateCatalog = async (restoreRef?: string) => {
    const seq = ++probeSeq.current
    setFetching(true)
    setRestoring(Boolean(restoreRef))
    setFetchMsg('')
    setError('')
    try {
      const { count } = restoreRef
        ? await api.restoreSubscriptionModels(restoreRef)
        : await api.syncSubscriptionModels()
      if (live.current && seq === probeSeq.current)
        setFetchMsg(restoreRef ? catalogRestoreMessage(count) : catalogSyncMessage(count))
    } catch (e) {
      if (live.current && seq === probeSeq.current)
        setError(`模型${restoreRef ? '恢复' : '同步'}失败：${(e as Error).message}`)
    } finally {
      if (live.current && seq === probeSeq.current) setFetching(false)
      onConnectionChanged()
    }
  }
  const fetchNames = async () => {
    if (!form.baseUrl.trim() || (!form.apiKey.trim() && !form.local)) return setFetchMsg('请先填写服务地址和 API Key。')
    const seq = ++probeSeq.current
    setFetching(true)
    setFetchMsg('')
    try {
      const r = await api.probeModels(form.baseUrl.trim(), form.apiKey.trim(), form.provider, form.local)
      if (!live.current || seq !== probeSeq.current) return
      if (r.ok && r.models) {
        setModelNames(r.models.map(id => ({ id, label: id })))
        setForm(f => ({ ...f, model: f.model || r.models?.[0] || '' }))
        setFetchMsg(
          r.models.length ? `找到 ${r.models.length} 个模型，可从下方选择。` : '服务未返回模型，可手动填写模型名称。'
        )
      } else setFetchMsg(r.error || '获取失败，请检查连接信息或手动填写模型名称。')
    } catch (e) {
      if (live.current && seq === probeSeq.current) setFetchMsg((e as Error).message)
    } finally {
      if (live.current && seq === probeSeq.current) setFetching(false)
    }
  }
  const save = async () => {
    if (saveLock.current || !showFields) return
    if (subscription) {
      if (!connectionRef || !form.name.trim() || !form.model.trim()) {
        setError('请连接 ChatGPT 并填写显示名称与模型 ID。')
        return
      }
    } else if (
      !form.name.trim() ||
      !form.baseUrl.trim() ||
      !form.model.trim() ||
      (!form.apiKey.trim() && !form.local)
    ) {
      setError('请填写显示名称、服务地址和模型名称（非本地部署还需 API Key）。')
      return
    }
    saveLock.current = true
    setSaving(true)
    setError('')
    try {
      const model = subscription ? { ...form, connectionRef } : form
      if (initial) await api.updateModel(initial.id, model)
      else await api.createModel(model)
      if (live.current) onDone()
    } catch (e) {
      if (live.current) setError((e as Error).message)
    } finally {
      saveLock.current = false
      if (live.current) setSaving(false)
    }
  }
  return (
    <ModalShell
      title={<span className="resources-scope">{initial ? '编辑模型' : '添加模型'}</span>}
      width={600}
      onClose={onCancel}
      busy={saving}
    >
      <form
        className="resources-scope resources-form"
        onSubmit={e => {
          e.preventDefault()
          void save()
        }}
      >
        <p className="resources-description">
          连接 AI 服务后，可在写作或问答中选择模型。手动写作和管理资料不需要配置模型。
        </p>
        <fieldset disabled={saving} className="resources-fields">
          <div className="resources-field">
            <span className="resources-label" id="model-provider-label">
              接入协议
            </span>
            <div className="resources-segmented" role="group" aria-labelledby="model-provider-label">
              <button
                type="button"
                aria-pressed={!subscription && form.provider !== 'gemini'}
                onClick={() => switchProvider('openai')}
              >
                OpenAI 兼容
              </button>
              <button type="button" aria-pressed={form.provider === 'gemini'} onClick={() => switchProvider('gemini')}>
                Google Gemini
              </button>
              {(codex || subscription) && (
                <button
                  type="button"
                  aria-pressed={subscription}
                  onClick={() => switchProvider('chatgpt-subscription')}
                >
                  ChatGPT Subscription
                </button>
              )}
            </div>
            {form.provider === 'gemini' && (
              <p className="resources-hint">使用官方 generateContent 协议，填写 Google API Key。</p>
            )}
            {form.provider === 'openai' && (
              <label className="resources-inline-check">
                <input type="checkbox" checked={!!form.local} onChange={e => patch({ local: e.target.checked })} />
                <span>
                  本地部署（Ollama / LM Studio / llama.cpp / vLLM）
                  <em>本机推理服务不需要 API Key；请求会在同一端点内串行执行，避免互相抢占显存。</em>
                </span>
              </label>
            )}
          </div>
          {subscription && (
            <div className="resources-field">
              <span>ChatGPT 账号 · 实验性</span>
              <div className="resources-actions">
                {codex &&
                  !needsDisconnect &&
                  codexStatus?.state !== 'connected' &&
                  codexStatus?.state !== 'unavailable' && (
                    <button
                      type="button"
                      className="resources-button"
                      onClick={() => setShowCodex(true)}
                      disabled={!codexStatus || accountBusy}
                    >
                      {codexStatus?.state === 'reconnect' ? '重新连接 ChatGPT' : '连接 ChatGPT'}
                    </button>
                  )}
                {activeRef && (
                  <>
                    <button
                      type="button"
                      className="resources-button"
                      onClick={() => void updateCatalog()}
                      disabled={fetching || accountBusy}
                    >
                      {fetching && !restoring ? '同步中…' : '同步模型'}
                    </button>
                    <button
                      type="button"
                      className="resources-button resources-button--quiet"
                      onClick={() => void updateCatalog(activeRef)}
                      disabled={fetching || accountBusy}
                    >
                      {fetching && restoring ? '恢复中…' : '恢复已删除模型'}
                    </button>
                  </>
                )}
                {(activeRef || needsDisconnect) && (
                  <button
                    type="button"
                    className="resources-button resources-button--quiet"
                    onClick={disconnect}
                    disabled={accountBusy || fetching}
                  >
                    {accountBusy ? '正在断开…' : needsDisconnect ? '重试断开连接' : '断开连接'}
                  </button>
                )}
                {needsRebind && (
                  <button
                    type="button"
                    className="resources-button"
                    onClick={() => patch({ connectionRef: activeRef })}
                  >
                    绑定到当前账号
                  </button>
                )}
              </div>
              <p className="resources-hint" role="status">
                {!codex || codexStatus?.state === 'unavailable'
                  ? describeCodexError('CODEX_UNAVAILABLE')
                  : !codexStatus
                    ? '正在读取连接状态…'
                    : needsDisconnect
                      ? describeCodexError('CODEX_DISCONNECT_FAILED')
                      : needsRebind
                        ? '此模型绑定了其他账号或工作区。保存前可选择改绑。'
                        : activeRef
                          ? `已连接 ${codexStatus.label || 'ChatGPT'}`
                          : codexStatus.state === 'reconnect'
                            ? describeCodexError('CODEX_RECONNECT')
                            : '连接后，上游模型会自动加入 ChatGPT Subscription 分组。'}
              </p>
              {(fetching || fetchMsg) && (
                <p className="resources-hint" role="status">
                  {fetching ? (restoring ? '正在恢复订阅模型…' : '正在从 ChatGPT 同步模型…') : fetchMsg}
                </p>
              )}
            </div>
          )}
          {showFields && (
            <>
              <label className="resources-field">
                显示名称
                <input
                  value={form.name}
                  onChange={e => patch({ name: e.target.value })}
                  placeholder="例如：日常写作 · DeepSeek"
                  autoComplete="off"
                />
              </label>
              <label className="resources-inline-check">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={event => patch({ isDefault: event.target.checked })}
                />
                <span>设为全局默认模型</span>
              </label>
              {!subscription && (
                <>
                  <label className="resources-field">
                    服务地址 · API Base URL
                    <input
                      value={form.baseUrl}
                      onChange={e => patch({ baseUrl: e.target.value })}
                      placeholder="https://你的服务地址（兼容接口自动补 /v1）"
                      spellCheck={false}
                    />
                  </label>
                  <div className="resources-quick-links" aria-label="常用服务地址">
                    {(form.provider === 'gemini' ? [GEMINI_BASE] : form.local ? LOCAL_QUICK : QUICK_BASES).map(q => (
                      <button
                        type="button"
                        key={q.name}
                        aria-pressed={form.baseUrl === q.baseUrl}
                        onClick={() => patch({ baseUrl: q.baseUrl })}
                      >
                        {q.name}
                      </button>
                    ))}
                  </div>
                  {form.local ? (
                    <div className="resources-field">
                      <span id="local-ctx-label">上下文窗口</span>
                      <div className="resources-segmented" role="group" aria-labelledby="local-ctx-label">
                        {LOCAL_CONTEXT_OPTIONS.map(n => (
                          <button
                            type="button"
                            key={n}
                            aria-pressed={Number(form.contextTokens) === n}
                            onClick={() => patch({ contextTokens: n })}
                          >
                            {n / 1024}k
                          </button>
                        ))}
                      </div>
                      <p className="resources-hint">
                        按本地模型实际支持的上下文选择。写作时提示词会按这个上限裁剪，填太大反而会被服务端截断。
                      </p>
                    </div>
                  ) : (
                    <label className="resources-field">
                      API Key
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={form.apiKey}
                        onChange={e => patch({ apiKey: e.target.value })}
                        placeholder="填写服务商提供的密钥"
                      />
                      {initial && form.apiKey.includes('****') && (
                        <span className="resources-hint">密钥已保存。保留掩码即不修改；更换时输入新密钥。</span>
                      )}
                    </label>
                  )}
                </>
              )}
              <div className="resources-field">
                <label htmlFor="settings-model-name">{subscription ? '模型 ID' : '模型名称'}</label>
                <div className="resources-input-action">
                  <input
                    id="settings-model-name"
                    value={form.model}
                    onChange={e => patch({ model: e.target.value })}
                    placeholder={
                      subscription
                        ? '填写订阅模型 ID'
                        : form.provider === 'gemini'
                          ? 'gemini-3.8-flash'
                          : 'gpt-4o / deepseek-chat'
                    }
                  />
                  {!subscription && (
                    <button type="button" className="resources-button" onClick={fetchNames} disabled={fetching}>
                      {fetching ? '获取中…' : '获取列表'}
                    </button>
                  )}
                </div>
                {!subscription && fetchMsg && (
                  <p className="resources-hint" role="status">
                    {fetchMsg}
                  </p>
                )}
                {modelNames.length > 0 && (
                  <div className="resources-model-options" role="group" aria-label="可用模型">
                    {modelNames.map(n => (
                      <button
                        type="button"
                        key={n.id}
                        aria-pressed={form.model === n.id}
                        onClick={() => patch({ model: n.id })}
                        title={n.id}
                      >
                        {n.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {form.provider === 'gemini' ? (
                <div className="resources-field">
                  <span id="thinking-label">思考等级</span>
                  <div className="resources-segmented" role="group" aria-labelledby="thinking-label">
                    {(['LOW', 'MEDIUM', 'HIGH'] as const).map(level => (
                      <button
                        type="button"
                        key={level}
                        aria-pressed={(form.thinkingLevel || 'MEDIUM') === level}
                        onClick={() => patch({ thinkingLevel: level })}
                      >
                        {level === 'LOW' ? '低' : level === 'HIGH' ? '高' : '中'}
                      </button>
                    ))}
                  </div>
                  <p className="resources-hint">
                    Gemini 3.x 使用思考等级代替 temperature；等级越高，思考耗时通常越长。
                  </p>
                </div>
              ) : (
                <>
                  <div className="resources-field">
                    <span id="reasoning-label">思考强度 · Reasoning Effort</span>
                    <div className="resources-segmented" role="group" aria-labelledby="reasoning-label">
                      {effortSteps.map(step => (
                        <button
                          type="button"
                          key={step.value}
                          aria-pressed={effort === step.value}
                          onClick={() => patch({ reasoningEffort: step.value })}
                        >
                          {step.label}
                        </button>
                      ))}
                    </div>
                    <p className="resources-hint">
                      {subscription
                        ? '可用档位由上游模型目录决定。'
                        : '默认不发送 reasoning_effort 参数，其余选项由兼容服务决定是否支持。'}
                    </p>
                  </div>
                  {!subscription && (
                    <label className="resources-field">
                      创造性 · Temperature {form.temperature}
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        value={form.temperature}
                        onChange={e => patch({ temperature: Number(e.target.value) })}
                      />
                    </label>
                  )}
                </>
              )}
            </>
          )}
        </fieldset>
        {error && (
          <p className="resources-notice resources-notice--error" role="alert">
            {error}
          </p>
        )}
        <div className="resources-modal-footer">
          <button
            type="button"
            className="resources-button resources-button--quiet"
            onClick={onCancel}
            disabled={saving}
          >
            {showFields ? '取消' : '关闭'}
          </button>
          {showFields && (
            <button
              type="submit"
              className="resources-button resources-button--primary"
              disabled={saving || accountBusy}
            >
              {saving ? '保存中…' : '保存模型'}
            </button>
          )}
        </div>
      </form>
      {showCodex && codex && (
        <CodexConnectionDialog
          codex={codex}
          onClose={() => setShowCodex(false)}
          onConnected={() => {
            setShowCodex(false)
            resetConnectionState()
            onAccountChanged()
            void updateCatalog()
          }}
        />
      )}
    </ModalShell>
  )
}

function ImportDialog({ onImported, onCancel }: { onImported: () => void; onCancel: () => void }) {
  const [provider, setProvider] = useState<ModelProvider>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [ok, setOk] = useState(false)
  const live = useLiveFlag()
  const lock = useRef(false)
  const switchProvider = (p: ModelProvider) => {
    setMsg('')
    setProvider(p)
    setBaseUrl(p === 'gemini' ? GEMINI_BASE.baseUrl : cur => (cur === GEMINI_BASE.baseUrl ? '' : cur))
  }
  const run = async () => {
    if (lock.current || ok) return
    if (!baseUrl.trim() || !apiKey.trim()) return setMsg('请填写服务地址和 API Key。')
    lock.current = true
    setBusy(true)
    setMsg('')
    try {
      const r = await api.importModels(baseUrl.trim(), apiKey.trim(), provider)
      if (!live.current) return
      setOk(true)
      setMsg(`导入完成：新增 ${r.added ?? 0} 个模型${r.skipped ? `，跳过 ${r.skipped} 个重复` : ''}。`)
      onImported()
    } catch (e) {
      if (live.current) setMsg((e as Error).message)
    } finally {
      lock.current = false
      if (live.current) setBusy(false)
    }
  }
  return (
    <ModalShell
      title={<span className="resources-scope">从服务导入模型</span>}
      width={540}
      onClose={onCancel}
      busy={busy}
    >
      <form
        className="resources-scope resources-form"
        onSubmit={e => {
          e.preventDefault()
          void run()
        }}
      >
        <p className="resources-description">
          读取服务商提供的可用模型，重复项会自动跳过。不支持列表接口时，可改用「添加模型」手动填写。
        </p>
        <fieldset className="resources-fields" disabled={busy || ok}>
          <div className="resources-segmented" role="group" aria-label="接入协议">
            <button type="button" aria-pressed={provider !== 'gemini'} onClick={() => switchProvider('openai')}>
              OpenAI 兼容
            </button>
            <button type="button" aria-pressed={provider === 'gemini'} onClick={() => switchProvider('gemini')}>
              Google Gemini
            </button>
          </div>
          <label className="resources-field">
            服务地址 · API Base URL
            <input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://你的服务地址"
              spellCheck={false}
            />
          </label>
          <div className="resources-quick-links" aria-label="常用服务地址">
            {(provider === 'gemini' ? [GEMINI_BASE] : QUICK_BASES).map(q => (
              <button
                type="button"
                key={q.name}
                aria-pressed={baseUrl === q.baseUrl}
                onClick={() => setBaseUrl(q.baseUrl)}
              >
                {q.name}
              </button>
            ))}
          </div>
          <label className="resources-field">
            API Key
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="填写服务商提供的密钥"
            />
          </label>
          {provider === 'gemini' && (
            <p className="resources-hint">
              导入 Gemini 3.x 可用模型，也可能包含图片、视频模型。不需要的模型可在导入后删除。
            </p>
          )}
        </fieldset>
        {msg && (
          <p className={`resources-notice ${ok ? '' : 'resources-notice--error'}`} role={ok ? 'status' : 'alert'}>
            {msg}
          </p>
        )}
        <div className="resources-modal-footer">
          {ok ? (
            <button type="button" className="resources-button resources-button--primary" onClick={onCancel}>
              完成
            </button>
          ) : (
            <>
              <button
                type="button"
                className="resources-button resources-button--quiet"
                onClick={onCancel}
                disabled={busy}
              >
                取消
              </button>
              <button type="submit" className="resources-button resources-button--primary" disabled={busy}>
                {busy ? '导入中…' : '开始导入'}
              </button>
            </>
          )}
        </div>
      </form>
    </ModalShell>
  )
}

/**
 * 本地模型：扫描本机常见推理服务 → 勾选模型 → 一次加入。
 * 不要求密钥，也允许手动输入一个非默认端口的地址再探测。
 */
function LocalModelDialog({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [scanning, setScanning] = useState(true)
  const [found, setFound] = useState<
    { baseUrl: string; runtime?: string; models: string[]; latencyMs?: number; hint?: string; error?: string }[]
  >([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState('')
  const [contextTokens, setContextTokens] = useState(16384)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const live = useLiveFlag()

  const keyOf = (baseUrl: string, model: string) => `${baseUrl}\u0000${model}`

  const scan = async (extra: string[] = []) => {
    setScanning(true)
    setError('')
    try {
      const r = await api.scanLocalModels(extra)
      if (!live.current) return
      setFound(prev => {
        // 手动探测的地址可能与预设重复：以最新结果为准
        const map = new Map(prev.map(f => [f.baseUrl, f]))
        for (const f of r.found || []) map.set(f.baseUrl, f)
        return [...map.values()]
      })
      // 扫描到的模型默认全选：多数人就是想把本机模型一次加完
      setSelected(prev => {
        const next = new Set(prev)
        for (const f of r.found || []) for (const m of f.models || []) next.add(keyOf(f.baseUrl, m))
        return next
      })
      if (!(r.found || []).length) {
        // 空状态本身已经写了「没发现服务 + 怎么启动」，这里只在手动探测失败时补充说明
        setMsg(extra.length ? '这个地址没有响应。确认服务已启动，并填写到 /v1 这一层。' : '')
      } else setMsg('')
    } catch (e) {
      if (live.current) setError((e as Error).message)
    } finally {
      if (live.current) setScanning(false)
    }
  }

  useEffect(() => {
    void scan()
    // 只在打开时扫一次；后续由「重新扫描」按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const addSelected = async () => {
    if (busy || !selected.size) return
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const byBase = new Map<string, string[]>()
      for (const key of selected) {
        const [baseUrl, model] = key.split('\u0000')
        if (!baseUrl || !model) continue
        const arr = byBase.get(baseUrl) || []
        arr.push(model)
        byBase.set(baseUrl, arr)
      }
      let added = 0
      let skipped = 0
      for (const [baseUrl, models] of byBase) {
        const r = await api.addLocalModels(baseUrl, models, contextTokens)
        added += r.added || 0
        skipped += r.skipped || 0
      }
      if (!live.current) return
      setMsg(`已加入 ${added} 个本地模型${skipped ? `，跳过 ${skipped} 个已存在` : ''}。`)
      onDone()
    } catch (e) {
      if (live.current) setError((e as Error).message)
    } finally {
      if (live.current) setBusy(false)
    }
  }

  return (
    <ModalShell
      title={<span className="resources-scope">接入本地模型</span>}
      width={640}
      onClose={onCancel}
      busy={busy}
    >
      <div className="resources-scope resources-form">
        <p className="resources-description">
          自动扫描本机的 Ollama、LM Studio、llama.cpp、vLLM 等服务；模型只在本机运行，不联网、不需要 API Key。
        </p>

        <div className="resources-local-bar">
          <button type="button" className="resources-button" disabled={scanning} onClick={() => void scan()}>
            {scanning ? '扫描中…' : '重新扫描'}
          </button>
          <div className="resources-input-action">
            <input
              value={custom}
              onChange={e => setCustom(e.target.value)}
              placeholder="手动地址，例如 http://127.0.0.1:11434/v1"
              spellCheck={false}
              aria-label="手动探测地址"
            />
            <button
              type="button"
              className="resources-button"
              disabled={scanning || !custom.trim()}
              onClick={() => void scan([custom.trim()])}
            >
              探测
            </button>
          </div>
        </div>

        {found.length > 0 ? (
          <div className="resources-local-list">
            {found.map(f => (
              <section key={f.baseUrl} className="resources-local-item">
                <header>
                  <strong>{f.runtime || '本地服务'}</strong>
                  <span className="resources-row-detail">{f.baseUrl}</span>
                  {typeof f.latencyMs === 'number' && <span className="resources-count">{f.latencyMs}ms</span>}
                </header>
                {f.models.length ? (
                  <div
                    className="resources-model-options"
                    role="group"
                    aria-label={`${f.runtime || '本地服务'} 的模型`}
                  >
                    {f.models.map(m => (
                      <button
                        type="button"
                        key={m}
                        aria-pressed={selected.has(keyOf(f.baseUrl, m))}
                        onClick={() => toggle(keyOf(f.baseUrl, m))}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="resources-hint">{f.error || '服务在线，但没有已加载的模型。'}</p>
                )}
                {f.hint && <p className="resources-hint">{f.hint}</p>}
              </section>
            ))}
          </div>
        ) : (
          !scanning && (
            <div className="resources-empty resources-empty--compact">
              <h3>还没发现本地服务</h3>
              <p>
                以 Ollama 为例：安装后执行 <code>ollama serve</code>，再 <code>ollama pull qwen2.5:7b</code>，
                然后回到这里点「重新扫描」。
              </p>
            </div>
          )
        )}

        <div className="resources-field">
          <span id="local-add-ctx">上下文窗口</span>
          <div className="resources-segmented" role="group" aria-labelledby="local-add-ctx">
            {LOCAL_CONTEXT_OPTIONS.map(n => (
              <button type="button" key={n} aria-pressed={contextTokens === n} onClick={() => setContextTokens(n)}>
                {n / 1024}k
              </button>
            ))}
          </div>
          <p className="resources-hint">按模型实际能力选择；写整章时提示词会按这个上限裁剪。</p>
        </div>

        {msg && (
          <p className={`resources-notice ${/已加入/.test(msg) ? '' : 'resources-notice--error'}`} role="status">
            {msg}
          </p>
        )}
        {error && (
          <p className="resources-notice resources-notice--error" role="alert">
            {error}
          </p>
        )}

        <div className="resources-modal-footer">
          <span className="resources-hint">已选 {selected.size} 个模型</span>
          <div className="resources-actions">
            <button
              type="button"
              className="resources-button resources-button--quiet"
              onClick={onCancel}
              disabled={busy}
            >
              关闭
            </button>
            <button
              type="button"
              className="resources-button resources-button--primary"
              disabled={busy || !selected.size}
              onClick={() => void addSelected()}
            >
              {busy ? '加入中…' : '加入选中模型'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

export default function SettingsPage() {
  const codex = desktop()?.codex
  const [usageVersion, setUsageVersion] = useState(0)
  const [models, setModels] = useState<ModelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<ModelConfig | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showLocal, setShowLocal] = useState(false)
  const [testing, setTesting] = useState('')
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [modelBusy, setModelBusy] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [groupMsg, setGroupMsg] = useState<Record<string, string>>({})
  const [groupErr, setGroupErr] = useState<Record<string, string>>({})
  const [renameKey, setRenameKey] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [storage, setStorage] = useState<{ dir: string; relocated: string } | null>(null)
  const [storageLoading, setStorageLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [backupBusy, setBackupBusy] = useState('')
  const [backupMsg, setBackupMsg] = useState('')
  const [backupErr, setBackupErr] = useState('')
  const restoreRef = useRef<HTMLInputElement>(null)
  const live = useLiveFlag()
  const loadGen = useRef(0)
  const storageGen = useRef(0)
  const modelLock = useRef(false)
  const testLock = useRef(false)
  const backupLock = useRef(false)

  const load = async () => {
    if (!live.current) return
    const gen = ++loadGen.current
    setLoading(true)
    setLoadError('')
    try {
      const list = await api.getModels()
      if (live.current && gen === loadGen.current) {
        setModels(list)
        setSelected(prev => new Set([...prev].filter(id => list.some(m => m.id === id))))
      }
    } catch (e) {
      if (live.current && gen === loadGen.current) setLoadError((e as Error).message)
    } finally {
      if (live.current && gen === loadGen.current) setLoading(false)
    }
  }
  const loadStorage = async () => {
    const gen = ++storageGen.current
    setStorageLoading(true)
    setStorageError('')
    try {
      const s = await api.getSettings()
      if (live.current && gen === storageGen.current) setStorage(s.storage || null)
    } catch (e) {
      if (live.current && gen === storageGen.current) setStorageError((e as Error).message)
    } finally {
      if (live.current && gen === storageGen.current) setStorageLoading(false)
    }
  }
  useEffect(() => {
    const generations = [loadGen, storageGen]
    void load()
    void loadStorage()
    return () => {
      generations.forEach(generation => {
        generation.current++
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addModel = () => {
    setEditing(null)
    setShowForm(true)
  }
  const test = async (m: ModelConfig) => {
    if (testLock.current) return
    testLock.current = true
    setTesting(m.id)
    setTestResult(t => ({ ...t, [m.id]: { ok: true, text: '正在测试连接…' } }))
    try {
      const r = await api.testModel(m.id)
      if (live.current)
        setTestResult(t => ({
          ...t,
          [m.id]: r.ok
            ? { ok: true, text: `连接正常：${r.reply}` }
            : { ok: false, text: r.error || '连接失败，请检查地址、密钥和模型名称。' }
        }))
    } catch (e) {
      if (live.current) setTestResult(t => ({ ...t, [m.id]: { ok: false, text: (e as Error).message } }))
    } finally {
      testLock.current = false
      if (live.current) setTesting('')
    }
  }
  const removeModels = async (ids: string[], title: string, single = false) => {
    if (!ids.length || modelLock.current) return
    modelLock.current = true
    try {
      const deletedIds = new Set(ids)
      const modelsToDelete = models.filter(model => deletedIds.has(model.id))
      const instructions = ['使用这些模型的作品需要重新选择模型。']
      if (modelsToDelete.some(model => model.provider === 'chatgpt-subscription')) {
        instructions.push('订阅模型可在「添加模型 → ChatGPT Subscription」中恢复。')
      }
      if (modelsToDelete.some(model => model.provider !== 'chatgpt-subscription')) {
        instructions.push('其他模型删除后可重新添加。')
      }
      const ok = await confirmDialog({
        title,
        body: instructions.join('\n'),
        confirmText: '删除模型',
        danger: true
      })
      if (!ok || !live.current) return
      setModelBusy('delete')
      if (single) await api.deleteModel(ids[0])
      else await api.batchDeleteModels(ids)
      if (!live.current) return
      setSelected(new Set())
      await load()
    } catch (e) {
      if (live.current) void alertDialog({ title: '删除失败', body: (e as Error).message, tone: 'error' })
    } finally {
      modelLock.current = false
      if (live.current) setModelBusy('')
    }
  }
  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleGroup = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const refreshGroup = async (g: ModelGroup, restoreRef?: string) => {
    if (modelLock.current) return
    modelLock.current = true
    setModelBusy(restoreRef ? `restore:${g.key}` : g.key)
    setGroupErr(prev => ({ ...prev, [g.key]: '' }))
    setGroupMsg(prev => ({ ...prev, [g.key]: '' }))
    try {
      const message = restoreRef
        ? catalogRestoreMessage((await api.restoreSubscriptionModels(restoreRef)).count)
        : g.provider === 'chatgpt-subscription'
          ? catalogSyncMessage((await api.syncSubscriptionModels()).count)
          : await api
              .importGroupModels(g.baseUrl)
              .then(r => `导入完成：新增 ${r.added ?? 0} 个模型${r.skipped ? `，跳过 ${r.skipped} 个重复` : ''}。`)
      if (!live.current) return
      setGroupMsg(prev => ({ ...prev, [g.key]: message }))
      await load()
    } catch (e) {
      if (live.current) setGroupErr(prev => ({ ...prev, [g.key]: (e as Error).message }))
    } finally {
      modelLock.current = false
      if (live.current) setModelBusy('')
    }
  }
  const saveRename = async (g: ModelGroup) => {
    if (modelLock.current || renameKey !== g.key) return
    if (renameDraft.trim() === g.label) return setRenameKey('')
    modelLock.current = true
    setModelBusy('rename')
    try {
      await api.renameStation(g.baseUrl, renameDraft.trim(), g.provider)
      if (!live.current) return
      setRenameKey('')
      await load()
    } catch (e) {
      if (live.current) void alertDialog({ title: '重命名失败', body: (e as Error).message, tone: 'error' })
    } finally {
      modelLock.current = false
      if (live.current) setModelBusy('')
    }
  }
  const exportBackup = async () => {
    if (backupLock.current) return
    backupLock.current = true
    setBackupBusy('export')
    setBackupMsg('')
    setBackupErr('')
    try {
      const { blob, filename } = await api.downloadBackup()
      if (!live.current) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 下载启动后延迟释放，即使离开页面也要让浏览器完成读取。
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      setBackupMsg(`已准备下载 ${filename}（${(blob.size / 1024 / 1024).toFixed(1)} MB），请妥善保存到其他磁盘。`)
    } catch (e) {
      if (live.current) setBackupErr((e as Error).message)
    } finally {
      backupLock.current = false
      if (live.current) setBackupBusy('')
    }
  }
  const pickBackup = async (file: File) => {
    if (backupLock.current) return
    setBackupMsg('')
    setBackupErr('')
    if (file.size > 512 * 1024 * 1024) return setBackupErr('文件超过 512 MB，请使用较小的备份，避免界面内存占用过高。')
    backupLock.current = true
    setBackupBusy('restore')
    try {
      let data: unknown
      try {
        data = JSON.parse(await file.text())
      } catch {
        throw new Error('文件不是有效的 JSON，请选择由「导出备份」生成的 .json 文件。')
      }
      if (!live.current) return
      const novels = (data as { novels?: unknown[] } | null)?.novels
      if (!Array.isArray(novels)) throw new Error('备份文件格式不正确：缺少 novels 列表。')
      const ok = await confirmDialog({
        title: '确定要恢复这份备份？',
        body: `将导入 ${novels.length} 本作品，相同 ID 的作品会被备份版本覆盖，其他作品保留，当前模型设置不受影响。\n恢复前系统会自动把当前作品、版本历史与对话另存为一份「恢复前快照」。`,
        confirmText: '开始恢复',
        danger: true
      })
      if (!ok || !live.current) return
      const r = await api.restoreBackup(data)
      if (live.current) setBackupMsg(`恢复完成：共导入 ${r.restored} 本作品，刷新页面即可看到。`)
    } catch (e) {
      if (live.current) setBackupErr((e as Error).message)
    } finally {
      backupLock.current = false
      if (live.current) setBackupBusy('')
    }
  }
  const groups: ModelGroup[] = groupOfModels(models).map(g => ({
    ...g,
    host: hostOf(g.baseUrl),
    provider: g.provider as ModelProvider
  }))
  const modelDisabled = !!modelBusy || !!testing

  return (
    <div className="resources-scope resources-page resources-settings">
      <header className="resources-page-header">
        <div>
          <h1>设置</h1>
          <p>管理 AI 连接与作品备份，让创作按你的方式进行。</p>
        </div>
      </header>
      <nav className="resources-section-nav" aria-label="设置分区">
        <a href="#settings-models">AI 模型</a>
        <a href="#settings-backup">备份与恢复</a>
        <a href="#settings-storage">数据位置</a>
      </nav>
      <section id="settings-models" className="resources-section" aria-labelledby="settings-models-title">
        <div className="resources-section-header">
          <div>
            <h2 id="settings-models-title">AI 模型</h2>
            <p>仅 AI 生成、润色与问答需要模型。未配置时，仍可写作、整理素材和检索文档。</p>
          </div>
          <div className="resources-actions">
            {batchMode ? (
              <button
                className="resources-button"
                disabled={modelDisabled}
                onClick={() => {
                  setBatchMode(false)
                  setSelected(new Set())
                }}
              >
                完成管理
              </button>
            ) : (
              <>
                {models.length > 0 && (
                  <button
                    className="resources-button resources-button--quiet"
                    disabled={modelDisabled}
                    onClick={() => setBatchMode(true)}
                  >
                    批量管理
                  </button>
                )}
                <button className="resources-button" disabled={modelDisabled} onClick={() => setShowLocal(true)}>
                  本地模型
                </button>
                <button className="resources-button" disabled={modelDisabled} onClick={() => setShowImport(true)}>
                  从服务导入
                </button>
                <button
                  className="resources-button resources-button--primary"
                  disabled={modelDisabled}
                  onClick={addModel}
                >
                  添加模型
                </button>
              </>
            )}
          </div>
        </div>
        <p className="resources-hint resources-section-note">
          按服务站点管理连接。在每本作品或 AI 任务中明确选择模型；已保存的密钥以掩码显示，并尽量使用系统安全存储。
        </p>
        {loadError && (
          <div className="resources-notice resources-notice--error" role="alert">
            <span>模型加载失败：{loadError}</span>
            <button className="resources-button" onClick={load}>
              重试
            </button>
          </div>
        )}
        {loading && (
          <p className="resources-status" role="status">
            正在读取模型连接…
          </p>
        )}
        {!loading && !loadError && models.length === 0 ? (
          <div className="resources-empty">
            <h3>为 AI 功能连接一个模型</h3>
            <p>已有服务地址和密钥？添加单个模型，或一次导入服务中的可用模型。也可以稍后再设置。</p>
            <button className="resources-button resources-button--primary" onClick={addModel}>
              添加第一个模型
            </button>
          </div>
        ) : batchMode && models.length > 0 ? (
          <div className="resources-surface">
            <div className="resources-batch-bar">
              <div className="resources-actions">
                <button
                  className="resources-button resources-button--quiet"
                  disabled={modelDisabled}
                  onClick={() =>
                    setSelected(selected.size === models.length ? new Set() : new Set(models.map(m => m.id)))
                  }
                >
                  {selected.size === models.length ? '取消全选' : '全选'}
                </button>
                <span className="resources-hint">
                  已选 {selected.size} / {models.length}
                </span>
              </div>
              <div className="resources-actions">
                <button
                  className="resources-button resources-button--danger"
                  disabled={!selected.size || modelDisabled}
                  onClick={() => removeModels([...selected], `删除选中的 ${selected.size} 个模型？`)}
                >
                  {modelBusy === 'delete' ? '删除中…' : '删除选中'}
                </button>
                <button
                  className="resources-button resources-button--quiet resources-button--danger"
                  disabled={modelDisabled}
                  onClick={() =>
                    removeModels(
                      models.map(m => m.id),
                      `删除全部 ${models.length} 个模型？`
                    )
                  }
                >
                  全部删除
                </button>
              </div>
            </div>
            {models.map(m => (
              <label key={m.id} className="resources-batch-row">
                <input
                  type="checkbox"
                  checked={selected.has(m.id)}
                  disabled={modelDisabled}
                  onChange={() => toggleSelect(m.id)}
                />
                <span>
                  <strong>{m.name}</strong>
                  <span className="resources-row-detail">
                    {m.model} · {m.baseUrl} · {m.local ? '本地部署' : `思考 ${thinkingShortLabel(m)}`}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="resources-stations">
            {groups.map((g, index) => {
              const open = !collapsed.has(g.key)
              const showUsage = g.provider === 'chatgpt-subscription' && Boolean(codex?.getUsage)
              const activeSubscriptionRef = g.models.find(
                model => model.connectionState === 'connected' || model.connectionState === 'catalog-missing'
              )?.connectionRef
              return (
                <section key={g.key} className="resources-station">
                  <div className="resources-station-header">
                    <div
                      className={`resources-station-identity${showUsage ? ' resources-station-identity--usage' : ''}`}
                    >
                      <button
                        className="resources-station-toggle"
                        aria-expanded={open}
                        aria-controls={`station-models-${index}`}
                        onClick={() => toggleGroup(g.key)}
                      >
                        <span className="resources-chevron" aria-hidden="true">
                          {open ? '⌄' : '›'}
                        </span>
                        <span>
                          <strong>{g.label}</strong>
                          {g.baseUrl && <span className="resources-row-detail">{g.baseUrl}</span>}
                        </span>
                      </button>
                      {showUsage && codex && <CodexUsage key={usageVersion} codex={codex} />}
                    </div>
                    <span className="resources-count">
                      {g.models.length} 个模型 ·{' '}
                      {g.provider === 'chatgpt-subscription'
                        ? '订阅'
                        : g.provider === 'gemini'
                          ? 'Gemini'
                          : g.models.every(m => m.local)
                            ? '本地部署'
                            : 'OpenAI 兼容'}
                    </span>
                    <div className="resources-actions">
                      {g.provider === 'chatgpt-subscription' ? (
                        <>
                          <button className="resources-button" disabled={modelDisabled} onClick={() => refreshGroup(g)}>
                            {modelBusy === g.key ? '同步中…' : '同步模型'}
                          </button>
                          {activeSubscriptionRef && (
                            <button
                              className="resources-button resources-button--quiet"
                              disabled={modelDisabled}
                              onClick={() => refreshGroup(g, activeSubscriptionRef)}
                            >
                              {modelBusy === `restore:${g.key}` ? '恢复中…' : '恢复已删除模型'}
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            className="resources-button resources-button--quiet"
                            disabled={modelDisabled}
                            onClick={() => {
                              setRenameKey(g.key)
                              setRenameDraft(g.label)
                            }}
                          >
                            重命名
                          </button>
                          <button
                            className="resources-button"
                            disabled={modelDisabled}
                            title="使用本站已保存的密钥，仅补充新模型"
                            onClick={() => refreshGroup(g)}
                          >
                            {modelBusy === g.key ? '导入中…' : '导入新模型'}
                          </button>
                        </>
                      )}
                      <button
                        className="resources-button resources-button--quiet resources-button--danger"
                        disabled={modelDisabled}
                        onClick={() =>
                          removeModels(
                            g.models.map(m => m.id),
                            `删除「${g.label}」下的全部 ${g.models.length} 个模型？`
                          )
                        }
                      >
                        {g.provider === 'chatgpt-subscription' ? '删除此组模型' : '删除此站'}
                      </button>
                    </div>
                  </div>
                  {renameKey === g.key && (
                    <form
                      className="resources-rename"
                      onSubmit={e => {
                        e.preventDefault()
                        void saveRename(g)
                      }}
                    >
                      <label className="resources-field">
                        站点名称
                        <input
                          autoFocus
                          value={renameDraft}
                          disabled={!!modelBusy}
                          onChange={e => setRenameDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Escape') setRenameKey('')
                          }}
                          placeholder="留空可恢复默认名称"
                        />
                      </label>
                      <button className="resources-button resources-button--primary" disabled={!!modelBusy}>
                        {modelBusy === 'rename' ? '保存中…' : '保存'}
                      </button>
                      <button
                        type="button"
                        className="resources-button resources-button--quiet"
                        disabled={!!modelBusy}
                        onClick={() => setRenameKey('')}
                      >
                        取消
                      </button>
                      <p className="resources-hint">名称会同步到所有模型选择器。</p>
                    </form>
                  )}
                  {(groupMsg[g.key] || groupErr[g.key]) && (
                    <p
                      className={`resources-notice ${groupErr[g.key] ? 'resources-notice--error' : ''}`}
                      role={groupErr[g.key] ? 'alert' : 'status'}
                    >
                      {groupErr[g.key] || groupMsg[g.key]}
                    </p>
                  )}
                  {open && (
                    <div id={`station-models-${index}`} className="resources-model-list">
                      <div className="resources-model-columns" aria-hidden="true">
                        <span>模型 / 思考强度</span>
                        <span>连接状态与操作</span>
                      </div>
                      {g.models.map(m => (
                        <div className="resources-model-row" key={m.id}>
                          <div className="resources-model-info">
                            <strong>{m.name}</strong>
                            <span className="resources-row-detail">
                              {m.local
                                ? `本地 · ${m.model}${m.contextTokens ? ` · 上下文 ${Math.round(m.contextTokens / 1024)}k` : ''}`
                                : `${m.model} · 思考 ${thinkingShortLabel(m)}`}
                            </span>
                          </div>
                          <div className="resources-actions">
                            <span className="resources-hint">
                              {codexModelStateLabel(m.connectionState) ||
                                (testing === m.id
                                  ? '测试中'
                                  : testResult[m.id]
                                    ? testResult[m.id].ok
                                      ? '连接正常'
                                      : '连接失败'
                                    : '尚未测试')}
                            </span>
                            <button className="resources-button" disabled={modelDisabled} onClick={() => test(m)}>
                              测试连接
                            </button>
                            <button
                              className="resources-button resources-button--quiet"
                              disabled={modelDisabled}
                              onClick={() => {
                                setEditing(m)
                                setShowForm(true)
                              }}
                            >
                              编辑
                            </button>
                            <button
                              className="resources-button resources-button--quiet resources-button--danger"
                              disabled={modelDisabled}
                              onClick={() => removeModels([m.id], `删除模型「${m.name}」？`, true)}
                            >
                              删除
                            </button>
                          </div>
                          {testResult[m.id] && (
                            <p
                              className={`resources-connection-result ${testResult[m.id].ok ? '' : 'resources-notice--error'}`}
                              role="status"
                            >
                              {testResult[m.id].text}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </section>
      <section id="settings-backup" className="resources-section" aria-labelledby="settings-backup-title">
        <div className="resources-section-header">
          <div>
            <h2 id="settings-backup-title">备份与恢复</h2>
            <p>为作品保留一份独立副本。</p>
          </div>
        </div>
        <div className="resources-surface">
          <div className="resources-setting-row">
            <div>
              <h3>导出作品备份</h3>
              <p>将全部作品、正文、版本历史与研讨对话打包为 JSON，不含模型密钥。</p>
            </div>
            <button className="resources-button" onClick={exportBackup} disabled={!!backupBusy}>
              {backupBusy === 'export' ? '导出中…' : '导出备份'}
            </button>
          </div>
          <div className="resources-setting-row">
            <div>
              <h3>从备份恢复</h3>
              <p>按作品 ID 合并，同 ID 内容将被覆盖，其他作品保留。恢复前会自动创建快照。</p>
            </div>
            <button className="resources-button" onClick={() => restoreRef.current?.click()} disabled={!!backupBusy}>
              {backupBusy === 'restore' ? '恢复中…' : '选择备份文件'}
            </button>
          </div>
        </div>
        <p className="resources-hint resources-section-note">
          此备份不含资料库（知识库）、素材与草稿、封面及附件，请另行保留完整数据目录。
        </p>
        <input
          ref={restoreRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={e => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void pickBackup(f)
          }}
        />
        {backupMsg && (
          <p className="resources-notice" role="status">
            {backupMsg}
          </p>
        )}
        {backupErr && (
          <p className="resources-notice resources-notice--error" role="alert">
            {backupErr}
          </p>
        )}
      </section>
      <section id="settings-storage" className="resources-section" aria-labelledby="settings-storage-title">
        <div className="resources-section-header">
          <div>
            <h2 id="settings-storage-title">数据位置</h2>
            <p>作品与本地资料的实际存储目录。</p>
          </div>
        </div>
        {storageLoading ? (
          <p className="resources-status" role="status">
            正在读取数据位置…
          </p>
        ) : storageError ? (
          <div className="resources-notice resources-notice--error" role="alert">
            <span>{storageError}</span>
            <button className="resources-button" onClick={loadStorage}>
              重试
            </button>
          </div>
        ) : (
          <div className="resources-surface resources-storage">
            <p>{storage?.dir || '当前服务未提供数据目录信息。'}</p>
            {storage?.relocated && (
              <p className="resources-notice resources-notice--error">
                原目录「{storage.relocated}
                」不可写，作品实际保存在上方目录。若这不是你的预期，请先导出备份，再修正原目录权限。
              </p>
            )}
          </div>
        )}
      </section>
      {showForm && (
        <ModelForm
          initial={editing}
          onAccountChanged={() => setUsageVersion(value => value + 1)}
          onConnectionChanged={() => {
            setTestResult(results =>
              Object.fromEntries(
                Object.entries(results).filter(
                  ([id]) => !models.some(model => model.id === id && model.provider === 'chatgpt-subscription')
                )
              )
            )
            void load()
          }}
          onCancel={() => setShowForm(false)}
          onDone={() => {
            setShowForm(false)
            void load()
          }}
        />
      )}
      {showImport && <ImportDialog onImported={load} onCancel={() => setShowImport(false)} />}
      {showLocal && <LocalModelDialog onDone={load} onCancel={() => setShowLocal(false)} />}
    </div>
  )
}

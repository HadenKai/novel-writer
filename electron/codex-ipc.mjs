import { CODEX_VERIFICATION_URL, codexError } from '../server/codex-oauth.mjs'

function isOrigin(url, origin) {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

export function desktopApiHeaders(details, contents, origin, token) {
  const { frame, requestHeaders, url, webContentsId } = details
  if (
    !contents ||
    webContentsId !== contents.id ||
    !isOrigin(url, origin) ||
    !new URL(url).pathname.startsWith('/api/') ||
    (frame && (frame !== contents.mainFrame || !isOrigin(frame.url, origin)))
  )
    return requestHeaders
  const headers = Object.fromEntries(
    Object.entries(requestHeaders).filter(([name]) => name.toLowerCase() !== 'x-novel-token')
  )
  return { ...headers, 'x-novel-token': token }
}

export function registerCodexIpc({ ipcMain, getWindow, getOrigin, getAuth, getClient, openExternal }) {
  const allowed = event => {
    const contents = getWindow()?.webContents
    return (
      contents &&
      event.sender === contents &&
      event.senderFrame &&
      event.senderFrame === contents.mainFrame &&
      isOrigin(event.senderFrame.url, getOrigin())
    )
  }

  function register(name, operation) {
    ipcMain.handle('codex:' + name, async (event, id) => {
      if (!allowed(event)) throw codexError('CODEX_UNAVAILABLE')
      const auth = getAuth()
      if (!auth) throw codexError('CODEX_UNAVAILABLE')
      try {
        return await operation(auth, id)
      } catch (error) {
        throw codexError(
          typeof error?.code === 'string' && error.code.startsWith('CODEX_') ? error.code : 'CODEX_UNAVAILABLE'
        )
      }
    })
  }

  async function openVerification(auth, id) {
    if (typeof id !== 'string') return false
    const record = auth.attempt(id)
    if (!record?.userCode || record.expiresAt <= Date.now() || !['pending', 'retrying'].includes(record.state))
      return false
    await openExternal(CODEX_VERIFICATION_URL)
    return true
  }

  register('status', auth => auth.status())
  register('start', async auth => {
    const attempt = await auth.start()
    if (attempt.state === 'pending') await openVerification(auth, attempt.attemptId).catch(() => false)
    return attempt
  })
  register('attempt', (auth, id) => auth.attempt(id))
  register('open-verification', openVerification)
  register('cancel', (auth, id) => auth.cancel(id))
  register('disconnect', auth => auth.disconnect())
  register('list-models', auth => {
    const client = getClient()
    if (!client) throw codexError('CODEX_UNAVAILABLE')
    const status = auth.status()
    if (status.state !== 'connected') throw codexError('CODEX_RECONNECT')
    return client.listModels(status.connectionRef)
  })
}

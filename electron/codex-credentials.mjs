import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { codexError } from '../server/codex-oauth.mjs'

export function createCodexCredentialStorage({ filePath, safeStorage }) {
  const disconnectMarker = filePath + '.disconnecting'
  const isAvailable = () =>
    Boolean(safeStorage?.isEncryptionAvailable()) && safeStorage?.getSelectedStorageBackend?.() !== 'basic_text'
  function requireEncryption() {
    if (!isAvailable()) throw codexError('CODEX_UNAVAILABLE')
  }

  return {
    isAvailable,
    async read() {
      requireEncryption()
      try {
        await fs.stat(disconnectMarker)
        return { state: 'disconnect-error' }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      let encrypted
      try {
        encrypted = await fs.readFile(filePath, 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
    },
    async write(record) {
      requireEncryption()
      const encrypted = safeStorage.encryptString(JSON.stringify(record)).toString('base64')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const temp = filePath + '.' + randomUUID() + '.tmp'
      try {
        await fs.writeFile(temp, encrypted, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await fs.rename(temp, filePath)
      } finally {
        await fs.rm(temp, { force: true })
      }
    },
    async clear() {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      // A locked credential file must never be treated as signed in after a restart.
      await fs.writeFile(disconnectMarker, '', { flag: 'a', mode: 0o600 })
      await fs.rm(filePath, { force: true })
      await fs.rm(disconnectMarker, { force: true })
    }
  }
}

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createCodexClient, configureCodexClient } from '../server/codex-responses.mjs'
import { codexError } from '../server/codex-oauth.mjs'

const ref = 'a'.repeat(64)
const other = 'b'.repeat(64)
const provider = 'chatgpt-subscription'
const chapterText = '林砚推开门时，墙上的钟刚敲过两下。街上静悄悄的，只有风把废纸吹过窗前。'.repeat(16)
const fenced = String.fromCharCode(96).repeat(3)

test(
  'subscription model API protects credentials and preserves selection and agent routing',
  { timeout: 20000 },
  async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-codex-models-'))
    process.env.NOVEL_DATA_DIR = dir
    let state = { state: 'connected', connectionRef: ref }
    let outcome = 'probe'
    const modelsHit = []
    configureCodexClient(
      createCodexClient({
        auth: {
          status: () => state,
          async getCredential(refSeen) {
            if (state.state !== 'connected') throw codexError('CODEX_RECONNECT')
            if (refSeen !== state.connectionRef) throw codexError('CODEX_ACCOUNT_MISMATCH')
            return { accessToken: 'simulated-token', accountId: 'simulated-account' }
          }
        },
        fetchImpl: async (url, options) => {
          assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses')
          const body = JSON.parse(options.body)
          modelsHit.push(body.model)
          const content =
            outcome === 'draft'
              ? chapterText
              : outcome === 'chat'
                ? '我已整理建议。\n\n' +
                  fenced +
                  'json\n' +
                  JSON.stringify({
                    actions: [
                      {
                        type: 'insertParagraph',
                        chapter: 1,
                        text: JSON.stringify({ start: 1, replacement: '这是管家新增的段落。' })
                      }
                    ]
                  }) +
                  '\n' +
                  fenced
                : '你好。'
          return new Response(
            [
              { type: 'response.output_text.delta', delta: content },
              { type: 'response.completed', response: { status: 'completed' } }
            ]
              .map(e => 'data: ' + JSON.stringify(e) + '\n\n')
              .join('')
          )
        }
      })
    )
    const { startServer, stopServer } = await import('../server/app.mjs')
    const { resolveConn } = await import('../server/models.mjs')
    const port = await startServer(0)
    t.after(async () => {
      await stopServer()
      configureCodexClient(null)
      await fs.rm(dir, { recursive: true, force: true })
    })
    const req = (url, body, method = body === undefined ? 'GET' : 'POST') =>
      fetch('http://127.0.0.1:' + port + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    async function jobResult(jobId) {
      for (let i = 0; i < 80; i++) {
        const job = await (await req('/api/jobs/' + jobId)).json()
        if (job.status !== 'running') return job
        await sleep(30)
      }
      assert.fail('task did not finish')
    }

    await t.test('model config strips caller credentials and keeps legacy masked fields', async () => {
      const added = await req('/api/models', {
        id: 'codex-a',
        provider,
        name: 'Subscription',
        model: 'cla-test',
        connectionRef: ref,
        isDefault: true,
        accessToken: 'evil-access',
        refreshToken: 'evil-refresh',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'evil-api',
        local: true
      })
      assert.equal(added.status, 201)
      const model = await added.json()
      assert.equal(model.provider, provider)
      assert.equal(model.connectionState, 'connected')
      assert.equal(model.baseUrl, '')
      assert.equal(model.apiKey, '')
      assert.equal(model.local, false)
      assert.equal(model.accessToken, undefined)
      assert.equal(model.refreshToken, undefined)
      assert.doesNotMatch(await fs.readFile(path.join(dir, 'models.json'), 'utf8'), /evil-/)
      const legacy = await req('/api/models', {
        id: 'legacy',
        name: 'Legacy',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'masked-key',
        model: 'legacy'
      })
      assert.equal(legacy.status, 201)
      assert.equal((await legacy.json()).apiKey, 'mas****-key')
      assert.equal(resolveConn().provider, provider)
      assert.equal(resolveConn('legacy').provider, 'openai')
    })

    await t.test('an existing model stays bound until explicitly reassigned', async () => {
      const novel = await (await req('/api/novels', { title: 'Binding', genre: '测试' })).json()
      assert.equal((await req('/api/novels/' + novel.id, { id: novel.id, modelId: 'codex-a' }, 'PUT')).status, 200)
      const model = async () => (await (await req('/api/models')).json()).find(m => m.id === 'codex-a')
      state = { state: 'disconnected' }
      assert.equal((await model()).connectionState, 'reconnect')
      state = { state: 'connected', connectionRef: other }
      assert.equal((await model()).connectionState, 'account-mismatch')
      const rejected = await req('/api/models/codex-a/test', {})
      assert.equal(rejected.status, 400)
      assert.equal((await rejected.json()).code, 'CODEX_ACCOUNT_MISMATCH')
      assert.equal(modelsHit.length, 0)
      const saved = await req('/api/models/codex-a', { ...(await model()), name: 'Renamed' }, 'PUT')
      assert.equal(saved.status, 200)
      assert.equal((await saved.json()).connectionRef, ref)
      const rebind = await req('/api/models/codex-a', { ...(await model()), connectionRef: other }, 'PUT')
      assert.equal(rebind.status, 200)
      assert.equal((await rebind.json()).connectionState, 'connected')
      assert.equal((await (await req('/api/novels/' + novel.id)).json()).modelId, 'codex-a')
      state = { state: 'connected', connectionRef: ref }
      assert.equal((await req('/api/models/codex-a', { ...(await model()), connectionRef: ref }, 'PUT')).status, 200)
    })

    await t.test('connection testing hits the exact model and subscription avoids legacy import routes', async () => {
      assert.equal((await req('/api/models/bad-id/test', {})).status, 404)
      assert.equal((await req('/api/models/codex-a/test', {})).status, 200)
      assert.deepEqual(modelsHit, ['cla-test'])
      for (const uri of ['/probe', '/import', '/import-group', '/stations/name', '/codex-a/list']) {
        assert.equal(
          (await req('/api/models' + uri, { provider, baseUrl: 'http://127.0.0.1:9', apiKey: 'unsafe' })).status,
          400
        )
      }
      assert.deepEqual(modelsHit, ['cla-test'])
    })

    await t.test('the local writing and butler loops use subscription streaming', async () => {
      const book = await (await req('/api/novels', { title: 'Mock book', genre: '测试' })).json()
      outcome = 'draft'
      await req('/api/novels/' + book.id + '/chapters', { title: '第 1 章 开始' })
      const chapter = await (
        await req('/api/generate/chapter', {
          novelId: book.id,
          chapterIndex: 1,
          modelId: 'codex-a',
          previewOnly: true
        })
      ).json()
      const written = await jobResult(chapter.jobId)
      assert.equal(written.status, 'done', written.error)
      assert.match(written.stream, /林砚推开门/)
      await req('/api/novels/' + book.id + '/import', { text: '第一章 开端\n第一段。\n\n第二段。', replace: true })
      outcome = 'chat'
      const chat = await (
        await req('/api/chat', {
          novelId: book.id,
          modelId: 'codex-a',
          message: '在第 1 章插一段',
          applyActions: true
        })
      ).json()
      const answered = await jobResult(chat.jobId)
      assert.equal(answered.status, 'done', answered.error)
      assert.match(answered.stream, /我已整理建议/)
      assert.equal(answered.actions[0]?.type, 'insertParagraph')
      state = { state: 'disconnected' }
      const refused = await (
        await req('/api/chat', {
          novelId: book.id,
          modelId: 'codex-a',
          message: '继续讨论'
        })
      ).json()
      const failed = await jobResult(refused.jobId)
      assert.equal(failed.status, 'error')
      assert.equal(failed.errorCode, 'CODEX_RECONNECT')
    })
  }
)

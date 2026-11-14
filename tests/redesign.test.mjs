import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-redesign-'))
process.env.NOVEL_DATA_DIR = root
const app = await import('../server/app.mjs')
const store = await import('../server/store.mjs')

test('正文中心工作台：手写与恢复失败保护', async t => {
  const port = await app.startServer(0)
  const request = async (url, method = 'GET', body) => {
    const response = await fetch('http://127.0.0.1:' + port + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, data: await response.json() }
  }
  try {
    await t.test('没有模型也能创建空章；并发创建不会重号', async () => {
      const { data: novel } = await request('/api/novels', 'POST', { title: '手写作品', genre: '' })
      const results = await Promise.all(
        Array.from({ length: 3 }, () => request('/api/novels/' + novel.id + '/chapters', 'POST', {}))
      )
      assert.ok(results.every(r => r.status === 201))
      assert.equal(new Set(results.map(r => r.data.chapter.index)).size, 3)
      const { data } = await request('/api/novels/' + novel.id)
      assert.equal(data.chapters.length, 3)
      assert.equal(data.outline.length, 3)
      assert.ok(data.chapters.every(c => c.status === 'draft' && c.content === '' && c.oid))
    })
    await t.test('手写入口复用已有大纲而不是创建重复章节', async () => {
      const { data: novel } = await request('/api/novels', 'POST', { title: '已有规划', genre: '' })
      novel.outline = [{ index: 1, title: '开场', oid: 'outline-first', summary: '', customPrompt: '' }]
      await request('/api/novels/' + novel.id, 'PUT', novel)
      const { data, status } = await request('/api/novels/' + novel.id + '/chapters', 'POST', {})
      assert.equal(status, 201)
      assert.equal(data.chapter.oid, 'outline-first')
      assert.equal(data.chapter.title, '开场')
    })
    await t.test('过期编辑返回冲突，稳定 oid 保存不受章号变化影响', async () => {
      const { data: novel } = await request('/api/novels', 'POST', { title: '保存冲突', genre: '' })
      const { data: first } = await request('/api/novels/' + novel.id + '/chapters', 'POST', {})
      await request('/api/novels/' + novel.id + '/chapters', 'POST', {})
      const url = '/api/novels/' + novel.id + '/chapters/1'
      assert.equal((await request(url, 'PUT', { content: '新正文' })).status, 200)
      assert.equal((await request(url, 'PUT', { content: '过期正文', expectedContent: '' })).status, 409)
      const saved = await request('/api/novels/' + novel.id + '/chapters/2', 'PUT', {
        oid: first.chapter.oid,
        expectedContent: '新正文',
        content: '定位正确'
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.data.chapter.oid, first.chapter.oid)
      const { data } = await request('/api/novels/' + novel.id)
      assert.equal(data.chapters.find(c => c.index === 2).content, '')
    })
    await t.test('AI 候选稿不写正文；采纳留历史；原稿变化时返回冲突', async () => {
      const mock = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(
          'data: ' +
            JSON.stringify({ choices: [{ delta: { content: '候选正文。'.repeat(30) }, finish_reason: 'stop' }] }) +
            '\n\ndata: [DONE]\n\n'
        )
      })
      await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
      try {
        fs.writeFileSync(
          path.join(root, 'models.json'),
          JSON.stringify([
            {
              id: 'review-model',
              name: 'mock',
              baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1',
              apiKey: 'fixture',
              model: 'mock',
              provider: 'openai'
            }
          ])
        )
        const { data: novel } = await request('/api/novels', 'POST', { title: '审校作品', genre: '' })
        await request('/api/novels/' + novel.id + '/chapters', 'POST', {})
        const url = '/api/novels/' + novel.id + '/chapters/1'
        await request(url, 'PUT', { content: '原稿'.repeat(50) })
        const generate = async () => {
          const response = await request('/api/generate/batch-refine', 'POST', {
            novelId: novel.id,
            mode: 'polish',
            chapterIndices: [1],
            modelId: 'review-model',
            previewOnly: true
          })
          assert.equal(response.status, 202)
          for (let i = 0; i < 100; i++) {
            const { data } = await request('/api/jobs/' + response.data.jobId)
            if (data.status !== 'running') {
              assert.equal(data.status, 'done', data.error)
              return data
            }
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          throw new Error('fixture timeout')
        }
        const job = await generate()
        assert.equal(job.proposals.length, 1)
        assert.equal((await request('/api/novels/' + novel.id)).data.chapters[0].content, '原稿'.repeat(50))
        const accept = '/api/jobs/' + job.id + '/proposals/' + job.proposals[0].id + '/accept'
        assert.equal((await request(accept, 'POST', {})).status, 200)
        assert.equal((await request('/api/novels/' + novel.id)).data.chapters[0].content, job.proposals[0].content)
        assert.ok(fs.existsSync(store.historyFile(novel.id)))
        const second = await generate()
        await request(url, 'PUT', { content: '作者新改动' })
        assert.equal(
          (await request('/api/jobs/' + second.id + '/proposals/' + second.proposals[0].id + '/accept', 'POST', {}))
            .status,
          409
        )
        assert.equal((await request('/api/novels/' + novel.id)).data.chapters[0].content, '作者新改动')
      } finally {
        await new Promise(resolve => mock.close(resolve))
      }
    })
    await t.test('损坏的第二本备份在写入前被拦住，写入故障会回滚', async () => {
      const { data: novel } = await request('/api/novels', 'POST', { title: '原始书名', genre: '' })
      const changed = { ...novel, title: '备份中的书名' }
      const malformed = await request('/api/backup/restore', 'POST', {
        novels: [changed, { id: 'broken-second', outline: [null], chapters: [] }]
      })
      assert.equal(malformed.status, 400)
      assert.equal((await request('/api/novels/' + novel.id)).data.title, '原始书名')
      const rename = fs.renameSync
      try {
        fs.renameSync = (source, target) => {
          if (String(target).endsWith('rollback-second.json')) throw new Error('injected write failure')
          return rename(source, target)
        }
        const response = await request('/api/backup/restore', 'POST', {
          novels: [changed, { id: 'rollback-second', title: 'second', outline: [], chapters: [] }]
        })
        assert.equal(response.status, 500)
        assert.match(response.data.error, /已回滚/)
      } finally {
        fs.renameSync = rename
      }
      assert.equal((await request('/api/novels/' + novel.id)).data.title, '原始书名')
      assert.ok(!fs.existsSync(store.novelFile('rollback-second')))
    })
    await t.test('备份覆盖素材、偏好与码字统计并能还原', async () => {
      const { data: item } = await request('/api/shelf', 'POST', { title: '备用开场白', content: '雨夜，旧书店。' })
      await request('/api/settings', 'PUT', { fontSize: 21 })
      const { data: backup } = await request('/api/backup')
      assert.equal(backup.version, 3)
      assert.ok(backup.shelf.items.some(x => x.title === '备用开场白'))
      assert.equal(backup.prefs.fontSize, 21)
      await request('/api/shelf/' + item.id, 'DELETE')
      await request('/api/settings', 'PUT', { fontSize: 12 })
      assert.equal((await request('/api/backup/restore', 'POST', backup)).status, 200)
      assert.ok((await request('/api/shelf')).data.some(x => x.title === '备用开场白'))
      assert.equal((await request('/api/settings')).data.fontSize, 21)
    })
    await t.test('复制故障时回收站原件保留，重试恢复成功', async () => {
      const { data: novel } = await request('/api/novels', 'POST', { title: '恢复保护', genre: '' })
      store.recycleNovel(novel.id)
      const source = path.join(store.RECYCLE_DIR, novel.id, novel.id + '.json')
      const copy = fs.cpSync
      try {
        fs.cpSync = () => {
          throw new Error('injected disk failure')
        }
        assert.throws(() => store.restoreRecycle(novel.id), /原件已保留/)
      } finally {
        fs.cpSync = copy
      }
      assert.ok(fs.existsSync(source))
      assert.ok(!fs.existsSync(store.novelFile(novel.id)))
      assert.ok(store.restoreRecycle(novel.id))
      assert.ok(fs.existsSync(store.novelFile(novel.id)))
    })
  } finally {
    await app.stopServer()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

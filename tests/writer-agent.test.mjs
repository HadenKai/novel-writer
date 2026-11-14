// 写作 Agent + 本地模型端到端：
//  - 本地连接允许空密钥，请求里不能出现 Authorization 头
//  - 四阶段链路（构思 → 起草 → 自检 → 修订）确实被走到，且最终采用修订稿
// 不访问公网：本地起一个假的 OpenAI 兼容服务，按 system 提示词分辨当前阶段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-writer-agent-'))

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

const DRAFT = `雨停的时候，码头的灯还亮着。林砚把伞收起来，抖了抖水，沿着湿滑的石阶往下走。
老周蹲在船头补网，见他来了，只抬了一下眼皮。"这么晚？"老周问。林砚没答，把那只铁皮盒子放在船板上。
盒子是从父亲留下的柜子最底层翻出来的，锁早锈死了，他是用螺丝刀撬开的。里面只有一张发黄的照片和半张船票。
"你爸当年就是坐这条船走的。"老周的手指在照片上点了点，"船上还有一个人，没人知道他叫什么。"
林砚盯着照片上那个模糊的侧影，忽然觉得后颈发凉。这个人站的位置，和他父亲之间隔着半步，像是被谁刻意裁掉了一段距离。
远处传来一声汽笛，很长，压过了浪。老周站起身，把网往舱里一塞："别查了。有些事，问到底就是给自己找麻烦。"
林砚把照片翻过来，背面有一行褪色的钢笔字：'九月十七，别等我。'
他抬头看向黑沉沉的海面，那艘船早就没有了，可汽笛声又响了一次。`

const REVISED = `雨停的时候，码头的灯还亮着。林砚收起伞，抖了抖水，顺着湿滑的石阶往下走。
老周蹲在船头补网，见他来了，只抬了一下眼皮。"这么晚？"老周问。林砚没答话，把那只铁皮盒子搁在船板上。
盒子是从父亲留下的柜子最底层翻出来的，锁早锈死了，他用螺丝刀撬开。里面只有一张发黄的照片和半张船票。
"你爸当年就是坐这条船走的。"老周的手指在照片上点了点，"船上还有一个人，没人知道他叫什么。"
林砚盯着照片上那个模糊的侧影，后颈忽然一凉。那人站的位置离他父亲只有半步，像是被人刻意裁掉了一段距离。
远处传来一声汽笛，很长，压过浪头。老周站起身，把网往舱里一塞："别查了。有些事，问到底就是给自己找麻烦。"
林砚把照片翻过来。背面有一行褪色的钢笔字：九月十七，别等我。
他抬头看向黑沉沉的海面。船早没了，可汽笛声又响了一次。`

test('写作 Agent：本地模型零密钥接入 + 四阶段成稿', { timeout: 60000 }, async () => {
  const seen = { auth: [], systems: [] }
  const relay = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) return res.writeHead(404).end('no')
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const payload = JSON.parse(raw)
      seen.auth.push(req.headers.authorization || '')
      const system = String(payload.messages?.find(m => m.role === 'system')?.content || '')
      seen.systems.push(system)

      let content
      if (system.includes('小说策划编辑')) {
        content = JSON.stringify({
          goal: '林砚从父亲遗物里发现线索',
          beats: [
            { label: '开场', event: '雨夜码头，林砚带着铁盒来找老周', purpose: '建立悬念' },
            { label: '发展', event: '盒中照片与船票揭示父亲并非独自离开', purpose: '推进主线' },
            { label: '收束', event: '老周劝他别再查，汽笛声再响', purpose: '留下钩子' }
          ],
          turningPoint: '照片背面写着「九月十七，别等我」',
          hook: '汽笛声在没有船的夜里又响了一次',
          callbacks: ['父亲留下的柜子'],
          avoid: ['不要解释照片上那个人是谁']
        })
      } else if (system.includes('审稿编辑')) {
        content = JSON.stringify({
          score: 78,
          summary: '氛围到位，但结尾解释偏多',
          issues: [
            {
              type: 'AI腔',
              severity: 'high',
              quote: '像是被谁刻意裁掉了一段距离',
              fix: '删掉比喻式解读，改成具体动作'
            },
            { type: '节奏', severity: 'low', quote: '他抬头看向黑沉沉的海面', fix: '收得更短' }
          ]
        })
      } else if (system.includes('改稿编辑')) {
        content = REVISED
      } else {
        content = DRAFT
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const relayPort = await listen(relay)
  process.env.NOVEL_DATA_DIR = tmpData

  const { startServer, stopServer } = await import('../server/app.mjs')
  const port = await startServer(0)
  const base = `http://127.0.0.1:${port}`
  const post = (url, body) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  try {
    // 本地模型：不带 apiKey，local=true
    const modelRes = await post('/api/models', {
      name: '本机 qwen',
      baseUrl: `http://127.0.0.1:${relayPort}/v1`,
      apiKey: '',
      model: 'qwen2.5:7b',
      local: true,
      contextTokens: 16384
    })
    assert.equal(modelRes.status, 201, '本地模型应允许空密钥')
    const model = await modelRes.json()
    assert.equal(model.local, true)

    const novel = await (await post('/api/novels', { title: '码头', genre: '悬疑' })).json()
    await post(`/api/novels/${novel.id}/chapters`, { title: '第 1 章 铁盒' })

    const started = await post('/api/generate/chapter', {
      novelId: novel.id,
      chapterIndex: 1,
      modelId: model.id,
      agent: true,
      previewOnly: true
    })
    assert.equal(started.status, 202)
    const { jobId } = await started.json()

    let job = null
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 100))
      job = await (await fetch(`${base}/api/jobs/${jobId}`)).json()
      if (job.status !== 'running') break
    }

    assert.equal(job.status, 'done', `任务应正常结束：${job.status} ${job.error || ''}`)
    assert.equal(job.stage, 'done')
    // 阶段顺序靠提示词确认：构思 → 起草 → 自检 → 修订（轮询太快时看不到中间态）
    assert.equal(seen.systems.length, 4, '四阶段应各调用一次模型')
    assert.match(seen.systems[0], /小说策划编辑/, '第一次调用应是构思')
    assert.doesNotMatch(seen.systems[1], /编辑/, '第二次调用应是起草')
    assert.match(seen.systems[2], /审稿编辑/, '第三次调用应是自检')
    assert.match(seen.systems[3], /改稿编辑/, '第四次调用应是修订')
    assert.equal(job.revised, true)
    assert.equal(job.brief?.beats?.length, 3, '方案应带 3 个节拍')
    // 审稿返回 2 条，其中 1 条是 low；工作流只把 high/medium 当作必改项
    assert.equal(job.review?.issues?.length, 1)

    // 本地模型绝不能带 Authorization，哪怕是空的 Bearer
    assert.deepEqual(seen.auth.filter(Boolean), [], '本地连接不应发送 Authorization 头')

    // previewOnly：正文没有被直接覆盖，候选稿进 proposal
    const proposal = job.proposals?.[0]
    assert.ok(proposal, '应产出候选稿')
    assert.equal(proposal.content, REVISED, '最终采用修订稿')
    assert.equal(proposal.original, '')

    const fresh = await (await fetch(`${base}/api/novels/${novel.id}`)).json()
    assert.equal(fresh.chapters[0].content, '', '预览模式不应写入正文')
  } finally {
    await stopServer()
    relay.close()
  }
})

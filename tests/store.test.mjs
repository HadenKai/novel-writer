import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { withFile, pendingFileWriteCount } from '../server/store.mjs'

test('withFile 完成后回收已结束的文件队列', async () => {
  const files = Array.from({ length: 24 }, (_, i) =>
    path.join(os.tmpdir(), `novel-write-queue-${process.pid}-${i}.json`)
  )
  await Promise.all(files.map(file => withFile(file, async () => undefined)))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pendingFileWriteCount(), 0)
})

test('withFile 同一文件仍按提交顺序执行', async () => {
  const file = path.join(os.tmpdir(), `novel-write-order-${process.pid}.json`)
  const order = []
  await Promise.all([
    withFile(file, async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(1)
    }),
    withFile(file, async () => {
      order.push(2)
    })
  ])
  assert.deepEqual(order, [1, 2])
})

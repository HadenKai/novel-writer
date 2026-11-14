// 实例锁「陈旧判定」回归测试
//
// 背景（真实故障）：桌面版被强杀（任务管理器结束进程 / 终端超时被杀）后，
// 锁文件 `.instance.lock` 留在数据目录里。下次双击启动时，
// 旧逻辑只看「这个 PID 现在还活着吗」——而 Windows 的 PID 会被系统回收给
// 无关进程，于是出现「进程明明不在了，却被判定成另一个实例占用」，
// 用户被挡在启动之外，只能手动删锁文件。
//
// 本测试锁定三种情况：
//  1. 锁里的进程已经不存在            → 判定为陈旧，自动抢锁
//  2. 锁里的 PID 被回收给别的程序      → 判定为陈旧，自动抢锁
//  3. 锁确实被一个活着的本项目进程持有 → 必须拒绝启动（不能误抢）
//
// 说明：本文件在进程内直接调用后端，不额外拉起服务子进程，避免与其它测试文件
// 并行时相互拖慢（断言合并在单个 test 内）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-lock-'))
process.env.NOVEL_DATA_DIR = tmpData

const app = await import('../server/app.mjs')

const LOCK_FILE = path.join(tmpData, '.instance.lock')

function writeLock(pid, startedAt = Date.now()) {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid, startedAt, token: 'test-token' }), 'utf8')
}

function clearLock() {
  if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE)
}

test('实例锁：陈旧锁自动回收，真实持有者仍然拒绝', async () => {
  // ---------- 1. 锁里的进程早已不存在（强杀后的典型残留） ----------
  const deadPid = 0x0fffff
  writeLock(deadPid)
  assert.equal(
    app.__probeLockHolderAlive({ pid: deadPid, startedAt: Date.now() }),
    false,
    '进程已不存在时不应判定为「还有别人在写」'
  )

  // 端到端：带着陈旧锁启动，必须能自动抢锁并正常起服务
  const port = await app.startServer(0)
  assert.ok(port > 0, '带着陈旧锁也应能启动')
  await app.stopServer()
  clearLock()

  // ---------- 2. PID 被系统回收给别的程序（镜像名不是本项目） ----------
  const other = spawn('cmd.exe', ['/c', 'ping -n 8 127.0.0.1 > nul'], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 300))
  try {
    assert.ok(other.pid, '应能起一个参照进程')
    writeLock(other.pid)
    assert.equal(
      app.__probeLockHolderAlive({ pid: other.pid, startedAt: Date.now() }),
      false,
      'PID 被回收给无关程序时不应判定为「还有别人在写」'
    )
    clearLock()
  } finally {
    other.kill()
  }

  // ---------- 3. 锁确实被活着的本项目进程持有 → 必须拒绝 ----------
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 300))
  try {
    assert.ok(holder.pid, '应能起一个持有者进程')
    // 持有者先于写锁存在：创建时间早于 startedAt，才是真正的持有者
    writeLock(holder.pid)
    assert.equal(
      app.__probeLockHolderAlive({ pid: holder.pid, startedAt: Date.now() }),
      true,
      '真实持有者在场时必须判定为「还有别人在写」'
    )
    await assert.rejects(() => app.startServer(0), /已被另一个|占用|锁/, '真实持有者在场时启动必须被拒绝')
    clearLock()
  } finally {
    holder.kill()
  }
})

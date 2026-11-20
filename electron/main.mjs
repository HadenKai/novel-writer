import { app, BrowserWindow, shell, dialog, session, ipcMain, screen, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createCodexCredentialStorage } from './codex-credentials.mjs'
import { desktopApiHeaders, registerCodexIpc } from './codex-ipc.mjs'
import { createCodexAuth } from '../server/codex-oauth.mjs'
import { configureCodexClient, createCodexClient, getCodexClient } from '../server/codex-responses.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL_RE = /^https?:\/\/(127\.0\.0\.1|localhost):5173(?:\/|$)/i
const isDev = DEV_URL_RE.test(process.env.ELECTRON_START_URL || '')

// 后端与 Electron 主进程同进程运行：任何一处裸抛（定时器、流式回调、备份任务）
// 都会带走整个应用。兜底只做两件事——记日志、提示一次，绝不吞掉退出。
let fatalShown = false
function reportFatal(err) {
  const msg = String(err?.stack || err?.message || err)
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志写不进也不能再抛 */
  }
  console.error('[main] 未捕获异常：', msg)
  if (!fatalShown) {
    fatalShown = true
    try {
      dialog.showErrorBox('小说工坊发生内部错误', `${msg.slice(0, 400)}\n\n应用尝试继续运行；详情见崩溃日志。`)
    } catch {
      /* 无界面环境 */
    }
  }
}
process.on('uncaughtException', reportFatal)
process.on('unhandledRejection', reason => reportFatal(reason))

// 单实例锁：防止双开两个进程读写同一份数据互相覆盖
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// 关键：必须在 import 后端模块之前设置数据目录，否则 app.mjs 顶层代码
// 会在 app.asar（只读归档，非目录）内建目录而报 ENOTDIR
// 所以这里用动态 import，先设环境变量再加载后端
process.env.NOVEL_DATA_DIR = process.env.NOVEL_DATA_DIR || path.join(app.getPath('userData'), 'novel-data')

// Electron 的可信窗口使用一次性令牌。开发模式的 Vite 代理原样转发该头。
const ACCESS_TOKEN = crypto.randomBytes(24).toString('hex')
process.env.NOVEL_ACCESS_TOKEN = ACCESS_TOKEN

let win = null
let trustedOrigin = ''
let codexAuth = null
let downloadHandlerRegistered = false
// 后端「停止全部任务」句柄：关窗时用它掐断仍在跑的生成任务
let stopAllJobs = null
// 后端「等待任务收尾落盘」句柄：quit 前给它一点宽限，别让半截正文来不及持久化
let drainAllJobs = null

// 注册一次全局下载处理：导出文件弹「另存为」，完成后提示可定位
function registerDownloadHandler(sess) {
  if (downloadHandlerRegistered) return
  downloadHandlerRegistered = true
  sess.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: '导出到…' })
    item.once('done', (__e, state) => {
      if (state === 'completed') {
        const p = item.getSavePath()
        // 下载完成时窗口可能已关闭：对 null 窗口调 showMessageBox 会直接抛 TypeError
        if (!win) return
        dialog
          .showMessageBox(win, {
            type: 'info',
            message: '导出完成',
            detail: p,
            buttons: ['打开所在文件夹', '好'],
            defaultId: 1,
            cancelId: 1
          })
          .then(r => {
            if (r.response === 0) shell.showItemInFolder(p)
          })
      }
    })
  })
}

// 窗口位置/尺寸/最大化状态持久化：重启后回到作者习惯的布局，而不是每次 1320×860 居中
const WIN_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')
// 读取窗口状态并把位置校正到当前显示器内。显示器拔掉、分辨率变小或窗口被拖到
// 扩展屏外侧时，旧坐标可能完全落在可见区域之外；直接复用会让应用“启动了但看不见”。
function loadWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8'))
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null
    if (!Number.isFinite(s.width) || !Number.isFinite(s.height) || s.width < 800 || s.height < 500) return null

    const displays = screen.getAllDisplays()
    const intersects = (area, x, y, width, height) =>
      x < area.x + area.width && x + width > area.x && y < area.y + area.height && y + height > area.y
    const target = displays.find(d => intersects(d.workArea, s.x, s.y, s.width, s.height)) || screen.getPrimaryDisplay()
    const area = target.workArea
    const width = Math.min(Math.max(s.width, 800), area.width)
    const height = Math.min(Math.max(s.height, 500), area.height)
    const centeredX = area.x + Math.round((area.width - width) / 2)
    const centeredY = area.y + Math.round((area.height - height) / 2)

    // 完全不可见时居中；仅部分越界时把窗口夹回工作区，尽量保留作者原来的位置。
    const fullyVisible = intersects(area, s.x, s.y, s.width, s.height)
    const x = fullyVisible ? Math.min(Math.max(s.x, area.x), area.x + area.width - width) : centeredX
    const y = fullyVisible ? Math.min(Math.max(s.y, area.y), area.y + area.height - height) : centeredY
    return { ...s, x, y, width, height }
  } catch {
    /* 首次启动或文件损坏 */
  }
  return null
}
let saveStateTimer = null
function persistWinState(w) {
  if (!w) return
  clearTimeout(saveStateTimer)
  saveStateTimer = setTimeout(() => {
    try {
      const b = w.getBounds()
      fs.writeFileSync(WIN_STATE_FILE, JSON.stringify({ ...b, maximized: w.isMaximized() }))
    } catch {
      /* 状态写失败无所谓 */
    }
  }, 400)
}

async function createWindow() {
  if (!codexAuth) {
    const storage = createCodexCredentialStorage({
      filePath: path.join(process.env.NOVEL_DATA_DIR, 'codex-credentials.enc'),
      safeStorage
    })
    codexAuth = await createCodexAuth({ storage })
    configureCodexClient(createCodexClient({ auth: codexAuth, appVersion: app.getVersion() }))
  }
  const { startServer, abortAllJobs, drainJobs } = await import('../server/app.mjs')
  stopAllJobs = abortAllJobs
  drainAllJobs = drainJobs
  // Vite 开发代理固定指向 3789，端口漂移会把请求发给错误服务；
  // 因此 Electron 开发模式也必须在端口被占用时直接报错。
  const port = await startServer(3789, { strictPort: true })
  const apiOrigin = `http://127.0.0.1:${port}`
  trustedOrigin = isDev ? new URL(process.env.ELECTRON_START_URL).origin : apiOrigin

  const saved = loadWinState()
  win = new BrowserWindow({
    width: saved?.width ?? 1320,
    height: saved?.height ?? 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1000,
    minHeight: 660,
    // 与深色主题的画布同色（index.css 的 --bg），首帧前不闪出另一种黑
    backgroundColor: '#0c0d0f',
    autoHideMenuBar: true,
    title: '小说工坊',
    // 自绘标题栏：隐藏系统标题栏，消除深色界面顶部那条白色系统栏；
    // 顶部拖拽区与窗口按钮由前端渲染（见 App.tsx 的 TitleBar）。
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })
  if (saved?.maximized) win.maximize()
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, () => persistWinState(win))

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${trustedOrigin}/api/*`] }, (details, cb) => {
    cb({ requestHeaders: desktopApiHeaders(details, win?.webContents, trustedOrigin, ACCESS_TOKEN) })
  })

  // CSP 兜底（响应头版）：与 index.html 的 meta 策略保持一致。
  // 生产环境收紧到 'self'；开发环境放开以便 Vite HMR 的 eval / websocket 能工作。
  const CSP = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:5173 http://localhost:5173 ws://127.0.0.1:5173 ws://localhost:5173; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${apiOrigin}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP]
      }
    })
  })

  // 禁止导航到非本地页面（防被诱导跳转到钓鱼站），外链交给系统浏览器
  win.webContents.on('will-navigate', (e, target) => {
    const allowed = isDev ? DEV_URL_RE.test(target) : target.startsWith(apiOrigin + '/')
    if (!allowed) {
      e.preventDefault()
      if (/^https?:\/\//i.test(target)) shell.openExternal(target)
    }
  })

  // 拒绝一切权限请求（摄像头/麦克风/通知等），本应用不需要
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  // 导出文件时弹出「另存为」，完成后提示可定位文件。
  // 只在窗口首次创建时注册一次，避免重复创建窗口后叠加多个监听、重复弹导出提示
  registerDownloadHandler(session.defaultSession)

  const url = isDev ? process.env.ELECTRON_START_URL : apiOrigin
  await win.loadURL(url)

  // 外部链接用系统浏览器打开，仅放行 http/https，防止被诱导执行本地程序
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target)
    return { action: 'deny' }
  })

  // 最大化状态变化通知渲染进程，同步标题栏按钮图标
  win.on('maximize', () => win?.webContents.send('win:maximized', true))
  win.on('unmaximize', () => win?.webContents.send('win:maximized', false))

  win.on('closed', () => {
    win = null
  })
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// 选择文件夹（供前端调用，用于指定参考小说文件夹）
function trustedIpc(event) {
  if (!win || event.sender !== win.webContents) return false
  const url = event.senderFrame?.url || ''
  return url.startsWith(trustedOrigin + '/') || url === trustedOrigin
}

registerCodexIpc({
  ipcMain,
  getWindow: () => win,
  getOrigin: () => trustedOrigin,
  getAuth: () => codexAuth,
  getClient: getCodexClient,
  openExternal: url => shell.openExternal(url)
})

ipcMain.handle('pick-folder', async event => {
  if (!trustedIpc(event)) return null
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择参考小说文件夹',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

// ---------- 自绘标题栏的窗口控制 ----------
ipcMain.handle('win:minimize', event => {
  if (!trustedIpc(event)) return false
  return win?.minimize()
})
ipcMain.handle('win:maximize', event => {
  if (!trustedIpc(event)) return false
  if (!win) return false
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  return win.isMaximized()
})
ipcMain.handle('win:close', event => {
  if (!trustedIpc(event)) return false
  return win?.close()
})
ipcMain.handle('win:isMaximized', event => {
  if (!trustedIpc(event)) return false
  return !!win?.isMaximized()
})

app
  .whenReady()
  .then(createWindow)
  .catch(e => {
    dialog.showErrorBox('小说工坊启动失败', String(e?.message || e))
    app.quit()
  })

app.on('window-all-closed', async () => {
  const authClosed = codexAuth?.shutdown()
  // 关窗即「停止写作」：把仍在跑的后台任务全部掐断，避免进程退出时
  // 还挂着未完成的上游请求，也避免半截结果留在内存里没落盘。
  if (stopAllJobs) {
    try {
      stopAllJobs('窗口已关闭，任务已停止')
    } catch {
      /* 关窗清理失败不阻塞退出 */
    }
  }
  // abortAllJobs 只掐断上游请求，任务收尾里的「半截正文按草稿落盘」是异步的；
  // 给它最多 1.5 秒宽限再 quit，否则关窗瞬间可能丢最后一段已生成正文。
  if (drainAllJobs) {
    try {
      await drainAllJobs(1500)
    } catch {
      /* 宽限失败不阻塞退出 */
    }
  }
  // 等待已进入加密存储队列的操作结束。
  await authClosed
  app.quit()
})

app.on('activate', () => {
  if (!win) createWindow().catch(e => dialog.showErrorBox('启动失败', String(e?.message || e)))
})

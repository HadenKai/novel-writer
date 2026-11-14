import { startServer } from './app.mjs'

// 前端开发代理固定指向 3789；端口被占用时直接失败，避免静默漂移到其它服务。
startServer(Number(process.env.PORT) || 3789, { strictPort: true }).catch(e => {
  console.error('[novel-writer] 启动失败:', e.message)
  process.exit(1)
})

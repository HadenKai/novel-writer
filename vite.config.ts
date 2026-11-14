import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'development-content-security-policy',
      apply: 'serve',
      transformIndexHtml: {
        order: 'pre',
        handler: html =>
          html.replace(
            /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/?>/i,
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'self'; form-action 'none'\">"
          )
      }
    }
  ],
  server: {
    // 固定绑 IPv4：Node ≥17 的 vite 默认只监听 [::1]（IPv6），会让
    // dev:app 的 `wait-on tcp:127.0.0.1:5173` 永远等待、Electron 壳卡死。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 打包产物在项目内生成，文件被 electron-builder 占用时不该触发 Vite 的文件监听
    watch: {
      ignored: ['**/release/**', '**/dist/**']
    },
    proxy: {
      '/api': 'http://127.0.0.1:3789'
    }
  }
})

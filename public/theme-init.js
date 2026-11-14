// 在首帧前确定明暗主题，避免白闪 / 黑闪。
//
// 独立成文件的原因：index.html 的 CSP 里 script-src 只允许 'self'，
// 内联脚本会被拦截（不这样做就得开 'unsafe-inline'，等于放弃 CSP 的 XSS 防护）。
// 本文件由 vite 原样拷贝到 dist 根目录，以 /theme-init.js 同步加载，
// 保证仍在样式表之后、首次绘制之前执行。
;(function () {
  try {
    var saved = localStorage.getItem('studio-theme-ink')
    var dark = saved ? saved === 'dark' : true
    if (dark) document.documentElement.classList.add('dark')
  } catch (e) {
    /* localStorage 被禁用时按浅色处理 */
  }
})()

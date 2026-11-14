import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
// 标题与正文的宋体：随应用打包的 Noto Serif SC（可变字重，按字符区段懒加载），
// 系统自带的宋体没有真粗体，标题会被浏览器假加粗成发虚的描边。
import '@fontsource-variable/noto-serif-sc'
import './index.css'
import './ui.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)

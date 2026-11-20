const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novelAPI', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  codex: {
    status: () => ipcRenderer.invoke('codex:status'),
    start: () => ipcRenderer.invoke('codex:start'),
    attempt: id => ipcRenderer.invoke('codex:attempt', id),
    openVerification: id => ipcRenderer.invoke('codex:open-verification', id),
    cancel: id => ipcRenderer.invoke('codex:cancel', id),
    disconnect: () => ipcRenderer.invoke('codex:disconnect'),
    listModels: () => ipcRenderer.invoke('codex:list-models'),
    getUsage: force => ipcRenderer.invoke('codex:usage', force === true)
  },
  // 自绘标题栏的窗口控制
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onMaximized: cb => {
    const handler = (_e, v) => cb(v)
    ipcRenderer.on('win:maximized', handler)
    return () => ipcRenderer.removeListener('win:maximized', handler)
  }
})

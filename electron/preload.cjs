const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novelAPI', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
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

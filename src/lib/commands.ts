/** 命令面板的模块级桥：CommandPalette 挂载时注册，任意位置调用 openCommandPalette() 唤起 */
type OpenFn = () => void

let handler: OpenFn | null = null

export function registerCommandPalette(fn: OpenFn) {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

export function openCommandPalette() {
  handler?.()
}

/** 作品 id → 生成式书封的色调序号（CoverArt 的 tone）；同一本书始终是同一种颜色 */
export function coverTone(id: string, title = '') {
  return Array.from(id || title).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4
}

// 从 Workspace.tsx 拆出的组件（原文件 1981 行 → 主文件 + 10 个小文件）。
import { cloneElement, isValidElement, memo, useId } from 'react'
import { labelCls } from './shared'

/**
 * 表单字段壳。
 *
 * 除样式外还负责无障碍关联：single-child 的 input/textarea/select 会被自动补上
 * id 与 aria-labelledby，让「点 label 聚焦」「屏幕阅读器念出字段名」都能工作。
 * 之前只渲染一个孤立 <label>，视觉上像有关联，实际 DOM 里两者毫无关系。
 */
const Field = memo(function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const uid = useId()
  const labelId = `${uid}-label`
  const controlId = `${uid}-control`

  // 只有单一表单控件时才注入 id；多个子节点（如并排两个 input）无法确定归属，交由调用方自行处理。
  const isFormControl = (n: unknown) =>
    isValidElement(n) && typeof n.type === 'string' && ['input', 'textarea', 'select'].includes(n.type)

  let content = children
  if (isFormControl(children)) {
    const el = children as React.ReactElement<{ id?: string; 'aria-labelledby'?: string }>
    content = cloneElement(el, {
      id: el.props.id || controlId,
      'aria-labelledby': el.props['aria-labelledby'] || labelId
    })
  }

  return (
    <div>
      <label id={labelId} htmlFor={isFormControl(children) ? controlId : undefined} className={labelCls}>
        {label}
      </label>
      {content}
    </div>
  )
})

export default Field

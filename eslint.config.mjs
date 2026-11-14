import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

/**
 * ESLint 扁平配置（flat config）。
 *
 * 取值原则：只开「能指出真实缺陷」的规则，不引入审美类规则（排版交给 Prettier）。
 * 因此末尾挂了 eslint-config-prettier，把与 Prettier 冲突的规则一次性关掉，
 * 避免出现「ESLint 说得加分号、Prettier 说你得去掉」这种左右互搏。
 *
 * 三类文件分别处理：
 *   src/**            浏览器环境（React + TS）
 *   server/** electron/**  Node 环境（纯 ESM，无 JSX）
 *   tests/**          Node 环境（node:test）
 */
export default tseslint.config(
  { ignores: ['dist', 'release', 'node_modules', 'data', '*.config.js'] },

  // ── 前端：React + TypeScript ──────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      // Hooks 依赖数组正确性 —— 漏依赖是最常见的一类隐性 bug
      ...reactHooks.configs.recommended.rules,
      // Vite HMR：只导出组件，避免热更新整页刷新
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 允许以 _ 前缀显式标记「有意不用」的形参/变量
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // 空 catch 有时是刻意的（localStorage 在隐私模式下会抛），提示而非报错
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 中文排版：注释与字符串里的全角空格（U+3000）是有意的对齐/分隔，
      // 只在代码本体里拦截，避免误伤文案。
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true }]
    }
  },

  // ── 常量 / 工具模块：本就与组件同文件导出 ──────────────────
  // 这些文件是「组件 + 常量/类型」的共享模块（图标集、面板样式、按钮基类等），
  // 拆开只会增加无意义的文件跳转；HMR 影响可接受，因此关掉该提示。
  {
    files: [
      'src/components/Dialog.tsx',
      'src/components/ModelSelect.tsx',
      'src/pages/butler/constants.tsx',
      'src/pages/workspace/shared.tsx'
    ],
    rules: {
      'react-refresh/only-export-components': 'off'
    }
  },

  // ── 服务端 / 主进程：Node ESM ─────────────────────────────
  {
    files: ['server/**/*.mjs', 'electron/**/*.mjs'],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 同上：提示词模板里大量使用全角空格做中文排版，不应视为缺陷
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true }]
    }
  },

  // ── 测试 ─────────────────────────────────────────────────
  {
    files: ['tests/**/*.mjs'],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      // 测试收尾的清理语句常写成 `try { rmSync(...) } catch {}`：目录可能已被
      // 前面的断言移走，静默失败是预期行为。
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
)

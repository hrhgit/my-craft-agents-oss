import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry, PlaygroundLocale } from './types'
import { Markdown, CollapsibleMarkdownProvider, CodeBlock, InlineCode, MarkdownDatatableBlock, MarkdownSpreadsheetBlock, MarkdownImageBlock, ImageCardStack, PlatformProvider } from '@mortise/ui'

// ============================================================================
// Sample markdown content — prose is bilingual (zh-CN / en), code blocks stay
// identical in both languages.
// ============================================================================

const sampleMarkdownEn = `# Welcome to Markdown

This is a **bold** statement and this is *italic*.

## Code Examples

Here's some inline code: \`const x = 42\`

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`
}

// Call the function
console.log(greet("World"))
\`\`\`

## Lists

- First item
- Second item
  - Nested item
- Third item

1. Numbered one
2. Numbered two
3. Numbered three

## Table

| Name | Role | Status |
|------|------|--------|
| Alice | Developer | Active |
| Bob | Designer | Away |

## Blockquote

> This is a blockquote with some important information
> that spans multiple lines.

---

That's all folks!`

const sampleMarkdownZh = `# 欢迎使用 Markdown

这是 **加粗** 语句，这是 *斜体*。

## 代码示例

这里有一些内联代码：\`const x = 42\`

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`
}

// Call the function
console.log(greet("World"))
\`\`\`

## 列表

- 第一项
- 第二项
  - 嵌套项
- 第三项

1. 编号一
2. 编号二
3. 编号三

## 表格

| 姓名 | 角色 | 状态 |
|------|------|------|
| 爱丽丝 | 开发 | 活跃 |
| 鲍勃 | 设计 | 离开 |

## 引用

> 这是一段包含重要信息的引用
> 它跨越多行。

---

就这些了！`

const codeHeavyMarkdownEn = `# API Response

The endpoint returned:

\`\`\`json
{
  "status": "success",
  "data": {
    "users": [
      { "id": 1, "name": "Alice" },
      { "id": 2, "name": "Bob" }
    ]
  }
}
\`\`\`

Process with:

\`\`\`python
import json

def process_response(data: dict) -> list:
    return [user["name"] for user in data["users"]]
\`\`\`

Or in TypeScript:

\`\`\`typescript
interface User {
  id: number
  name: string
}

const getNames = (users: User[]): string[] =>
  users.map(u => u.name)
\`\`\``

const codeHeavyMarkdownZh = `# API 响应

端点返回：

\`\`\`json
{
  "status": "success",
  "data": {
    "users": [
      { "id": 1, "name": "Alice" },
      { "id": 2, "name": "Bob" }
    ]
  }
}
\`\`\`

使用以下方式处理：

\`\`\`python
import json

def process_response(data: dict) -> list:
    return [user["name"] for user in data["users"]]
\`\`\`

或者使用 TypeScript：

\`\`\`typescript
interface User {
  id: number
  name: string
}

const getNames = (users: User[]): string[] =>
  users.map(u => u.name)
\`\`\``

const richBlockParityMarkdownEn = `# Rich Block Interaction Parity

Use this fixture to compare **inline** and **fullscreen** interactions for Mermaid and image blocks.

- Tap/click inline content to open fullscreen
- In fullscreen: wheel/pinch zoom, drag pan, double-click reset
- Keyboard: Cmd/Ctrl +, -, 0

## Mermaid block

\`\`\`mermaid
graph LR
    A[Input] --> B{Validate}
    B -->|Valid| C[Persist]
    B -->|Invalid| D[Show Error]
    C --> E[Notify]
\`\`\`

## Image block

\`\`\`image-preview
{
  "title": "Parity Check",
  "items": [
    { "src": "/mock/images/gallery-1.png", "label": "Lake" },
    { "src": "/mock/images/gallery-2.png", "label": "Forest" }
  ]
}
\`\`\`
`

const richBlockParityMarkdownZh = `# 富块交互一致性验证

使用此夹具对比 Mermaid 与图片块的 **内联** 与 **全屏** 交互。

- 点击内联内容以打开全屏
- 全屏中：滚轮/捏合缩放、拖拽平移、双击重置
- 键盘：Cmd/Ctrl +、-、0

## Mermaid 块

\`\`\`mermaid
graph LR
    A[Input] --> B{Validate}
    B -->|Valid| C[Persist]
    B -->|Invalid| D[Show Error]
    C --> E[Notify]
\`\`\`

## 图片块

\`\`\`image-preview
{
  "title": "一致性检查",
  "items": [
    { "src": "/mock/images/gallery-1.png", "label": "湖泊" },
    { "src": "/mock/images/gallery-2.png", "label": "森林" }
  ]
}
\`\`\`
`

/** Pick the localized sample content for the given playground locale. */
function pickLocale<T>(locale: PlaygroundLocale, en: T, zh: T): T {
  return locale === 'zh-CN' ? zh : en
}

const sampleMarkdown = (locale: PlaygroundLocale) => pickLocale(locale, sampleMarkdownEn, sampleMarkdownZh)

const codeHeavyMarkdown = (locale: PlaygroundLocale) => pickLocale(locale, codeHeavyMarkdownEn, codeHeavyMarkdownZh)

const richBlockParityMarkdown = (locale: PlaygroundLocale) => pickLocale(locale, richBlockParityMarkdownEn, richBlockParityMarkdownZh)

// ── Pure code samples — identical in both languages ───────────────────────

const typescriptCode = `import { useState, useEffect } from 'react'

interface Todo {
  id: number
  title: string
  completed: boolean
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/todos')
      .then(res => res.json())
      .then(data => {
        setTodos(data)
        setLoading(false)
      })
  }, [])

  return { todos, loading }
}`

const pythonCode = `from dataclasses import dataclass
from typing import Optional

@dataclass
class User:
    id: int
    name: str
    email: Optional[str] = None

def get_user_by_id(user_id: int) -> Optional[User]:
    """Fetch user from database."""
    # Simulated database lookup
    users = {
        1: User(1, "Alice", "alice@example.com"),
        2: User(2, "Bob"),
    }
    return users.get(user_id)`

const jsonCode = `{
  "name": "mortise",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build"
  }
}`

// ============================================================================
// Mock specs — bilingual data for datatable / spreadsheet / image blocks.
// Image paths and URLs stay identical; labels, titles and filenames are
// translated for zh-CN.
// ============================================================================

const datatableSalesSpec = {
  en: {
    title: 'Sales by Region',
    columns: [
      { key: 'region', label: 'Region', type: 'text' },
      { key: 'revenue', label: 'Revenue', type: 'currency' },
      { key: 'growth', label: 'Growth', type: 'percent' },
      { key: 'units', label: 'Units Sold', type: 'number' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    rows: [
      { region: 'North America', revenue: 1250000, growth: 0.124, units: 8420, status: 'Active' },
      { region: 'Europe', revenue: 980000, growth: 0.087, units: 6230, status: 'Active' },
      { region: 'Asia Pacific', revenue: 1580000, growth: 0.215, units: 12100, status: 'Active' },
      { region: 'Latin America', revenue: 420000, growth: -0.032, units: 2800, status: 'Revoked' },
      { region: 'Middle East', revenue: 310000, growth: 0.156, units: 1900, status: 'Active' },
    ],
  },
  zh: {
    title: '各区域销售',
    columns: [
      { key: 'region', label: '区域', type: 'text' },
      { key: 'revenue', label: '收入', type: 'currency' },
      { key: 'growth', label: '增长率', type: 'percent' },
      { key: 'units', label: '销量', type: 'number' },
      { key: 'status', label: '状态', type: 'badge' },
    ],
    rows: [
      { region: '北美', revenue: 1250000, growth: 0.124, units: 8420, status: '活跃' },
      { region: '欧洲', revenue: 980000, growth: 0.087, units: 6230, status: '活跃' },
      { region: '亚太', revenue: 1580000, growth: 0.215, units: 12100, status: '活跃' },
      { region: '拉丁美洲', revenue: 420000, growth: -0.032, units: 2800, status: '已撤销' },
      { region: '中东', revenue: 310000, growth: 0.156, units: 1900, status: '活跃' },
    ],
  },
}

const datatableApiKeysSpec = {
  en: {
    title: 'API Keys',
    columns: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'active', label: 'Active', type: 'boolean' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    rows: [
      { name: 'Production', active: true, status: 'Passing' },
      { name: 'Staging', active: true, status: 'Passing' },
      { name: 'Legacy', active: false, status: 'Failed' },
    ],
  },
  zh: {
    title: 'API 密钥',
    columns: [
      { key: 'name', label: '名称', type: 'text' },
      { key: 'active', label: '启用', type: 'boolean' },
      { key: 'status', label: '状态', type: 'badge' },
    ],
    rows: [
      { name: '生产', active: true, status: '通过' },
      { name: '预发布', active: true, status: '通过' },
      { name: '旧版', active: false, status: '失败' },
    ],
  },
}

const spreadsheetRevenueSpec = {
  en: {
    filename: 'Q1_Revenue.xlsx',
    sheetName: 'Summary',
    columns: [
      { key: 'region', label: 'Region', type: 'text' },
      { key: 'q1', label: 'Q1', type: 'currency' },
      { key: 'q2', label: 'Q2', type: 'currency' },
      { key: 'change', label: 'Change', type: 'percent' },
      { key: 'total', label: 'Total', type: 'formula' },
    ],
    rows: [
      { region: 'North', q1: 500000, q2: 620000, change: 0.24, total: 1120000 },
      { region: 'South', q1: 340000, q2: 310000, change: -0.088, total: 650000 },
      { region: 'East', q1: 780000, q2: 850000, change: 0.09, total: 1630000 },
      { region: 'West', q1: 420000, q2: 480000, change: 0.143, total: 900000 },
    ],
  },
  zh: {
    filename: 'Q1_收入.xlsx',
    sheetName: '汇总',
    columns: [
      { key: 'region', label: '区域', type: 'text' },
      { key: 'q1', label: 'Q1', type: 'currency' },
      { key: 'q2', label: 'Q2', type: 'currency' },
      { key: 'change', label: '变化', type: 'percent' },
      { key: 'total', label: '合计', type: 'formula' },
    ],
    rows: [
      { region: '北部', q1: 500000, q2: 620000, change: 0.24, total: 1120000 },
      { region: '南部', q1: 340000, q2: 310000, change: -0.088, total: 650000 },
      { region: '东部', q1: 780000, q2: 850000, change: 0.09, total: 1630000 },
      { region: '西部', q1: 420000, q2: 480000, change: 0.143, total: 900000 },
    ],
  },
}

const spreadsheetSimpleSpec = {
  en: {
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'qty', label: 'Quantity', type: 'number' },
      { key: 'price', label: 'Price', type: 'currency' },
    ],
    rows: [
      { item: 'Widget A', qty: 100, price: 29 },
      { item: 'Widget B', qty: 250, price: 15 },
      { item: 'Widget C', qty: 50, price: 89 },
    ],
  },
  zh: {
    columns: [
      { key: 'item', label: '项目', type: 'text' },
      { key: 'qty', label: '数量', type: 'number' },
      { key: 'price', label: '价格', type: 'currency' },
    ],
    rows: [
      { item: '部件 A', qty: 100, price: 29 },
      { item: '部件 B', qty: 250, price: 15 },
      { item: '部件 C', qty: 50, price: 89 },
    ],
  },
}

// Image paths / URLs stay identical across locales; labels are translated.

const MOCK_IMAGE_DATA: Record<string, string> = {
  '/mock/images/gallery-1.png': 'https://picsum.photos/id/1015/1200/900',
  '/mock/images/gallery-2.png': 'https://picsum.photos/id/1025/900/1200',
  '/mock/images/gallery-3.png': 'https://picsum.photos/id/1035/1400/900',
  '/mock/images/gallery-4.png': 'https://picsum.photos/id/1043/1200/900',
  '/mock/images/gallery-5.png': 'https://picsum.photos/id/1067/1200/900',
}

const imageStackMixedSpec = {
  en: [
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Lake', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Forest', ratio: 3 / 4 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Sunset', ratio: 16 / 9 },
  ],
  zh: [
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: '湖泊', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: '森林', ratio: 3 / 4 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: '日落', ratio: 16 / 9 },
  ],
}

const imageStackLargeSpec = {
  en: [
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Shot 1', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Shot 2', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Shot 3', ratio: 16 / 9 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-4.png'], label: 'Shot 4', ratio: 3 / 4 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-5.png'], label: 'Shot 5', ratio: 4 / 3 },
  ],
  zh: [
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: '照片 1', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: '照片 2', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: '照片 3', ratio: 16 / 9 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-4.png'], label: '照片 4', ratio: 3 / 4 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-5.png'], label: '照片 5', ratio: 4 / 3 },
  ],
}

const imageStackSubtleSpec = {
  en: [
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'One', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Two', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Three', ratio: 4 / 3 },
  ],
  zh: [
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: '一', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: '二', ratio: 4 / 3 },
    { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: '三', ratio: 4 / 3 },
  ],
}

const imagePreviewGallerySpec = {
  en: {
    title: 'Image Gallery',
    items: [
      { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
      { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
      { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
    ],
  },
  zh: {
    title: '图片画廊',
    items: [
      { src: '/mock/images/gallery-1.png', label: '湖泊', ratio: 4 / 3 },
      { src: '/mock/images/gallery-2.png', label: '森林', ratio: 3 / 4 },
      { src: '/mock/images/gallery-3.png', label: '日落', ratio: 16 / 9 },
    ],
  },
}

const imagePreviewSingleSpec = {
  en: {
    title: 'Single Image',
    src: '/mock/images/gallery-1.png',
  },
  zh: {
    title: '单张图片',
    src: '/mock/images/gallery-1.png',
  },
}

const imagePreviewStackSpec = {
  en: {
    title: 'Gallery Stack',
    items: [
      { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
      { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
      { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
      { src: '/mock/images/gallery-4.png', label: 'City', ratio: 4 / 3 },
    ],
  },
  zh: {
    title: '画廊堆叠',
    items: [
      { src: '/mock/images/gallery-1.png', label: '湖泊', ratio: 4 / 3 },
      { src: '/mock/images/gallery-2.png', label: '森林', ratio: 3 / 4 },
      { src: '/mock/images/gallery-3.png', label: '日落', ratio: 16 / 9 },
      { src: '/mock/images/gallery-4.png', label: '城市', ratio: 4 / 3 },
    ],
  },
}

const imagePreviewMissingSpec = {
  en: {
    title: 'Missing Image',
    items: [
      { src: '/mock/images/gallery-1.png', label: 'Found' },
      { src: '/mock/images/does-not-exist.png', label: 'Missing' },
    ],
  },
  zh: {
    title: '缺失的图片',
    items: [
      { src: '/mock/images/gallery-1.png', label: '已找到' },
      { src: '/mock/images/does-not-exist.png', label: '缺失' },
    ],
  },
}

// ============================================================================
// Demo wrappers / components
// ============================================================================

// Wrapper for collapsible markdown
function CollapsibleWrapper({ children }: { children: React.ReactNode }) {
  return <CollapsibleMarkdownProvider>{children}</CollapsibleMarkdownProvider>
}

function MarkdownImageBlockWrapper({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <PlatformProvider
      actions={{
        onReadFileDataUrl: async (path: string) => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          const dataUrl = MOCK_IMAGE_DATA[path]
          if (!dataUrl) {
            throw new Error(t('playground.markdown.mockImageNotFound', { path }))
          }
          return dataUrl
        },
      }}
    >
      {children}
    </PlatformProvider>
  )
}

function ImageCardStackPlayground({
  items,
  maxRotate,
}: {
  items: Array<{ src: string; label?: string; ratio?: number }> | string
  maxRotate: number
}) {
  const { t } = useTranslation()
  const parsedItems = React.useMemo(() => {
    if (Array.isArray(items)) return items
    if (typeof items === 'string') {
      try {
        const parsed = JSON.parse(items)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }, [items])

  const [currentIndex, setCurrentIndex] = React.useState(0)

  React.useEffect(() => {
    setCurrentIndex(0)
  }, [parsedItems])

  const currentLabel = Math.min(currentIndex + 1, Math.max(parsedItems.length, 1))

  return (
    <div className="h-full w-full p-4 flex flex-col gap-3">
      <div className="text-xs text-muted-foreground flex items-center justify-between">
        <span>{t('playground.markdown.activeCard', { current: currentLabel, total: parsedItems.length })}</span>
        <span>{t('playground.markdown.swipeHint')}</span>
      </div>
      <div className="flex-1 min-h-0 rounded-md border border-border/60 bg-muted/20 p-4 flex items-center justify-center">
        {parsedItems.length > 0 ? (
          <div className="h-[320px] w-full">
            <ImageCardStack items={parsedItems} currentIndex={currentIndex} onIndexChange={setCurrentIndex} maxRotate={maxRotate} maxHeight={320} />
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
            {t('playground.markdown.invalidItemsJson')}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const markdownComponents: ComponentEntry[] = [
  {
    id: 'markdown',
    name: 'Markdown',
    nameZh: 'Markdown 渲染器',
    category: 'Markdown',
    description: 'Customizable markdown renderer with three render modes: terminal, minimal, full',
    descriptionZh: '可定制的 markdown 渲染器，支持三种渲染模式：terminal、minimal、full',
    component: Markdown,
    layout: 'top',
    props: [
      {
        name: 'children',
        nameZh: '内容',
        description: 'Markdown content to render',
        descriptionZh: '要渲染的 Markdown 内容',
        control: { type: 'textarea', rows: 10 },
        defaultValue: sampleMarkdown('en'),
      },
      {
        name: 'mode',
        nameZh: '模式',
        description: 'Render mode controlling formatting level',
        descriptionZh: '控制格式化程度的渲染模式',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'minimal',
      },
      {
        name: 'collapsible',
        nameZh: '可折叠',
        description: 'Enable collapsible headings',
        descriptionZh: '启用可折叠标题',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Terminal', nameZh: '终端模式', props: { children: sampleMarkdown('en'), mode: 'terminal' } },
      { name: 'Minimal', nameZh: '极简模式', props: { children: sampleMarkdown('en'), mode: 'minimal' } },
      { name: 'Full', nameZh: '完整模式', props: { children: sampleMarkdown('en'), mode: 'full' } },
      { name: 'Code Heavy', nameZh: '代码密集', props: { children: codeHeavyMarkdown('en'), mode: 'minimal' } },
      { name: 'Collapsible', nameZh: '可折叠', props: { children: sampleMarkdown('en'), mode: 'full', collapsible: true } },
    ],
    mockData: (locale) => ({
      children: sampleMarkdown(locale),
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
    wrapper: CollapsibleWrapper,
  },
  {
    id: 'code-block',
    name: 'CodeBlock',
    nameZh: '代码块',
    category: 'Markdown',
    description: 'Syntax highlighted code block using Shiki with copy button',
    descriptionZh: '使用 Shiki 语法高亮的代码块，带复制按钮',
    component: CodeBlock,
    props: [
      {
        name: 'code',
        nameZh: '代码',
        description: 'Code to display',
        descriptionZh: '要显示的代码',
        control: { type: 'textarea', rows: 8 },
        defaultValue: typescriptCode,
      },
      {
        name: 'language',
        nameZh: '语言',
        description: 'Programming language for syntax highlighting',
        descriptionZh: '用于语法高亮的编程语言',
        control: {
          type: 'select',
          options: [
            { label: 'TypeScript', value: 'typescript' },
            { label: 'JavaScript', value: 'javascript' },
            { label: 'Python', value: 'python' },
            { label: 'JSON', value: 'json' },
            { label: 'Bash', value: 'bash' },
            { label: 'Plain Text', value: 'text' },
          ],
        },
        defaultValue: 'typescript',
      },
      {
        name: 'mode',
        nameZh: '模式',
        description: 'Render mode',
        descriptionZh: '渲染模式',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'TypeScript Full', nameZh: 'TypeScript 完整', props: { code: typescriptCode, language: 'typescript', mode: 'full' } },
      { name: 'TypeScript Minimal', nameZh: 'TypeScript 极简', props: { code: typescriptCode, language: 'typescript', mode: 'minimal' } },
      { name: 'Python', nameZh: 'Python', props: { code: pythonCode, language: 'python', mode: 'full' } },
      { name: 'JSON', nameZh: 'JSON', props: { code: jsonCode, language: 'json', mode: 'full' } },
    ],
  },
  {
    id: 'inline-code',
    name: 'InlineCode',
    nameZh: '行内代码',
    category: 'Markdown',
    description: 'Styled inline code span with subtle background and border',
    descriptionZh: '带细微背景与边框样式的行内代码片段',
    component: InlineCode,
    props: [
      {
        name: 'children',
        nameZh: '内容',
        description: 'Code text',
        descriptionZh: '代码文本',
        control: { type: 'string' },
        defaultValue: 'const x = 42',
      },
    ],
    variants: [
      { name: 'Variable', nameZh: '变量', props: { children: 'useState' } },
      { name: 'Function', nameZh: '函数', props: { children: 'handleClick()' } },
      { name: 'Type', nameZh: '类型', props: { children: 'React.FC<Props>' } },
      { name: 'Path', nameZh: '路径', props: { children: 'src/components/App.tsx' } },
    ],
  },
  {
    id: 'datatable-block',
    name: 'MarkdownDatatableBlock',
    nameZh: '数据表块',
    category: 'Markdown',
    description: 'Interactive data table with sorting for ```datatable code blocks',
    descriptionZh: '用于 ```datatable 代码块的交互式数据表，支持排序',
    component: MarkdownDatatableBlock,
    props: [
      {
        name: 'code',
        nameZh: '代码',
        description: 'JSON string with columns and rows',
        descriptionZh: '包含列与行的 JSON 字符串',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify(datatableSalesSpec.en, null, 2),
      },
    ],
    variants: [
      {
        name: 'Sales Data',
        nameZh: '销售数据',
        props: {
          code: JSON.stringify(datatableSalesSpec.en, null, 2),
        },
      },
      {
        name: 'Boolean & Badge Types',
        nameZh: '布尔与徽章类型',
        props: {
          code: JSON.stringify(datatableApiKeysSpec.en, null, 2),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        nameZh: '无效 JSON（回退）',
        props: { code: '{ invalid json here' },
      },
    ],
    mockData: (locale) => ({
      code: JSON.stringify(pickLocale(locale, datatableSalesSpec.en, datatableSalesSpec.zh), null, 2),
    }),
  },
  {
    id: 'spreadsheet-block',
    name: 'MarkdownSpreadsheetBlock',
    nameZh: '电子表格块',
    category: 'Markdown',
    description: 'Excel-style grid with column letters and row numbers for ```spreadsheet code blocks',
    descriptionZh: '用于 ```spreadsheet 代码块的 Excel 风格网格，带列字母与行号',
    component: MarkdownSpreadsheetBlock,
    props: [
      {
        name: 'code',
        nameZh: '代码',
        description: 'JSON string with columns and rows',
        descriptionZh: '包含列与行的 JSON 字符串',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify(spreadsheetRevenueSpec.en, null, 2),
      },
    ],
    variants: [
      {
        name: 'Revenue Sheet',
        nameZh: '收入表',
        props: {
          code: JSON.stringify(spreadsheetRevenueSpec.en, null, 2),
        },
      },
      {
        name: 'Simple Sheet (No Filename)',
        nameZh: '简单表格（无文件名）',
        props: {
          code: JSON.stringify(spreadsheetSimpleSpec.en, null, 2),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        nameZh: '无效 JSON（回退）',
        props: { code: '{ invalid json here' },
      },
    ],
    mockData: (locale) => ({
      code: JSON.stringify(pickLocale(locale, spreadsheetRevenueSpec.en, spreadsheetRevenueSpec.zh), null, 2),
    }),
  },
  {
    id: 'image-card-stack',
    name: 'ImageCardStack',
    nameZh: '图片卡片堆叠',
    category: 'Markdown',
    description: 'Swipeable card stack used for image gallery previews.',
    descriptionZh: '用于图片画廊预览的可滑动卡片堆叠。',
    component: ImageCardStackPlayground,
    layout: 'full',
    props: [
      {
        name: 'items',
        nameZh: '项目',
        description: 'Gallery items with optional aspect ratio values (width/height).',
        descriptionZh: '画廊项目，可包含可选宽高比（宽度/高度）。',
        control: { type: 'textarea', rows: 10 },
        defaultValue: JSON.stringify(imageStackMixedSpec.en, null, 2),
      },
      {
        name: 'maxRotate',
        nameZh: '最大旋转',
        description: 'Maximum baseline random card rotation in degrees.',
        descriptionZh: '卡片基线随机旋转的最大角度（度）。',
        control: { type: 'number', min: 0, max: 16, step: 1 },
        defaultValue: 5,
      },
    ],
    variants: [
      {
        name: 'Mixed Ratios',
        nameZh: '混合比例',
        props: {
          items: JSON.stringify(imageStackMixedSpec.en, null, 2),
          maxRotate: 5,
        },
      },
      {
        name: 'Large Gallery',
        nameZh: '大画廊',
        props: {
          items: JSON.stringify(imageStackLargeSpec.en, null, 2),
          maxRotate: 7,
        },
      },
      {
        name: 'Subtle Rotation',
        nameZh: '微旋转',
        props: {
          items: JSON.stringify(imageStackSubtleSpec.en, null, 2),
          maxRotate: 2,
        },
      },
    ],
    mockData: (locale) => ({
      items: JSON.stringify(pickLocale(locale, imageStackMixedSpec.en, imageStackMixedSpec.zh), null, 2),
    }),
  },
  {
    id: 'markdown-image-block',
    name: 'MarkdownImageBlock',
    nameZh: '图片预览块',
    category: 'Markdown',
    description: 'Renders ```image-preview blocks with card-stack galleries and fullscreen overlay support.',
    descriptionZh: '渲染 ```image-preview 代码块，支持卡片堆叠画廊与全屏浮层。',
    component: MarkdownImageBlock,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'code',
        nameZh: '代码',
        description: 'JSON spec for image-preview block.',
        descriptionZh: 'image-preview 块的 JSON 规范。',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify(imagePreviewGallerySpec.en, null, 2),
      },
    ],
    variants: [
      {
        name: 'Single Image',
        nameZh: '单张图片',
        props: {
          code: JSON.stringify(imagePreviewSingleSpec.en, null, 2),
        },
      },
      {
        name: 'Gallery Stack',
        nameZh: '画廊堆叠',
        props: {
          code: JSON.stringify(imagePreviewStackSpec.en, null, 2),
        },
      },
      {
        name: 'Unknown Path Error',
        nameZh: '未知路径错误',
        props: {
          code: JSON.stringify(imagePreviewMissingSpec.en, null, 2),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        nameZh: '无效 JSON（回退）',
        props: { code: '{ invalid json here' },
      },
    ],
    mockData: (locale) => ({
      code: JSON.stringify(pickLocale(locale, imagePreviewGallerySpec.en, imagePreviewGallerySpec.zh), null, 2),
    }),
  },
  {
    id: 'rich-block-interaction-parity',
    name: 'RichBlockInteractionParity',
    nameZh: '富块交互一致性',
    category: 'Markdown',
    description: 'Single playground fixture to verify inline + fullscreen interaction parity across Mermaid and image-preview blocks.',
    descriptionZh: '单个 Playground 夹具，用于验证 Mermaid 与 image-preview 块的内联与全屏交互一致性。',
    component: Markdown,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'children',
        nameZh: '内容',
        description: 'Markdown fixture for parity checks',
        descriptionZh: '用于一致性检查的 Markdown 夹具',
        control: { type: 'textarea', rows: 20 },
        defaultValue: richBlockParityMarkdown('en'),
      },
      {
        name: 'mode',
        nameZh: '模式',
        description: 'Render mode controlling formatting level',
        descriptionZh: '控制格式化程度的渲染模式',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'Parity Fixture', nameZh: '一致性夹具', props: { children: richBlockParityMarkdown('en'), mode: 'full' } },
    ],
    mockData: (locale) => ({
      children: richBlockParityMarkdown(locale),
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
  },
]

import type { ComponentEntry } from './types'
import { MortiseLogo } from '@/components/icons/MortiseLogo'
import { MortiseSymbol } from '@/components/icons/MortiseSymbol'
import { PanelLeftRounded } from '@/components/icons/PanelLeftRounded'
import { SquarePenRounded } from '@/components/icons/SquarePenRounded'

export const iconComponents: ComponentEntry[] = [
  {
    id: 'mortise-logo',
    name: 'MortiseLogo',
    category: 'Icons',
    description: 'Full Mortise branding logo with text',
    descriptionZh: '带文字的完整 Mortise 品牌标志',
    component: MortiseLogo,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes for sizing and styling',
        descriptionZh: '用于尺寸和样式的 Tailwind 类',
        control: { type: 'string' },
        defaultValue: 'h-8',
      },
    ],
    variants: [
      { name: 'Small', nameZh: '小', props: { className: 'h-6' } },
      { name: 'Medium', nameZh: '中', props: { className: 'h-8' } },
      { name: 'Large', nameZh: '大', props: { className: 'h-12' } },
    ],
  },
  {
    id: 'mortise-symbol',
    name: 'MortiseSymbol',
    category: 'Icons',
    description: 'Mortise modular M symbol icon (brand color: #9570BE)',
    descriptionZh: 'Mortise 模块化 M 形图标（品牌色：#9570BE）',
    component: MortiseSymbol,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes for sizing',
        descriptionZh: '用于尺寸的 Tailwind 类',
        control: { type: 'string' },
        defaultValue: 'h-6 w-6',
      },
    ],
    variants: [
      { name: 'Small', nameZh: '小', props: { className: 'h-4 w-4' } },
      { name: 'Medium', nameZh: '中', props: { className: 'h-6 w-6' } },
      { name: 'Large', nameZh: '大', props: { className: 'h-10 w-10' } },
    ],
  },
  {
    id: 'panel-left-rounded',
    name: 'PanelLeftRounded',
    category: 'Icons',
    description: 'Sidebar toggle icon with rounded corners',
    descriptionZh: '圆角侧边栏切换图标',
    component: PanelLeftRounded,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes',
        descriptionZh: 'Tailwind 类',
        control: { type: 'string' },
        defaultValue: 'h-5 w-5',
      },
    ],
    variants: [
      { name: 'Default', nameZh: '默认', props: { className: 'h-5 w-5' } },
      { name: 'Large', nameZh: '大', props: { className: 'h-8 w-8' } },
      { name: 'Muted', nameZh: '弱化', props: { className: 'h-5 w-5 text-muted-foreground' } },
    ],
  },
  {
    id: 'square-pen-rounded',
    name: 'SquarePenRounded',
    category: 'Icons',
    description: 'New chat/compose icon with rounded corners',
    descriptionZh: '圆角新建聊天/撰写图标',
    component: SquarePenRounded,
    props: [
      {
        name: 'className',
        description: 'Tailwind classes',
        descriptionZh: 'Tailwind 类',
        control: { type: 'string' },
        defaultValue: 'h-5 w-5',
      },
    ],
    variants: [
      { name: 'Default', nameZh: '默认', props: { className: 'h-5 w-5' } },
      { name: 'Large', nameZh: '大', props: { className: 'h-8 w-8' } },
      { name: 'Primary', nameZh: '主要', props: { className: 'h-5 w-5 text-foreground' } },
    ],
  },
]

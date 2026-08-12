import { ExtensionInteractionComposer } from '@/components/extensions/ExtensionInteractionComposer'
import type { ExtensionInteractionBridgeRequestV1 } from '@mortise/shared/protocol'
import type { ComponentEntry, PlaygroundLocale } from './types'

const requestBase = {
  type: 'extension_interaction_request',
  requestId: 'preview-request',
  sessionId: 'preview-session',
  extensionId: 'preview-extension',
  runtimeId: 'preview-runtime',
} as const

const selectRequest = (locale: PlaygroundLocale): ExtensionInteractionBridgeRequestV1 => {
  const zh = locale === 'zh-CN'
  return {
    ...requestBase,
    request: {
      schemaVersion: 1,
      title: zh ? '你更倾向于哪种开发方式？' : 'Which development approach do you prefer?',
      description: zh ? '选择一个选项，或写下你自己的答案。' : 'Choose one option or write your own answer.',
      fields: [{
        id: 'approach',
        kind: 'choice',
        label: zh ? '开发方式' : 'Approach',
        required: true,
        options: [
          {
            id: 'prototype',
            label: zh ? '快速原型' : 'Rapid prototype',
            description: zh ? '先做出可用的版本，再逐步完善。' : 'Build a working version first, then refine it.',
          },
          {
            id: 'design-first',
            label: zh ? '先设计再实现' : 'Design before implementation',
            description: zh ? '在编码前明确架构和边界。' : 'Clarify architecture and boundaries before coding.',
          },
          {
            id: 'test-driven',
            label: zh ? '测试驱动' : 'Test-driven',
            description: zh ? '先定义验证方式，再实现行为。' : 'Define verification first, then implement the behavior.',
          },
        ],
      }],
    },
  }
}

const multipleRequest = (locale: PlaygroundLocale): ExtensionInteractionBridgeRequestV1 => {
  const zh = locale === 'zh-CN'
  const toolLabels = ['VS Code', 'Git', 'Docker', 'Postman']
  return {
    ...requestBase,
    requestId: 'preview-multiple',
    request: {
      schemaVersion: 1,
      title: zh ? '你经常使用哪些工具？' : 'Which tools do you use regularly?',
      fields: [{
        id: 'tools',
        kind: 'choice',
        label: zh ? '工具' : 'Tools',
        multiple: true,
        options: toolLabels.map(label => ({ id: label.toLowerCase().replaceAll(' ', '-'), label })),
      }],
    },
  }
}

const wizardRequest = (locale: PlaygroundLocale): ExtensionInteractionBridgeRequestV1 => {
  const zh = locale === 'zh-CN'
  return {
    ...requestBase,
    requestId: 'preview-wizard',
    extensionId: 'ask-user',
    request: {
      schemaVersion: 1,
      presentation: { mode: 'wizard', allowSkip: true, autoAdvanceSingleChoice: true },
      fields: [
        {
          id: 'direction',
          kind: 'choice',
          label: zh ? '我们应该采用哪个实现方向？' : 'Which implementation direction should we use?',
          description: zh ? '选择最符合预期范围的选项。' : 'Choose the option that best matches the intended scope.',
          options: [
            {
              id: 'focused',
              label: zh ? '聚焦式改动' : 'Focused change',
              description: zh ? '保持现有架构，只更新受影响的流程。' : 'Keep the current architecture and update only the affected flow.',
            },
            {
              id: 'broader',
              label: zh ? '更广泛的重新设计' : 'Broader redesign',
              description: zh ? '同时重构周边的交互模型。' : 'Rework the surrounding interaction model at the same time.',
            },
          ],
        },
        {
          id: 'areas',
          kind: 'choice',
          label: zh ? '哪些方面最重要？' : 'Which areas matter most?',
          multiple: true,
          options: [
            { id: 'behavior', label: zh ? '交互行为' : 'Interaction behavior' },
            { id: 'visual', label: zh ? '视觉打磨' : 'Visual polish' },
            { id: 'accessibility', label: zh ? '无障碍' : 'Accessibility' },
          ],
        },
        {
          id: 'notes',
          kind: 'text',
          label: zh ? '还有其他需要考虑的吗？' : 'Anything else we should account for?',
          description: zh ? '可选细节将与此答案一并保留。' : 'Optional details will be kept with this answer.',
          multiline: true,
        },
      ],
    },
  }
}

const directRequest = (locale: PlaygroundLocale): ExtensionInteractionBridgeRequestV1 => {
  const zh = locale === 'zh-CN'
  return {
    ...requestBase,
    requestId: 'preview-editor',
    request: {
      schemaVersion: 1,
      title: zh ? '应该改变什么？' : 'What should be different?',
      fields: [{ id: 'difference', kind: 'text', label: zh ? '差异' : 'Difference', multiline: true }],
    },
  }
}

const confirmRequest = (locale: PlaygroundLocale): ExtensionInteractionBridgeRequestV1 => {
  const zh = locale === 'zh-CN'
  return {
    ...requestBase,
    requestId: 'preview-confirm',
    request: {
      schemaVersion: 1,
      title: zh ? '应用这些更改？' : 'Apply these changes?',
      description: zh ? '这将更新当前工作区。' : 'This will update the current workspace.',
      fields: [{ id: 'apply', kind: 'confirm', label: zh ? '应用更改' : 'Apply changes' }],
    },
  }
}

export const inputComponents: ComponentEntry[] = [{
  id: 'extension-interaction-composer',
  name: 'Extension Interaction Composer',
  nameZh: '扩展交互输入框',
  category: 'Chat Inputs',
  description: 'Inline Pi extension request that replaces the regular chat composer.',
  descriptionZh: '替换常规聊天输入框的内联 Pi 扩展请求。',
  component: ExtensionInteractionComposer,
  layout: 'top',
  props: [],
  mockData: (locale) => ({ event: selectRequest(locale), onRespond: () => {} }),
  variants: [
    { name: 'Wizard', nameZh: '向导', props: { event: wizardRequest('en') } },
    { name: 'Select', nameZh: '选择', props: { event: selectRequest('en') } },
    { name: 'Multiple select', nameZh: '多选', props: { event: multipleRequest('en') } },
    {
      name: 'Direct input',
      nameZh: '直接输入',
      props: {
        event: directRequest('en') satisfies ExtensionInteractionBridgeRequestV1,
      },
    },
    {
      name: 'Confirmation',
      nameZh: '确认',
      props: {
        event: confirmRequest('en') satisfies ExtensionInteractionBridgeRequestV1,
      },
    },
  ],
}]

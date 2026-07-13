import { RemoteUIComposer, type RemoteUIRequest } from '@/components/extensions/RemoteUIModal'
import type { ComponentEntry } from './types'

const requestBase = {
  type: 'remoteui_request',
  requestId: 'preview-request',
  source: 'preview',
  sessionId: 'preview-session',
  extensionId: 'legacy-extension',
  runtimeId: 'preview-runtime',
} as const

const selectRequest: RemoteUIRequest = {
  ...requestBase,
  kind: 'select',
  title: 'Which development approach do you prefer?',
  message: 'Choose one option or write your own answer.',
  options: [
    { title: 'Rapid prototype', description: 'Build a working version first, then refine it.' },
    { title: 'Design before implementation', description: 'Clarify architecture and boundaries before coding.' },
    { title: 'Test-driven', description: 'Define verification first, then implement the behavior.' },
  ],
  allowFreeform: true,
}

const multipleRequest: RemoteUIRequest = {
  ...requestBase,
  requestId: 'preview-multiple',
  kind: 'select',
  title: 'Which tools do you use regularly?',
  message: 'Choose every option that applies, or write a different answer.',
  options: [
    { title: 'VS Code' },
    { title: 'Git' },
    { title: 'Docker' },
    { title: 'Postman' },
  ],
  allowMultiple: true,
  allowFreeform: true,
}

export const inputComponents: ComponentEntry[] = [{
  id: 'remote-ui-composer',
  name: 'Remote UI Composer',
  category: 'Chat Inputs',
  description: 'Inline Pi extension request that replaces the regular chat composer.',
  component: RemoteUIComposer,
  layout: 'top',
  props: [],
    mockData: () => ({ request: selectRequest, onRespond: () => {} }),
  variants: [
    { name: 'Select', props: { request: selectRequest } },
    { name: 'Multiple select', props: { request: multipleRequest } },
    {
      name: 'Direct input',
      props: {
        request: {
          ...requestBase,
          requestId: 'preview-editor',
          kind: 'editor',
          title: 'What should be different?',
          prefill: '',
        } satisfies RemoteUIRequest,
      },
    },
    {
      name: 'Confirmation',
      props: {
        request: {
          ...requestBase,
          requestId: 'preview-confirm',
          kind: 'confirm',
          title: 'Apply these changes?',
          message: 'This will update the current workspace.',
        } satisfies RemoteUIRequest,
      },
    },
  ],
}]

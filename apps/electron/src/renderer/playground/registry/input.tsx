import { ExtensionInteractionComposer } from '@/components/extensions/ExtensionInteractionComposer'
import type { ExtensionInteractionBridgeRequestV1 } from '@mortise/shared/protocol'
import type { ComponentEntry } from './types'

const requestBase = {
  type: 'extension_interaction_request',
  requestId: 'preview-request',
  sessionId: 'preview-session',
  extensionId: 'preview-extension',
  runtimeId: 'preview-runtime',
} as const

const selectRequest: ExtensionInteractionBridgeRequestV1 = {
  ...requestBase,
  request: {
    schemaVersion: 1,
    title: 'Which development approach do you prefer?',
    description: 'Choose one option or write your own answer.',
    fields: [{
      id: 'approach',
      kind: 'choice',
      label: 'Approach',
      required: true,
      options: [
        { id: 'prototype', label: 'Rapid prototype', description: 'Build a working version first, then refine it.' },
        { id: 'design-first', label: 'Design before implementation', description: 'Clarify architecture and boundaries before coding.' },
        { id: 'test-driven', label: 'Test-driven', description: 'Define verification first, then implement the behavior.' },
      ],
    }],
  },
}

const multipleRequest: ExtensionInteractionBridgeRequestV1 = {
  ...requestBase,
  requestId: 'preview-multiple',
  request: {
    schemaVersion: 1,
    title: 'Which tools do you use regularly?',
    fields: [{
      id: 'tools',
      kind: 'choice',
      label: 'Tools',
      multiple: true,
      options: ['VS Code', 'Git', 'Docker', 'Postman'].map(label => ({ id: label.toLowerCase().replaceAll(' ', '-'), label })),
    }],
  },
}

const wizardRequest: ExtensionInteractionBridgeRequestV1 = {
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
        label: 'Which implementation direction should we use?',
        description: 'Choose the option that best matches the intended scope.',
        options: [
          { id: 'focused', label: 'Focused change', description: 'Keep the current architecture and update only the affected flow.' },
          { id: 'broader', label: 'Broader redesign', description: 'Rework the surrounding interaction model at the same time.' },
        ],
      },
      {
        id: 'areas',
        kind: 'choice',
        label: 'Which areas matter most?',
        multiple: true,
        options: [
          { id: 'behavior', label: 'Interaction behavior' },
          { id: 'visual', label: 'Visual polish' },
          { id: 'accessibility', label: 'Accessibility' },
        ],
      },
      {
        id: 'notes',
        kind: 'text',
        label: 'Anything else we should account for?',
        description: 'Optional details will be kept with this answer.',
        multiline: true,
      },
    ],
  },
}

export const inputComponents: ComponentEntry[] = [{
  id: 'extension-interaction-composer',
  name: 'Extension Interaction Composer',
  category: 'Chat Inputs',
  description: 'Inline Pi extension request that replaces the regular chat composer.',
  component: ExtensionInteractionComposer,
  layout: 'top',
  props: [],
    mockData: () => ({ event: selectRequest, onRespond: () => {} }),
  variants: [
    { name: 'Wizard', props: { event: wizardRequest } },
    { name: 'Select', props: { event: selectRequest } },
    { name: 'Multiple select', props: { event: multipleRequest } },
    {
      name: 'Direct input',
      props: {
        event: {
          ...requestBase,
          requestId: 'preview-editor',
          request: {
            schemaVersion: 1,
            title: 'What should be different?',
            fields: [{ id: 'difference', kind: 'text', label: 'Difference', multiline: true }],
          },
        } satisfies ExtensionInteractionBridgeRequestV1,
      },
    },
    {
      name: 'Confirmation',
      props: {
        event: {
          ...requestBase,
          requestId: 'preview-confirm',
          request: {
            schemaVersion: 1,
            title: 'Apply these changes?',
            description: 'This will update the current workspace.',
            fields: [{ id: 'apply', kind: 'confirm', label: 'Apply changes' }],
          },
        } satisfies ExtensionInteractionBridgeRequestV1,
      },
    },
  ],
}]

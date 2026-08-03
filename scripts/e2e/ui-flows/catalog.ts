import type { InteractionFlow } from './types.ts'

const shellScenario = { name: 'session.empty', seed: 1701 } as const

export const INTERACTION_FLOWS = [
  {
    id: 'shared-ui.shell-semantics',
    moduleId: 'shared-ui-i18n',
    interactionId: 'ui.control.activate',
    scenario: shellScenario,
    steps: [
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'navigation.main' } } },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'navigation.nav_settings' } } },
    ],
  },
  {
    id: 'layout.shell-navigation',
    moduleId: 'universal-layout',
    interactionId: 'layout.tab.select',
    scenario: shellScenario,
    steps: [
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'workspace.unified-dock' } } },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'app.new-session' } } },
    ],
  },
  {
    id: 'conversation.new-session-entry',
    moduleId: 'conversation-ui',
    interactionId: 'conversation.draft.edit',
    scenario: shellScenario,
    steps: [
      { kind: 'action', target: { semanticId: 'app.new-session' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
    ],
  },
  {
    id: 'skills.fixed-editor',
    moduleId: 'sources-skills-mcp',
    interactionId: 'skills.create',
    scenario: shellScenario,
    steps: [
      { kind: 'action', target: { semanticId: 'navigation.nav_skills' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'action', target: { semanticId: 'skills.add.header' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'skills.editor' } } },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'skills.editor.save' }, state: 'disabled', equals: true } },
    ],
  },
  {
    id: 'automations.fixed-editor',
    moduleId: 'automations',
    interactionId: 'automations.create',
    scenario: shellScenario,
    steps: [
      { kind: 'action', target: { semanticId: 'navigation.nav_automations' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'action', target: { semanticId: 'automations.add.header' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'automations.editor' } } },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'automations.editor.save' }, state: 'disabled', equals: true } },
    ],
  },
  {
    id: 'settings.fixed-detail',
    moduleId: 'app-settings-security',
    interactionId: 'settings.navigate',
    scenario: shellScenario,
    steps: [
      { kind: 'action', target: { semanticId: 'navigation.nav_settings' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'settings.app' } } },
    ],
  },
  {
    id: 'workspace.creation-entry',
    moduleId: 'workspace-state',
    interactionId: 'workspace.create',
    scenario: shellScenario,
    steps: [
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'workspace.add' } } },
    ],
  },
  {
    id: 'provider.settings-entry',
    moduleId: 'provider-model-runtime',
    interactionId: 'provider.configure',
    scenario: shellScenario,
    steps: [
      { kind: 'action', target: { semanticId: 'navigation.nav_settings' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'action', target: { semanticId: 'settings.ai' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
    ],
  },
  {
    id: 'validation.batch-contract',
    moduleId: 'ui-validation-developer-kit',
    interactionId: 'validation.flow.batch',
    scenario: shellScenario,
    steps: [
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'navigation.main' } } },
    ],
  },
  {
    id: 'product.fixed-management-surface',
    moduleId: 'product-semantics',
    interactionId: 'product.management.fixed-surface',
    scenario: shellScenario,
    steps: [
      { kind: 'action', target: { semanticId: 'navigation.nav_skills' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'action', target: { semanticId: 'skills.add.header' }, action: 'click', mode: 'physical', minimumVerification: 'renderer-verified' },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'skills.editor' } } },
      { kind: 'assert', predicate: { kind: 'node', target: { semanticId: 'navigation.main' } } },
    ],
  },
] as const satisfies readonly InteractionFlow[]

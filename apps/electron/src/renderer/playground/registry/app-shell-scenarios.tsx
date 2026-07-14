import type { ComponentEntry } from './types'
import { ScenarioAppShellHost } from '@/ui-validation/app-shell-scenario-service'

export const appShellScenarioComponents: ComponentEntry[] = __CRAFT_UI_VALIDATION_BUILD__ ? [{
  id: 'app-shell-scenario-host',
  name: 'AppShell Scenario Host',
  category: 'Chat',
  description: 'Controlled production-component host for typed AI UI validation scenarios.',
  component: ScenarioAppShellHost,
  props: [],
  layout: 'full',
  previewOverflow: 'hidden',
}] : []

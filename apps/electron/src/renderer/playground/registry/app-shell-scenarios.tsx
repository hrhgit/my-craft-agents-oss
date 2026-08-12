import type { ComponentEntry } from './types'
import { ScenarioAppShellHost } from '@/ui-validation/app-shell-scenario-service'

export const appShellScenarioComponents: ComponentEntry[] = __MORTISE_UI_VALIDATION_BUILD__ ? [{
  id: 'app-shell-scenario-host',
  name: 'AppShell Scenario Host',
  nameZh: 'AppShell 场景宿主',
  category: 'Chat',
  description: 'Controlled production-component host for typed AI UI validation scenarios.',
  descriptionZh: '用于类型化 AI UI 验证场景的受控生产组件宿主。',
  component: ScenarioAppShellHost,
  props: [],
  layout: 'full',
  previewOverflow: 'hidden',
}] : []

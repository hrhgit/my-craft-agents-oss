import * as React from 'react'
import type { ComponentEntry } from './types'
import {
  SettingsCard,
  SettingsInput,
  SettingsRadioCard,
  SettingsRadioGroup,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsSelect,
  SettingsToggle,
} from '@/components/settings'

function SettingsFoundationScene() {
  const [notifications, setNotifications] = React.useState(true)
  const [name, setName] = React.useState('Mortise workspace')
  const [theme, setTheme] = React.useState('system')
  const [mode, setMode] = React.useState('ask')

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-8">
      <SettingsSection title="Workspace" description="Production settings primitives in a realistic settings-page context.">
        <SettingsCard>
          <SettingsInput label="Workspace name" value={name} onChange={setName} inCard />
          <SettingsToggle label="Desktop notifications" description="Notify when an agent finishes work." checked={notifications} onCheckedChange={setNotifications} />
          <SettingsSelect
            label="Default model"
            value={mode}
            onValueChange={setMode}
            inCard
            options={[{ value: 'ask', label: 'Ask every time' }, { value: 'fast', label: 'Fast model' }, { value: 'reasoning', label: 'Reasoning model' }]}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Appearance" description="State is local to this preview.">
        <SettingsSegmentedControl value={theme} onValueChange={setTheme} options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]} />
      </SettingsSection>
      <SettingsSection title="Permission mode" description="Shows selectable settings cards in their page context.">
        <SettingsRadioGroup value={mode} onValueChange={setMode}>
          <SettingsRadioCard value="ask" label="Ask" description="Confirm each action." />
          <SettingsRadioCard value="fast" label="Always approve" description="Continue without confirmation." />
        </SettingsRadioGroup>
      </SettingsSection>
    </main>
  )
}

export const uiFoundationComponents: ComponentEntry[] = [{
  id: 'settings-foundations',
  name: 'Settings Foundations',
  category: 'Settings',
  description: 'Production settings controls composed into a complete interactive page surface.',
  component: SettingsFoundationScene,
  props: [],
  layout: 'top',
  source: {
    file: 'apps/electron/src/renderer/components/settings',
    symbol: 'Settings foundations',
    coverage: 'page-scene',
  },
  scene: {
    kind: 'static',
    label: 'Settings page context',
  },
}]

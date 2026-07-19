import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('extension GUI migration guard', () => {
  it('does not restore the host-owned Plan GUI', () => {
    expect(existsSync(resolve(root, 'apps/electron/src/renderer/components/app-shell/ConversationModeSelector.tsx'))).toBe(false)
    expect(existsSync(resolve(root, 'apps/electron/src/renderer/components/app-shell/input/plan-mode-ui-state.ts'))).toBe(false)
    expect(existsSync(resolve(root, 'apps/electron/src/renderer/components/app-shell/plan-approval-message.ts'))).toBe(false)
    expect(existsSync(resolve(root, 'packages/ui/src/components/chat/PlanArtifactCard.tsx'))).toBe(false)

    const hostSources = [
      read('apps/electron/src/renderer/components/app-shell/input/ChatInputZone.tsx'),
      read('apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx'),
      read('packages/ui/src/components/chat/TurnCard.tsx'),
      read('packages/shared/src/config/pi-extension-settings.ts'),
    ].join('\n')
    expect(hostSources).not.toMatch(/ConversationModeSelector|PlanArtifactCard|showDiscussionButton|showPlanButton|renderPlanMarkdown|mortise:approve-plan/)
  })

  it('does not restore ask_user identity branches in the generic host adapters', () => {
    const hostSources = [
      read('packages/shared/src/agent/pi-agent.ts'),
      read('apps/electron/src/renderer/components/extensions/RemoteUIModal.tsx'),
      read('apps/electron/src/renderer/hooks/useRemoteUIRequests.ts'),
    ].join('\n')
    expect(hostSources).not.toMatch(/ASK_USER_EXTENSION_IDS|isAskUserExtension|parseAskUserPrompt|remote-ui-batch/)
  })
})

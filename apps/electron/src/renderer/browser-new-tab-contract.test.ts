import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererDir = import.meta.dir
const repositoryRoot = join(rendererDir, '../../../..')
const newTabHtml = readFileSync(join(rendererDir, 'browser-empty-state.html'), 'utf8')
const readRepositoryFiles = (paths: readonly string[]) => paths
  .map(path => readFileSync(join(repositoryRoot, path), 'utf8'))
  .join('\n')

describe('built-in browser new tab', () => {
  it('stays a static blank page without task-launching UI', () => {
    expect(existsSync(join(rendererDir, 'browser-empty-state.tsx'))).toBe(false)
    expect(newTabHtml).toContain('<title>New Tab</title>')
    expect(newTabHtml).toContain('<body></body>')
    expect(newTabHtml).not.toMatch(/<button|type="module"|BrowserEmptyStateCard|EMPTY_STATE_PROMPT_SAMPLES|action\/new-session/)
  })

  it('does not expose the removed prompt-launch bridge', () => {
    const productionSources = readRepositoryFiles([
      'apps/electron/src/main/browser-pane-manager.ts',
      'apps/electron/src/main/handlers/browser.ts',
      'apps/electron/src/preload/bootstrap.ts',
      'apps/electron/src/shared/types.ts',
      'apps/electron/src/transport/channel-map.ts',
      'packages/shared/src/protocol/channels.ts',
      'packages/shared/src/protocol/routing.ts',
    ])

    expect(productionSources).not.toMatch(/emptyStateLaunch|EmptyStateLaunch|browser-empty-state:launch/)
  })

  it('does not retain the removed guide component, prompts, demo, or copy', () => {
    expect(existsSync(join(repositoryRoot, 'packages/ui/src/components/ui/BrowserEmptyStateCard.tsx'))).toBe(false)
    expect(existsSync(join(rendererDir, 'components/browser/empty-state-prompts.ts'))).toBe(false)

    const removedGuideSurfaces = readRepositoryFiles([
      'packages/ui/src/index.ts',
      'packages/ui/src/components/ui/index.ts',
      'apps/electron/src/renderer/playground/registry/browser-ui.tsx',
      'packages/shared/CLAUDE.md',
      ...['de', 'en', 'es', 'hu', 'ja', 'pl', 'zh-Hans']
        .map(locale => `packages/shared/src/i18n/locales/${locale}.json`),
    ])

    expect(removedGuideSurfaces).not.toMatch(
      /BrowserEmptyStateCard|BrowserEmptyPromptSample|EMPTY_STATE_PROMPT_SAMPLES|empty-state-prompts|browser-empty-state-playground|browser\.(?:readyTitle|readyDescription|safetyHint)|This browser is ready for your Agents|Ask any session to use this browser|routes\.action\.newSession/,
    )
  })
})

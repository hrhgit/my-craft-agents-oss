import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationV3Store } from '@mortise/shared/automations'
import { SessionManager } from './SessionManager.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryWorkspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mortise-automation-init-'))
  roots.push(root)
  return root
}

describe('SessionManager automation initialization', () => {
  it('keeps a workspace identity failure scoped to automations', async () => {
    const staleRoot = temporaryWorkspaceRoot()
    const healthyRoot = temporaryWorkspaceRoot()
    const stale = new AutomationV3Store({
      workspaceId: 'workspace-old',
      workspaceRootPath: staleRoot,
    })
    stale.initialize()
    stale.close()

    const workspaces = new Map([
      ['workspace-new', { id: 'workspace-new' }],
      ['workspace-healthy', { id: 'workspace-healthy' }],
    ])
    const manager = new SessionManager({
      resolveWorkspaceByNameOrId: id => workspaces.get(id) as never ?? null,
    })

    expect(() => manager.setupConfigWatcher(staleRoot, 'workspace-new')).not.toThrow()
    expect(manager.getAutomationHost('workspace-new')).toBeNull()
    expect(manager.getAutomationHostInitializationError('workspace-new'))
      .toBe('Automation database workspace identity does not match workspace-new')

    expect(() => manager.setupConfigWatcher(healthyRoot, 'workspace-healthy')).not.toThrow()
    expect(manager.getAutomationHost('workspace-healthy')).not.toBeNull()
    expect(manager.getAutomationHostInitializationFailures()).toEqual([{
      workspaceId: 'workspace-new',
      message: 'Automation database workspace identity does not match workspace-new',
    }])

    await manager.cleanup()
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportResources, importResources, validateResourceBundle } from '../resource-bundle'
import { AutomationWorkspaceHostV3 } from '../../automations/v3-host-runtime'
import type { AutomationDefinitionV3 } from '../../automations/v3-types'
import type { ResourceBundle } from '../types'

function createWorkspace(root: string): string {
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.mortise', 'skills'), { recursive: true })
  writeFileSync(join(workspace, 'config.json'), JSON.stringify({ name: 'Test Workspace' }))
  return workspace
}

function createSkill(workspace: string, slug: string): void {
  const directory = join(workspace, '.mortise', 'skills', slug)
  mkdirSync(join(directory, 'scripts'), { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---
name: ${slug}
description: Test skill
---

Instructions.
`)
  writeFileSync(join(directory, 'scripts', 'run.ts'), 'export {}')
}

function openAutomationHost(workspace: string, workspaceId = workspace): AutomationWorkspaceHostV3 {
  const host = new AutomationWorkspaceHostV3({
    workspaceId,
    workspaceRootPath: workspace,
    callbacks: {
      prompt: async () => ({ status: 'succeeded' }),
      webhook: async () => ({ status: 'succeeded' }),
    },
  })
  host.start()
  return host
}

function file(relativePath: string, content: string) {
  const buffer = Buffer.from(content)
  return {
    relativePath,
    contentBase64: buffer.toString('base64'),
    size: buffer.length,
  }
}

function automation(overrides: Partial<AutomationDefinitionV3> = {}): AutomationDefinitionV3 {
  const timestamp = '2026-07-21T00:00:00.000Z'
  return {
    id: 'automation-greeting-0001',
    name: 'Greeting',
    enabled: true,
    triggers: [{ id: 'trigger-greeting-0001', type: 'event', source: 'mortise', eventType: 'UserPromptSubmit' }],
    actions: [{
      id: 'action-greeting-0001',
      type: 'prompt',
      prompt: 'hello',
      target: { kind: 'new-session' },
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

describe('resource bundle', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mortise-resource-bundle-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('exports skills and automations through the workspace host', async () => {
    const workspace = createWorkspace(root)
    createSkill(workspace, 'review')
    const host = openAutomationHost(workspace, 'workspace-test')
    expect(host.importDefinitions([automation()], 'overwrite').imported).toEqual(['automation-greeting-0001'])

    const { bundle, warnings } = exportResources(workspace, {
      skills: 'all',
      automations: 'all',
    }, 'workspace-test', host)

    expect(warnings).toEqual([])
    expect(bundle.sourceWorkspace).toBe('Test Workspace')
    expect(bundle.resources.skills?.[0]?.slug).toBe('review')
    expect(bundle.resources.skills?.[0]?.files.map(entry => entry.relativePath))
      .toEqual(expect.arrayContaining(['SKILL.md', 'scripts/run.ts']))
    expect(bundle.resources.automations?.[0]).toMatchObject({
      schemaVersion: 1,
      definition: { id: 'automation-greeting-0001', name: 'Greeting' },
      dependencies: [],
    })
    await host.stop()
  })

  it('validates the current bundle format', () => {
    const valid: ResourceBundle = {
      version: 3,
      exportedAt: Date.now(),
      resources: {
        skills: [{
          slug: 'review',
          files: [file('SKILL.md', '---\nname: Review\ndescription: Review code\n---\n')],
        }],
        automations: [{ schemaVersion: 1, definition: automation(), dependencies: [] }],
      },
    }

    expect(validateResourceBundle(valid)).toEqual({ valid: true, errors: [] })
    expect(validateResourceBundle({ version: 99, resources: {} }).valid).toBe(false)
  })

  it('imports skills and automations', async () => {
    const workspace = createWorkspace(root)
    const host = openAutomationHost(workspace)
    const bundle: ResourceBundle = {
      version: 3,
      exportedAt: Date.now(),
      resources: {
        skills: [{
          slug: 'review',
          files: [
            file('SKILL.md', '---\nname: Review\ndescription: Review code\n---\n'),
            file('scripts/run.ts', 'export {}'),
          ],
        }],
        automations: [{ schemaVersion: 1, definition: automation(), dependencies: [] }],
      },
    }

    const result = await importResources(workspace, bundle, 'skip', workspace, host)

    expect(result.skills.imported).toEqual(['review'])
    expect(result.automations.imported).toEqual(['automation-greeting-0001'])
    expect(existsSync(join(workspace, '.mortise', 'skills', 'review', 'scripts', 'run.ts'))).toBe(true)
    expect(host.exportDefinitions()[0]?.id).toBe('automation-greeting-0001')
    await host.stop()
  })

  it('honors skip and overwrite modes', async () => {
    const workspace = createWorkspace(root)
    createSkill(workspace, 'review')
    const bundle: ResourceBundle = {
      version: 3,
      exportedAt: Date.now(),
      resources: {
        skills: [{
          slug: 'review',
          files: [file('SKILL.md', '---\nname: Updated\ndescription: Updated\n---\n')],
        }],
      },
    }

    expect((await importResources(workspace, bundle, 'skip')).skills.skipped).toEqual(['review'])
    expect((await importResources(workspace, bundle, 'overwrite')).skills.imported).toEqual(['review'])
    expect(readFileSync(join(workspace, '.mortise', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain('name: Updated')
  })

  it('exports dependency declarations without secret values and imports incomplete entries disabled', async () => {
    const source = createWorkspace(root)
    const sourceHost = openAutomationHost(source, 'workspace-source')
    const dependent = automation({
      enabled: true,
      triggers: [{
        id: 'trigger-external-0001', type: 'event', source: 'external', eventType: 'build.finished',
      }],
      actions: [
        {
          id: 'action-session-0001', type: 'prompt', prompt: 'continue',
          target: { kind: 'session', session: { id: 'session-existing-0001' }, delivery: 'followUp' },
        },
        {
          id: 'action-webhook-0001', type: 'webhook', url: 'https://example.test',
          headers: { Authorization: 'Bearer very-secret-value' },
          auth: { type: 'bearer', token: { provider: 'mortise-secrets', id: 'secret-existing-0001' } },
        },
      ],
    })
    sourceHost.importDefinitions([dependent], 'overwrite')
    const exported = exportResources(source, { automations: 'all' }, 'workspace-source', sourceHost)
    const entry = exported.bundle.resources.automations?.[0]
    expect(JSON.stringify(entry)).not.toContain('very-secret-value')
    expect(entry?.dependencies.map(item => item.kind)).toEqual(['event-source', 'session', 'secret', 'secret'])
    const exportedHeader = entry?.definition.actions[1]?.type === 'webhook'
      ? entry.definition.actions[1].headers?.Authorization
      : undefined
    expect(typeof exportedHeader).toBe('string')
    expect(exportedHeader).toContain('mortise-secret')

    const target = join(root, 'target-workspace')
    mkdirSync(target, { recursive: true })
    const targetHost = openAutomationHost(target, 'workspace-target')
    const imported = await importResources(
      target,
      exported.bundle,
      'overwrite',
      'workspace-target',
      targetHost,
      { isAvailable: dependency => dependency.kind !== 'event-source' && dependency.id === 'session-existing-0001' },
    )
    expect(imported.automations.items).toMatchObject([{
      id: dependent.id,
      status: 'imported-disabled',
    }])
    expect(targetHost.exportDefinitions()[0]).toMatchObject({
      id: dependent.id,
      enabled: false,
      configuration: { status: 'incomplete', desiredEnabled: true },
    })
    await sourceHost.stop()
    await targetHost.stop()
  })

  it('isolates malformed Automation entries during a batch import', async () => {
    const workspace = createWorkspace(root)
    const host = openAutomationHost(workspace)
    const bundle = {
      version: 3 as const,
      exportedAt: Date.now(),
      resources: {
        automations: [
          { schemaVersion: 1 as const, definition: automation(), dependencies: [] },
          { schemaVersion: 1 as const, definition: { id: 'broken' }, dependencies: [] },
        ],
      },
    } as ResourceBundle
    const result = await importResources(workspace, bundle, 'overwrite', workspace, host)
    expect(result.automations.items.map(item => item.status)).toEqual(['imported', 'failed'])
    expect(result.automations.imported).toEqual(['automation-greeting-0001'])
    expect(result.automations.failed).toHaveLength(1)
    await host.stop()
  })
})

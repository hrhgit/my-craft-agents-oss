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
    expect(host.importDefinitions([automation()], 'overwrite').imported).toEqual(['Greeting'])

    const { bundle, warnings } = exportResources(workspace, {
      skills: 'all',
      automations: 'all',
    }, 'workspace-test', host)

    expect(warnings).toEqual([])
    expect(bundle.sourceWorkspace).toBe('Test Workspace')
    expect(bundle.resources.skills?.[0]?.slug).toBe('review')
    expect(bundle.resources.skills?.[0]?.files.map(entry => entry.relativePath))
      .toEqual(expect.arrayContaining(['SKILL.md', 'scripts/run.ts']))
    expect(bundle.resources.automations?.[0]).toMatchObject({ id: 'automation-greeting-0001', name: 'Greeting' })
    await host.stop()
  })

  it('validates the current bundle format', () => {
    const valid: ResourceBundle = {
      version: 2,
      exportedAt: Date.now(),
      resources: {
        skills: [{
          slug: 'review',
          files: [file('SKILL.md', '---\nname: Review\ndescription: Review code\n---\n')],
        }],
        automations: [automation()],
      },
    }

    expect(validateResourceBundle(valid)).toEqual({ valid: true, errors: [] })
    expect(validateResourceBundle({ version: 99, resources: {} }).valid).toBe(false)
  })

  it('imports skills and automations', async () => {
    const workspace = createWorkspace(root)
    const host = openAutomationHost(workspace)
    const bundle: ResourceBundle = {
      version: 2,
      exportedAt: Date.now(),
      resources: {
        skills: [{
          slug: 'review',
          files: [
            file('SKILL.md', '---\nname: Review\ndescription: Review code\n---\n'),
            file('scripts/run.ts', 'export {}'),
          ],
        }],
        automations: [automation()],
      },
    }

    const result = await importResources(workspace, bundle, 'skip', workspace, host)

    expect(result.skills.imported).toEqual(['review'])
    expect(result.automations.imported).toEqual(['Greeting'])
    expect(existsSync(join(workspace, '.mortise', 'skills', 'review', 'scripts', 'run.ts'))).toBe(true)
    expect(host.exportDefinitions()[0]?.id).toBe('automation-greeting-0001')
    await host.stop()
  })

  it('honors skip and overwrite modes', async () => {
    const workspace = createWorkspace(root)
    createSkill(workspace, 'review')
    const bundle: ResourceBundle = {
      version: 2,
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
})

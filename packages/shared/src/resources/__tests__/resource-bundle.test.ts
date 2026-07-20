import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportResources, importResources, validateResourceBundle } from '../resource-bundle'
import type { AutomationBundleEntry, ResourceBundle } from '../types'

function createWorkspace(root: string): string {
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.pi', 'skills'), { recursive: true })
  writeFileSync(join(workspace, 'config.json'), JSON.stringify({ name: 'Test Workspace' }))
  return workspace
}

function createSkill(workspace: string, slug: string): void {
  const directory = join(workspace, '.pi', 'skills', slug)
  mkdirSync(join(directory, 'scripts'), { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---
name: ${slug}
description: Test skill
---

Instructions.
`)
  writeFileSync(join(directory, 'scripts', 'run.ts'), 'export {}')
}

function createAutomations(workspace: string): void {
  writeFileSync(join(workspace, 'automations.json'), JSON.stringify({
    version: 2,
    automations: {
      UserPromptSubmit: [{
        id: 'auto-1',
        name: 'Greeting',
        actions: [{ type: 'prompt', prompt: 'hello' }],
      }],
    },
  }, null, 2))
}

function file(relativePath: string, content: string) {
  const buffer = Buffer.from(content)
  return {
    relativePath,
    contentBase64: buffer.toString('base64'),
    size: buffer.length,
  }
}

function automation(overrides: Partial<AutomationBundleEntry> = {}): AutomationBundleEntry {
  return {
    id: 'auto-1',
    name: 'Greeting',
    event: 'UserPromptSubmit',
    matcher: {
      id: 'auto-1',
      name: 'Greeting',
      actions: [{ type: 'prompt', prompt: 'hello' }],
    },
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

  it('exports skills and automations', () => {
    const workspace = createWorkspace(root)
    createSkill(workspace, 'review')
    createAutomations(workspace)

    const { bundle, warnings } = exportResources(workspace, {
      skills: 'all',
      automations: 'all',
    })

    expect(warnings).toEqual([])
    expect(bundle.sourceWorkspace).toBe('Test Workspace')
    expect(bundle.resources.skills?.[0]?.slug).toBe('review')
    expect(bundle.resources.skills?.[0]?.files.map(entry => entry.relativePath))
      .toEqual(expect.arrayContaining(['SKILL.md', 'scripts/run.ts']))
    expect(bundle.resources.automations?.[0]).toMatchObject({
      id: 'auto-1',
      event: 'UserPromptSubmit',
    })
  })

  it('validates the current bundle format', () => {
    const valid: ResourceBundle = {
      version: 1,
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
    const bundle: ResourceBundle = {
      version: 1,
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

    const result = await importResources(workspace, bundle, 'skip')

    expect(result.skills.imported).toEqual(['review'])
    expect(result.automations.imported).toEqual(['Greeting'])
    expect(existsSync(join(workspace, '.pi', 'skills', 'review', 'scripts', 'run.ts'))).toBe(true)
    const stored = JSON.parse(readFileSync(join(workspace, 'automations.json'), 'utf8'))
    expect(stored.automations.UserPromptSubmit[0].id).toBe('auto-1')
  })

  it('honors skip and overwrite modes', async () => {
    const workspace = createWorkspace(root)
    createSkill(workspace, 'review')
    const bundle: ResourceBundle = {
      version: 1,
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
    expect(readFileSync(join(workspace, '.pi', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain('name: Updated')
  })
})

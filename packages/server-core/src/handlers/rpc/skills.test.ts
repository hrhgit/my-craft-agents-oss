import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { discoverSkillsUnderHome, importSkillDirectories, importSkillDirectory } from './skills'

const tempDirectories: string[] = []

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

function writeSkill(directory: string, name = 'Imported Skill'): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Imported test skill\n---\n\nUse this skill for tests.\n`)
  mkdirSync(join(directory, 'scripts'), { recursive: true })
  writeFileSync(join(directory, 'scripts', 'run.ts'), 'export const imported = true\n')
}

function writeInvalidSkill(directory: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: Invalid Skill\n---\n\nMissing description.\n')
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('skill directory import', () => {
  it('copies a valid skill into the workspace skill directory', async () => {
    const workspace = tempDirectory('mortise-skill-workspace-')
    const sourceRoot = tempDirectory('mortise-skill-source-')
    const source = join(sourceRoot, 'imported-skill')
    writeSkill(source)

    await expect(importSkillDirectory(workspace, source)).resolves.toEqual({
      status: 'imported',
      slug: 'imported-skill',
      name: 'Imported Skill',
    })
    expect(readFileSync(join(workspace, '.pi', 'skills', 'imported-skill', 'scripts', 'run.ts'), 'utf-8'))
      .toContain('imported = true')
  })

  it('skips an existing workspace skill without overwriting it', async () => {
    const workspace = tempDirectory('mortise-skill-workspace-')
    const existing = join(workspace, '.pi', 'skills', 'existing-skill')
    writeSkill(existing, 'Existing Skill')
    const sourceRoot = tempDirectory('mortise-skill-source-')
    const source = join(sourceRoot, 'existing-skill')
    writeSkill(source, 'Replacement Skill')

    await expect(importSkillDirectory(workspace, source)).resolves.toEqual({
      status: 'skipped',
      slug: 'existing-skill',
      name: 'Existing Skill',
    })
    expect(readFileSync(join(existing, 'SKILL.md'), 'utf-8')).toContain('name: Existing Skill')
  })

  it('rejects directories without a valid SKILL.md', async () => {
    const workspace = tempDirectory('mortise-skill-workspace-')
    const sourceRoot = tempDirectory('mortise-skill-source-')
    const missing = join(sourceRoot, 'missing-skill')
    mkdirSync(missing)

    await expect(importSkillDirectory(workspace, missing)).rejects.toThrow('does not contain SKILL.md')
    expect(existsSync(join(workspace, '.pi', 'skills', 'missing-skill'))).toBe(false)

    const invalid = join(sourceRoot, 'Invalid Skill')
    writeSkill(invalid)
    await expect(importSkillDirectory(workspace, invalid)).rejects.toThrow('Slug must be lowercase')
  })
})

describe('skill discovery', () => {
  it('finds valid skills across user-level skills directories without copying them', async () => {
    const home = tempDirectory('mortise-skill-home-')
    const workspace = join(home, 'projects', 'current-workspace')
    mkdirSync(workspace, { recursive: true })
    const codexSkill = join(home, '.codex', 'skills', 'codex-skill')
    const claudeSkill = join(home, '.config', 'claude', 'skills', 'group', 'claude-skill')
    const invalidSkill = join(home, '.other', 'skills', 'invalid-skill')
    writeSkill(codexSkill, 'Codex Skill')
    writeSkill(claudeSkill, 'Claude Skill')
    writeInvalidSkill(invalidSkill)

    const discovered = await discoverSkillsUnderHome(home, workspace)

    expect(discovered.map(skill => skill.slug)).toEqual(['claude-skill', 'codex-skill'])
    expect(discovered.map(skill => skill.sourcePath)).toEqual([
      claudeSkill,
      codexSkill,
    ])
    expect(existsSync(join(workspace, '.pi'))).toBe(false)
  })

  it('bounds both home traversal and traversal within each skills directory at depth four', async () => {
    const home = tempDirectory('mortise-skill-home-')
    const homeLimitSkill = join(home, 'one', 'two', 'three', 'skills', 'home-limit')
    const beyondHomeLimitSkill = join(home, 'one', 'two', 'three', 'four', 'skills', 'too-deep-home')
    const skillsRoot = join(home, 'provider', 'skills')
    const skillLimit = join(skillsRoot, 'one', 'two', 'three', 'skill-limit')
    const beyondSkillLimit = join(skillsRoot, 'one', 'two', 'three', 'four', 'too-deep-skill')
    writeSkill(homeLimitSkill)
    writeSkill(beyondHomeLimitSkill)
    writeSkill(skillLimit)
    writeSkill(beyondSkillLimit)

    const discovered = await discoverSkillsUnderHome(home)

    expect(discovered.map(skill => skill.slug)).toEqual(['home-limit', 'skill-limit'])
  })

  it("excludes the current workspace's own .pi/skills directory", async () => {
    const home = tempDirectory('mortise-skill-home-')
    const workspace = join(home, 'projects', 'current-workspace')
    const workspaceSkill = join(workspace, '.pi', 'skills', 'workspace-skill')
    const externalSkill = join(home, '.claude', 'skills', 'external-skill')
    writeSkill(workspaceSkill, 'Workspace Skill')
    writeSkill(externalSkill, 'External Skill')

    const discovered = await discoverSkillsUnderHome(home, workspace)

    expect(discovered).toEqual([{
      sourcePath: externalSkill,
      skillsRoot: join(home, '.claude', 'skills'),
      slug: 'external-skill',
    }])
  })
})

describe('confirmed skill batch import', () => {
  it('imports only explicitly selected source paths', async () => {
    const home = tempDirectory('mortise-skill-home-')
    const workspace = tempDirectory('mortise-skill-workspace-')
    const selected = join(home, '.codex', 'skills', 'selected-skill')
    const unselected = join(home, '.claude', 'skills', 'unselected-skill')
    writeSkill(selected, 'Selected Skill')
    writeSkill(unselected, 'Unselected Skill')

    await expect(importSkillDirectories(workspace, [selected], home)).resolves.toEqual({
      imported: [{ slug: 'selected-skill', name: 'Selected Skill' }],
      skipped: [],
      failed: [],
    })
    expect(existsSync(join(workspace, '.pi', 'skills', 'selected-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(workspace, '.pi', 'skills', 'unselected-skill'))).toBe(false)
  })

  it('skips conflicts without overwriting the existing workspace skill', async () => {
    const home = tempDirectory('mortise-skill-home-')
    const workspace = tempDirectory('mortise-skill-workspace-')
    const existing = join(workspace, '.pi', 'skills', 'existing-skill')
    const source = join(home, '.codex', 'skills', 'existing-skill')
    writeSkill(existing, 'Existing Skill')
    writeSkill(source, 'Replacement Skill')

    await expect(importSkillDirectories(workspace, [source], home)).resolves.toEqual({
      imported: [],
      skipped: [{ slug: 'existing-skill', name: 'Existing Skill' }],
      failed: [],
    })
    expect(readFileSync(join(existing, 'SKILL.md'), 'utf-8')).toContain('name: Existing Skill')
  })

  it('rejects selected source paths outside the user home directory', async () => {
    const home = tempDirectory('mortise-skill-home-')
    const outsideHome = tempDirectory('mortise-skill-outside-')
    const workspace = tempDirectory('mortise-skill-workspace-')
    const source = join(outsideHome, 'skills', 'outside-skill')
    writeSkill(source, 'Outside Skill')

    await expect(importSkillDirectories(workspace, [source], home)).resolves.toEqual({
      imported: [],
      skipped: [],
      failed: [{
        sourcePath: resolve(source),
        error: 'Skill source must be inside the user home directory',
      }],
    })
    expect(existsSync(join(workspace, '.pi', 'skills', 'outside-skill'))).toBe(false)
  })
})

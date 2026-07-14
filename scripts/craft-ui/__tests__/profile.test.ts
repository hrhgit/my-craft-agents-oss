import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProfile } from '../profile.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('craft-ui profiles', () => {
  it('creates an empty isolated profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-ui-profile-')); roots.push(root)
    const profile = prepareProfile({ profileDir: join(root, 'profile'), mode: 'isolated' })
    expect(profile.containsClonedUserData).toBe(false)
    expect(existsSync(profile.craftConfigDir)).toBe(true)
    expect(existsSync(profile.piAgentDir)).toBe(true)
    expect(existsSync(profile.electronUserDataDir)).toBe(true)
  })

  it('clones requested config while excluding locks, logs, and caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-ui-profile-')); roots.push(root)
    const craft = join(root, 'source-craft'); const pi = join(root, 'source-pi')
    mkdirSync(join(craft, 'logs'), { recursive: true }); mkdirSync(join(pi, 'cache'), { recursive: true })
    writeFileSync(join(craft, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(craft, '.server.lock'), 'unsafe')
    writeFileSync(join(craft, 'logs', 'runtime.log'), 'noise')
    writeFileSync(join(pi, 'settings.json'), '{"provider":"test"}')
    const profile = prepareProfile({ profileDir: join(root, 'profile'), mode: 'clone', sourceCraftConfigDir: craft, sourcePiAgentDir: pi })
    expect(profile.containsClonedUserData).toBe(true)
    expect(readFileSync(join(profile.craftConfigDir, 'settings.json'), 'utf8')).toContain('dark')
    expect(existsSync(join(profile.craftConfigDir, '.server.lock'))).toBe(false)
    expect(existsSync(join(profile.craftConfigDir, 'logs'))).toBe(false)
    expect(existsSync(join(profile.piAgentDir, 'cache'))).toBe(false)
  })

  it('redirects cloned workspace roots into the temporary profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-ui-profile-')); roots.push(root)
    const craft = join(root, 'source-craft'); const pi = join(root, 'source-pi')
    mkdirSync(craft); mkdirSync(pi)
    const sourceWorkspace = join(root, 'real-workspace')
    writeFileSync(join(craft, 'config.json'), JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'Real', rootPath: sourceWorkspace }],
    }))
    const profile = prepareProfile({ profileDir: join(root, 'profile'), mode: 'clone', sourceCraftConfigDir: craft, sourcePiAgentDir: pi })
    const cloned = JSON.parse(readFileSync(join(profile.craftConfigDir, 'config.json'), 'utf8'))
    expect(cloned.workspaces[0].rootPath).toStartWith(join(profile.root, 'workspace-clones'))
    expect(cloned.workspaces[0].rootPath).not.toBe(sourceWorkspace)
    expect(existsSync(cloned.workspaces[0].rootPath)).toBe(true)
  })
})

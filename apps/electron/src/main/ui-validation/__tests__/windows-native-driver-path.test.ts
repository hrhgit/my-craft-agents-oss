import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveWindowsUiAutomationDriverPath } from '../windows-native-driver-path'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows UI Automation driver path', () => {
  test('prefers the Developer Host resource over a source checkout', () => {
    const root = makeRoot()
    const resourcesPath = join(root, 'resources')
    const cwd = join(root, 'repo')
    const packaged = join(resourcesPath, 'ui-validation', 'windows-uia-driver.ps1')
    const source = join(cwd, 'scripts', 'mortise-ui', 'windows-uia-driver.ps1')
    writeScript(packaged)
    writeScript(source)

    expect(resolveWindowsUiAutomationDriverPath({ resourcesPath, cwd })).toBe(resolve(packaged))
  })

  test('falls back to the source-development driver', () => {
    const root = makeRoot()
    const resourcesPath = join(root, 'resources')
    const cwd = join(root, 'repo')
    const source = join(cwd, 'scripts', 'mortise-ui', 'windows-uia-driver.ps1')
    writeScript(source)

    expect(resolveWindowsUiAutomationDriverPath({ resourcesPath, cwd })).toBe(resolve(source))
  })

  test('honors an explicit driver override', () => {
    const root = makeRoot()
    const configuredPath = join(root, 'custom-driver.ps1')

    expect(resolveWindowsUiAutomationDriverPath({ configuredPath })).toBe(resolve(configuredPath))
  })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mortise-uia-driver-'))
  roots.push(root)
  return root
}

function writeScript(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '# fixture\n', 'utf8')
}

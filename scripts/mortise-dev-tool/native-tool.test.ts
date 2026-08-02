import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..')
const script = readFileSync(join(import.meta.dir, 'MortiseDesktopTool.ps1'), 'utf8')
const launcher = readFileSync(join(repoRoot, 'Mortise-Desktop-Tool.cmd'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('Mortise Windows desktop tool', () => {
  it('has exactly the three requested actions', () => {
    expect(script.match(/CreateButton\("(?:启动|重启|打包)"/g)?.length).toBe(3)
    expect(script).toContain('CreateButton("启动"')
    expect(script).toContain('CreateButton("重启"')
    expect(script).toContain('CreateButton("打包"')
  })

  it('uses one canonical package mode', () => {
    expect(script).toContain('scripts/build/package-electron.ts", "--target", "default"')
    expect(script).not.toContain('--development')
    expect(script).not.toContain('测试构建')
    expect(script).not.toContain('标准构建')
  })

  it('routes start and restart through the existing Electron portmux project', () => {
    expect(script).toContain('"start", "--project", electronProject')
    expect(script).toContain('"stop", "--project", electronProject')
    expect(script).toContain(String.raw`Starting Electron\\.\\.\\.\\s*$`)
    expect(script).toContain('IsSourceDesktopRunning()')
    expect(script).not.toContain('assigned_port_status')
  })

  it('lets the tool return to idle after the source Electron window closes', () => {
    expect(script).toContain('desktopState == "running" && !IsSourceDesktopRunning()')
    expect(script).toContain('? "stopping" : "idle"')
    expect(script).toContain('statusText.Text = "正在关闭"')
  })

  it('provides a double-click launcher and no longer needs a web server', () => {
    expect(launcher).toContain('MortiseDesktopTool.ps1')
    expect(launcher).toContain('-WindowStyle Hidden')
    expect(packageJson.scripts['desktop:tool']).toContain('MortiseDesktopTool.ps1')
    expect(existsSync(join(import.meta.dir, 'server.ts'))).toBe(false)
    expect(existsSync(join(import.meta.dir, 'index.html'))).toBe(false)
    expect(existsSync(join(import.meta.dir, '.portmux.json'))).toBe(false)
  })

  it('replaces the legacy Windows launch and package wrappers', () => {
    for (const path of [
      'start-quick-test.cmd',
      'scripts/start-quick-test.ps1',
      'build-package.cmd',
      'scripts/build-package.ps1',
    ]) {
      expect(existsSync(join(repoRoot, path))).toBe(false)
    }
    expect(packageJson.scripts['electron:dev:terminal']).toBeUndefined()
    expect(packageJson.scripts['electron:dev:menu']).toBeUndefined()
    expect(packageJson.scripts['electron:dev:logs']).toBeUndefined()
  })
})

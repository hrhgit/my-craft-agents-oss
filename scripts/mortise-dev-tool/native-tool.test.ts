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
  it('provides the desktop, WebUI, and Developer Kit actions', () => {
    expect(script.match(/CreateButton\("(?:启动|重启|打包|启动网页端|停止网页端|构建开发者套件)"/g)?.length).toBe(6)
    expect(script).toContain('CreateButton("启动"')
    expect(script).toContain('CreateButton("重启"')
    expect(script).toContain('CreateButton("打包"')
    expect(script).toContain('CreateButton("启动网页端"')
    expect(script).toContain('CreateButton("停止网页端"')
    expect(script).toContain('CreateButton("构建开发者套件"')
  })

  it('uses one canonical package mode', () => {
    expect(script).toContain('scripts/build/package-electron.ts", "--target", "default"')
    expect(script).not.toContain('--development')
    expect(script).not.toContain('--fresh-source')
    expect(script).not.toContain('测试构建')
    expect(script).not.toContain('标准构建')
  })

  it('reuses the Electron supervisor for start and restart, with a legacy cold-restart fallback', () => {
    expect(script).toContain('"start", "--project", electronProject')
    expect(script).toContain('"stop", "--project", electronProject')
    expect(script).toContain('RunDesktopControl("start", false)')
    expect(script).toContain('RunDesktopControl("restart", true)')
    expect(script).toContain('scripts/electron-dev-control.ts')
    expect(script).toContain('StopDesktopBeforeLaunch(true)')
    expect(script).toContain('IsSourceDesktopRunning()')
    expect(script).not.toContain('assigned_port_status')
  })

  it('stops the Mortise desktop process tree before the tool closes', () => {
    expect(script).toContain('if (stopDesktopOnClose) StopDesktopOnToolClose()')
    expect(script).toContain('packageRunner?.TerminateTree()')
    expect(script).toContain('developerKitRunner?.TerminateTree()')
    expect(script).toContain('packageRunner?.Dispose()')
    expect(script).toContain('developerKitRunner?.Dispose()')
    expect(script).toContain('private void StopDesktopOnToolClose()')
    expect(script).toContain('stopRunner?.TerminateTree()')
    expect(script).toContain('!desktopRunner.WaitForExit(5000)')
    expect(script).toContain('desktopRunner.TerminateTree()')
    expect(script).toContain('TerminateRemainingSourceDesktopProcesses()')
    expect(script).toContain('Process.GetProcessesByName("electron")')
    expect(script).toContain('Path.Combine(repoRoot, "node_modules", "electron", "dist", "electron.exe")')
    expect(script).toContain('process.Kill(true)')
    expect(script).toContain('if (closing) continue;')
    expect(script).not.toContain('CancelIncompleteDesktopStart')
  })

  it('keeps the layout-only smoke test from stopping an active desktop', () => {
    expect(script).toContain('[MortiseDevTool.MainForm]::new($repoRoot, -not $SmokeTest)')
  })

  it('keeps process log draining bounded so the close event remains responsive', () => {
    expect(script).toContain('private const int MaxMessagesPerDrain = 100;')
    expect(script.match(/while \(remaining-- > 0 && .*\.Messages\.TryDequeue\(out message\)\)/g)?.length).toBe(6)
  })

  it('lets the tool return to idle after the source Electron window closes', () => {
    expect(script).toContain('desktopState == "running" && !sourceDesktopRunning')
    expect(script).toContain('SetDesktopState("idle")')
    expect(script).toContain('(desktopState == "starting" || desktopState == "restarting") && sourceDesktopRunning')
    expect(script).toContain('statusText.Text = "正在关闭"')
  })

  it('reuses the existing WebUI and Developer Kit launch paths', () => {
    expect(script).toContain('"scripts", "start-webui-instance.ps1"')
    expect(script).toContain('"scripts", "stop-webui.ps1"')
    expect(script).toContain('new[] { "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath }')
    expect(script).toContain('new[] { "run", "scripts/build-developer-kit.ts", "--no-archive" }')
    expect(script).toContain('DrainWebuiMessages()')
    expect(script).toContain('DrainStopWebuiMessages()')
    expect(script).toContain('DrainDeveloperKitMessages()')
  })

  it('does not report an intentional WebUI stop as a startup failure', () => {
    expect(script).toContain('suppressNextWebuiExitError = webuiRunner != null && webuiRunner.IsRunning')
    expect(script).toContain('if (suppressNextWebuiExitError)')
    expect(script).toContain('suppressNextWebuiExitError = false')
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
      'start-webui.cmd',
      'build-developer-kit.cmd',
      'stop-webui.cmd',
    ]) {
      expect(existsSync(join(repoRoot, path))).toBe(false)
    }
    expect(packageJson.scripts['electron:dev:terminal']).toBeUndefined()
    expect(packageJson.scripts['electron:dev:menu']).toBeUndefined()
    expect(packageJson.scripts['electron:dev:logs']).toBeUndefined()
  })
})

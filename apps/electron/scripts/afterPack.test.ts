import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { validatePackagedLayout } = require('./afterPack.cjs') as {
  validatePackagedLayout: (layout: Record<string, string>) => void
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createLayout() {
  const root = mkdtempSync(join(tmpdir(), 'mortise-after-pack-'))
  roots.push(root)
  const resourcesDir = join(root, 'resources')
  const appRoot = join(resourcesDir, 'app')
  const appDist = join(appRoot, 'dist')
  const appResources = join(appRoot, 'resources')
  const write = (file: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'fixture')
  }

  for (const file of [
    join(appDist, 'main.cjs'),
    join(appDist, 'workspace-server.mjs'),
    join(appDist, 'resources', 'pi-extensions', 'browser.js'),
    join(appDist, 'resources', 'pi-extensions', 'messaging.js'),
    join(appDist, 'resources', 'docs', 'mortise-cli.md'),
    join(appResources, 'session-mcp-server', 'index.js'),
    join(appResources, 'scripts', 'pdf_tool.py'),
    join(resourcesDir, 'vendor', 'bun', 'bun.exe'),
    join(resourcesDir, 'messaging-whatsapp-worker', 'worker.cjs'),
    join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    join(appRoot, 'resources', 'bin', 'win32-x64', 'uv.exe'),
    join(resourcesDir, 'pi-runtime', 'pi.exe'),
    join(root, 'Mortise.exe'),
  ]) write(file)

  return {
    platform: 'win32',
    arch: 'x64',
    resourcesDir,
    appRoot,
    appDist,
    appResources,
    appExecutable: join(root, 'Mortise.exe'),
    piRuntimeRoot: join(resourcesDir, 'pi-runtime'),
    piExecutable: join(resourcesDir, 'pi-runtime', 'pi.exe'),
    bunExecutable: join(resourcesDir, 'vendor', 'bun', 'bun.exe'),
    workerEntry: join(resourcesDir, 'messaging-whatsapp-worker', 'worker.cjs'),
    ripgrepExecutable: join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    uvExecutable: join(appRoot, 'resources', 'bin', 'win32-x64', 'uv.exe'),
  }
}

describe('packaged Electron layout', () => {
  it('allows the Developer Kit to carry its own Bun runtime', () => {
    const layout = createLayout()
    const kitBun = join(layout.resourcesDir, 'developer-kit', 'dev-host', 'resources', 'vendor', 'bun', 'bun.exe')
    mkdirSync(dirname(kitBun), { recursive: true })
    writeFileSync(kitBun, 'fixture')

    expect(() => validatePackagedLayout(layout)).not.toThrow()
  })

  it('rejects an extra Bun copied into the application payload', () => {
    const layout = createLayout()
    const duplicate = join(layout.appDist, 'installer-developer-kit', 'dev-host', 'resources', 'vendor', 'bun', 'bun.exe')
    mkdirSync(dirname(duplicate), { recursive: true })
    writeFileSync(duplicate, 'fixture')

    expect(() => validatePackagedLayout(layout)).toThrow('Expected exactly one packaged Bun runtime')
  })
})

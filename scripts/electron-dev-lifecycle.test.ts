import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'electron-dev.ts'), 'utf8')

describe('Electron development lifecycle', () => {
  it('runs Vite without a Windows package-manager shim', () => {
    expect(source).toContain('process.execPath,\n        VITE_ENTRY')
    expect(source).toContain('"--host",\n        "127.0.0.1"')
    expect(source).not.toContain('const VITE_BIN')
  })

  it('runs the actual Electron binary on Windows so the supervisor owns the main process PID', () => {
    expect(source).toContain('node_modules/electron/dist/electron.exe')
    expect(source).toContain(': join(ROOT_DIR, `node_modules/.bin/electron${BIN_EXT}`)')
  })

  it('keeps dev services alive when Electron exits and only tears them down during supervisor cleanup', () => {
    expect(source).toContain('["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"]')
    expect(source).toContain('dev servers remain available')
    expect(source).toContain('function restartElectron(): Promise<ElectronDevControlResponse>')
    expect(source).toContain('restartPromise = (async () =>')
    expect(source).toContain('state: electronState')
    expect(source).toContain('const termination = previous ? terminateProcessTree(previous) : undefined')
    expect(source).toContain('await waitForSubprocessExit(previous)')
    expect(source).not.toContain('await previous.exited')
    expect(source).toContain('...processes.map(terminateProcessTree)')
    expect(source).toContain('let cleanupPromise: Promise<void> | undefined')
    expect(source).toContain('vitePid: viteProc.pid')
    expect(source).toContain('vitePort: Number(vitePort)')
  })

  it('prepares Vite and runtime artifacts concurrently, then bundles after Vite is ready', () => {
    expect(source).toContain('const vite = startVite()')
    expect(source).toContain('const runtimeArtifacts = prepareRuntimeArtifacts(true)')
    expect(source).toContain('await Promise.all([runtimeArtifacts, viteReady])')
    expect(source).toContain('await prepareElectronBundles()')
    expect(source).toContain('both compete for the same CPU')
    expect(source).toContain('[mortise-dev-timing]')
    expect(source).toContain('connectTcp({ host: "127.0.0.1", port: Number(port) })')
  })

  it('offers a sequential benchmark mode without changing the supervisor contract', () => {
    expect(source).toContain('MORTISE_DEV_SEQUENTIAL_START')
    expect(source).toContain('Sequential startup benchmark mode enabled')
    expect(source).toContain('await prepareRuntimeArtifacts(false)')
    expect(source).toContain('await prepareElectronBundles()')
  })

  it('keeps the measured cache-friendly startup as the default and gates parallel startup explicitly', () => {
    expect(source).toContain('const parallelStart = process.env.MORTISE_DEV_PARALLEL_START === "1"')
    expect(source).toContain('if (sequentialStart || !parallelStart)')
    expect(source).toContain('Cache-friendly sequential startup enabled')
  })
})

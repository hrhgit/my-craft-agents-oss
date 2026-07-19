import { spawn } from 'bun'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configureSharedBackend } from './shared-backend-discovery'

const rootDir = join(import.meta.dir, '..')
const electronBin = join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env }
const defaultConfigDir = join(homedir(), '.mortise')

env.MORTISE_CONFIG_DIR ||= defaultConfigDir
const sharedBackend = await configureSharedBackend(env, defaultConfigDir)
if (sharedBackend) {
  console.log(`Reusing shared Mortise backend PID ${sharedBackend.pid} at ${sharedBackend.url}`)
}

const electron = spawn({
  cmd: [electronBin, 'apps/electron'],
  cwd: rootDir,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  env: env as Record<string, string>,
})

process.exit(await electron.exited)

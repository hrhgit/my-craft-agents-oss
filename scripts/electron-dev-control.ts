import { resolve } from 'node:path'
import { sendElectronDevControlCommand, type ElectronDevControlCommand } from './electron-dev-control-protocol.ts'

const command = process.argv[2] as ElectronDevControlCommand | undefined
const repoRootIndex = process.argv.indexOf('--repo-root')
const repoRoot = repoRootIndex >= 0
  ? resolve(process.argv[repoRootIndex + 1] ?? '')
  : resolve(import.meta.dir, '..')

if (!command || !['status', 'start', 'restart'].includes(command)) {
  console.error('Usage: bun run scripts/electron-dev-control.ts <status|start|restart> [--repo-root <path>]')
  process.exit(1)
}

try {
  const response = await sendElectronDevControlCommand(repoRoot, command)
  if (!response) {
    console.error('Electron dev supervisor is not running')
    process.exit(2)
  }
  console.log(JSON.stringify(response))
  process.exit(response.ok ? 0 : 1)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

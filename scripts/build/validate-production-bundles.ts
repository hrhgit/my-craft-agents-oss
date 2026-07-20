import { spawn } from 'bun'
import { resolve } from 'node:path'

export const productionBundleCommand = ['bun', 'run', 'electron:build'] as const

export function createProductionBundleEnvironment(
  environment: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...environment,
    MORTISE_UI_VALIDATION_BUILD: '0',
    MORTISE_DEV_HOST_BUILD: '0',
  }
}

export async function validateProductionBundles(): Promise<number> {
  console.log('Building Electron production bundle entrypoints used by packaging...')
  const processHandle = spawn({
    cmd: [...productionBundleCommand],
    cwd: resolve(import.meta.dir, '../..'),
    env: createProductionBundleEnvironment(),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return processHandle.exited
}

if (import.meta.main) {
  process.exit(await validateProductionBundles())
}

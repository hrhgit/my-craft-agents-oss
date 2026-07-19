import { join } from 'node:path'
import { readLiveServerConnection } from '../packages/server-core/src/bootstrap/server-endpoint'

export interface SharedBackendEnvironment extends Record<string, string | undefined> {
  MORTISE_CONFIG_DIR?: string
  MORTISE_SERVER_URL?: string
  MORTISE_SERVER_TOKEN?: string
}

export async function configureSharedBackend(
  env: SharedBackendEnvironment,
  defaultConfigDir: string,
): Promise<{ pid: number; url: string } | null> {
  if (env.MORTISE_SERVER_URL) return null

  const configDir = env.MORTISE_CONFIG_DIR || defaultConfigDir
  const connection = await readLiveServerConnection(join(configDir, '.server-endpoint.json'))
  if (!connection) return null

  env.MORTISE_SERVER_URL = connection.endpoint.url
  env.MORTISE_SERVER_TOKEN = connection.token
  return {
    pid: connection.endpoint.pid,
    url: connection.endpoint.url,
  }
}

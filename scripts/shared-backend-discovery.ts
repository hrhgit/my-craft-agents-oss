import { join } from 'node:path'
import { readLiveServerConnection } from '../packages/server-core/src/bootstrap/server-endpoint'

export interface SharedBackendEnvironment extends Record<string, string | undefined> {
  CRAFT_CONFIG_DIR?: string
  CRAFT_SERVER_URL?: string
  CRAFT_SERVER_TOKEN?: string
}

export async function configureSharedBackend(
  env: SharedBackendEnvironment,
  defaultConfigDir: string,
): Promise<{ pid: number; url: string } | null> {
  if (env.CRAFT_SERVER_URL) return null

  const configDir = env.CRAFT_CONFIG_DIR || defaultConfigDir
  const connection = await readLiveServerConnection(join(configDir, '.server-endpoint.json'))
  if (!connection) return null

  env.CRAFT_SERVER_URL = connection.endpoint.url
  env.CRAFT_SERVER_TOKEN = connection.token
  return {
    pid: connection.endpoint.pid,
    url: connection.endpoint.url,
  }
}

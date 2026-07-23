import { join } from 'node:path'

export const MORTISE_STATE_DATABASE_FILENAME = 'state.sqlite'
export const MORTISE_STATE_WRITER_VERSION = 1
export const GLOBAL_CONFIG_RECORD_NAMESPACE = 'config'
export const GLOBAL_CONFIG_RECORD_KEY = 'root'

/** Resolve Mortise's shared state database without consulting process-global config paths. */
export function getMortiseStateDatabasePath(configDirectory: string): string {
  return join(configDirectory, MORTISE_STATE_DATABASE_FILENAME)
}

export const WORKSPACE_CONFIG_RECORD_KEY = 'root'

/** Normalize a workspace root into the canonical SQLite record namespace. */
export function normalizeWorkspaceRecordNamespace(rootPath: string): string {
  return rootPath.replace(/\\/g, '/')
}

/** Return the side-effect-free identity of a workspace configuration record. */
export function getWorkspaceConfigRecordIdentity(rootPath: string): Readonly<{
  namespace: string
  key: typeof WORKSPACE_CONFIG_RECORD_KEY
}> {
  return {
    namespace: normalizeWorkspaceRecordNamespace(rootPath),
    key: WORKSPACE_CONFIG_RECORD_KEY,
  }
}

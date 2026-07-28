export const WORKSPACE_CONFIG_RECORD_KEY = 'root'

export const WORKSPACE_TOPOLOGY_RECORD_NAMESPACE = 'workspace-topology'
export const WORKSPACE_TOPOLOGY_RECORD_KEY = 'root'
export const WORKSPACE_TOPOLOGY_REGISTRY_NAMESPACE = 'workspace-topology-registry'
export const WORKSPACE_TOPOLOGY_REGISTRY_KEY = 'root'
export const WORKSPACE_TOPOLOGY_OPERATION_NAMESPACE = 'workspace-topology-operation'
export const WORKSPACE_TRANSFER_OPERATION_NAMESPACE = 'workspace-transfer-operation'
export const WORKSPACE_TRANSFER_DESTINATION_NAMESPACE = 'workspace-transfer-destination'

/** Return the stable, path-independent identity of a Workspace topology record. */
export function getWorkspaceTopologyRecordIdentity(workspaceId: string): Readonly<{
  namespace: typeof WORKSPACE_TOPOLOGY_RECORD_NAMESPACE
  key: string
}> {
  const id = workspaceId.trim()
  if (!id) throw new TypeError('workspaceId must not be empty')
  return { namespace: WORKSPACE_TOPOLOGY_RECORD_NAMESPACE, key: id }
}

/** Return the canonical reservation identity for one destination path. */
export function getWorkspaceTransferDestinationIdentity(
  workspaceId: string,
  locationId: string,
  relativePath: string,
): Readonly<{ namespace: string; key: string }> {
  const workspace = workspaceId.trim()
  const location = locationId.trim()
  if (!workspace || !location || !relativePath) throw new TypeError('Workspace destination identity is incomplete')
  return {
    namespace: `${WORKSPACE_TRANSFER_DESTINATION_NAMESPACE}/${encodeURIComponent(workspace)}/${encodeURIComponent(location)}`,
    key: relativePath,
  }
}

/** Return the canonical Workspace membership registry identity. */
export function getWorkspaceTopologyRegistryIdentity(): Readonly<{
  namespace: typeof WORKSPACE_TOPOLOGY_REGISTRY_NAMESPACE
  key: typeof WORKSPACE_TOPOLOGY_REGISTRY_KEY
}> {
  return {
    namespace: WORKSPACE_TOPOLOGY_REGISTRY_NAMESPACE,
    key: WORKSPACE_TOPOLOGY_REGISTRY_KEY,
  }
}

/** Return the durable receipt identity for an idempotent topology command. */
export function getWorkspaceTopologyOperationIdentity(
  workspaceId: string,
  operationId: string,
): Readonly<{ namespace: string; key: string }> {
  const workspace = workspaceId.trim()
  const operation = operationId.trim()
  if (!workspace) throw new TypeError('workspaceId must not be empty')
  if (!operation) throw new TypeError('operationId must not be empty')
  return {
    namespace: `${WORKSPACE_TOPOLOGY_OPERATION_NAMESPACE}/${workspace}`,
    key: operation,
  }
}

/** Return the durable receipt identity for an endpoint-qualified transfer. */
export function getWorkspaceTransferOperationIdentity(
  workspaceId: string,
  operationId: string,
): Readonly<{ namespace: string; key: string }> {
  const workspace = workspaceId.trim()
  const operation = operationId.trim()
  if (!workspace) throw new TypeError('workspaceId must not be empty')
  if (!operation) throw new TypeError('operationId must not be empty')
  return {
    namespace: `${WORKSPACE_TRANSFER_OPERATION_NAMESPACE}/${workspace}`,
    key: operation,
  }
}

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

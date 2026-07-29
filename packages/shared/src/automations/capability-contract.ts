export const AUTOMATION_WORKSPACE_CAPABILITY_V1 = 'automation.workspace' as const

export const AUTOMATION_WORKSPACE_OPERATIONS_V1 = [
  'describe',
  'list',
  'get',
  'validate',
  'simulate',
  'create',
  'update',
  'delete',
  'set-enabled',
  'run',
  'get-run',
  'list-runs',
  'list-changes',
  'emit-event',
] as const

export type AutomationWorkspaceOperationV1 = typeof AUTOMATION_WORKSPACE_OPERATIONS_V1[number]

export const AUTOMATION_PERMISSION_SCOPES_V1 = [
  'automations.read',
  'automations.history.read',
  'automations.write',
  'automations.run',
  'automations.events.emit',
] as const

export type AutomationPermissionScopeV1 = typeof AUTOMATION_PERMISSION_SCOPES_V1[number]

export const AUTOMATION_WORKSPACE_MUTATING_OPERATIONS_V1 = [
  'create',
  'update',
  'delete',
  'set-enabled',
  'run',
  'emit-event',
] as const satisfies readonly AutomationWorkspaceOperationV1[]

export interface AutomationCapabilityVersionRangeV1 {
  minRead: number
  maxRead: number
  minWrite: number
  maxWrite: number
}

export interface AutomationWorkspaceDescriptionV1 {
  capability: typeof AUTOMATION_WORKSPACE_CAPABILITY_V1
  schemaVersion: 1
  operations: AutomationWorkspaceOperationV1[]
  capabilities: {
    'automations.definitions': AutomationCapabilityVersionRangeV1
    'automations.ingress': AutomationCapabilityVersionRangeV1
    'automations.runs': AutomationCapabilityVersionRangeV1
    'automations.history': AutomationCapabilityVersionRangeV1
  }
  triggerKinds: Array<'event' | 'cron' | 'once' | 'interval'>
  actionKinds: Array<'prompt' | 'webhook'>
  targetKinds: Array<'new-session' | 'session'>
  limits: {
    maxEventBytes: number
    maxConditionDepth: number
    maxMatcherLength: number
    maxEventTypeLength: number
    maxRunListLimit: number
  }
  permissionScopes: AutomationPermissionScopeV1[]
}

const AUTOMATION_WORKSPACE_CAPABILITY_VERSIONS_V1 = {
  'automations.definitions': { minRead: 4, maxRead: 4, minWrite: 4, maxWrite: 4 },
  'automations.ingress': { minRead: 2, maxRead: 2, minWrite: 2, maxWrite: 2 },
  'automations.runs': { minRead: 2, maxRead: 2, minWrite: 2, maxWrite: 2 },
  'automations.history': { minRead: 2, maxRead: 2, minWrite: 2, maxWrite: 2 },
} as const

/** Sole source for advertised Automation operations, versions, kinds, limits, and scopes. */
export function createAutomationWorkspaceDescriptionV1(): AutomationWorkspaceDescriptionV1 {
  return {
    capability: AUTOMATION_WORKSPACE_CAPABILITY_V1,
    schemaVersion: 1,
    operations: [...AUTOMATION_WORKSPACE_OPERATIONS_V1],
    capabilities: structuredClone(AUTOMATION_WORKSPACE_CAPABILITY_VERSIONS_V1),
    triggerKinds: ['event', 'cron', 'once', 'interval'],
    actionKinds: ['prompt', 'webhook'],
    targetKinds: ['new-session', 'session'],
    limits: {
      maxEventBytes: 1_048_576,
      maxConditionDepth: 8,
      maxMatcherLength: 500,
      maxEventTypeLength: 255,
      maxRunListLimit: 500,
    },
    permissionScopes: [...AUTOMATION_PERMISSION_SCOPES_V1],
  }
}

import { describe, expect, it } from 'bun:test'
import {
  AUTOMATION_WORKSPACE_OPERATIONS_V1,
  parseAutomationWorkspaceCapabilityRequestV1,
  parseAutomationWorkspaceCapabilityResultV1,
  parseAutomationWorkspaceCommandV1,
  parseAutomationWorkspaceOperationResultV1,
  type AutomationWorkspaceCapabilityRequestV1,
  type AutomationWorkspaceCommandV1,
  validateAutomationWorkspaceCapabilityRequestV1,
  validateAutomationWorkspaceCapabilityResultV1,
  validateAutomationWorkspaceCommandV1,
  validateAutomationWorkspaceOperationResultV1,
} from '../production.ts'
import type { AutomationDefinitionV3, CloudEventV1 } from '../../automations/v3-types.ts'

const definition: AutomationDefinitionV3 = {
  id: 'automation_01K0EXAMPLE',
  name: 'Notify failed tests',
  enabled: true,
  triggers: [{ id: 'trigger_01K0EXAMPLE', type: 'event', source: 'external', eventType: 'tests.failed' }],
  actions: [{ id: 'action_01K0EXAMPLE', type: 'prompt', prompt: 'Review the failure', target: { kind: 'new-session' } }],
  createdAt: '2026-07-20T10:15:30.000Z',
  updatedAt: '2026-07-20T10:15:30.000Z',
}

const event: CloudEventV1 = {
  specversion: '1.0',
  id: 'evt_01K0EXAMPLE',
  source: 'urn:mortise:external:test',
  type: 'tests.failed',
  time: '2026-07-20T10:15:30.000Z',
  datacontenttype: 'application/json',
  data: { exitCode: 1 },
}

describe('automation.workspace/v1 requests', () => {
  it('publishes the complete canonical operation set', () => {
    expect(AUTOMATION_WORKSPACE_OPERATIONS_V1).toEqual([
      'describe', 'list', 'get', 'validate', 'simulate', 'create', 'update', 'delete',
      'set-enabled', 'run', 'get-run', 'list-runs', 'emit-event',
    ])
  })

  it('parses strict versioned commands and preserves JSON round trips', () => {
    const commands: AutomationWorkspaceCommandV1[] = [
      { schemaVersion: 1, operation: 'describe' },
      { schemaVersion: 1, operation: 'list' },
      { schemaVersion: 1, operation: 'get', automationId: definition.id },
      { schemaVersion: 1, operation: 'validate', definition },
      { schemaVersion: 1, operation: 'simulate', event, sourceKind: 'external' },
      { schemaVersion: 1, operation: 'create', operationId: 'op-create', expectedRevision: null, definition },
      { schemaVersion: 1, operation: 'update', operationId: 'op-update', expectedRevision: 2, definition },
      { schemaVersion: 1, operation: 'delete', operationId: 'op-delete', expectedRevision: 2, automationId: definition.id },
      { schemaVersion: 1, operation: 'set-enabled', operationId: 'op-enabled', expectedRevision: 2, automationId: definition.id, enabled: false },
      { schemaVersion: 1, operation: 'run', operationId: 'op-run', automationId: definition.id, triggerId: definition.triggers[0]!.id },
      { schemaVersion: 1, operation: 'get-run', runId: 'run_01K0EXAMPLE' },
      { schemaVersion: 1, operation: 'list-runs', automationId: definition.id, limit: 50 },
      { schemaVersion: 1, operation: 'emit-event', operationId: 'op-emit', event },
    ]
    for (const command of commands) {
      expect(parseAutomationWorkspaceCommandV1(JSON.parse(JSON.stringify(command)))).toEqual(command)
    }
  })

  it('requires operation identity and compare-and-swap revision fields', () => {
    expect(validateAutomationWorkspaceCommandV1({ schemaVersion: 1, operation: 'run', automationId: definition.id })).toContain('operationId')
    expect(validateAutomationWorkspaceCommandV1({ schemaVersion: 1, operation: 'update', operationId: 'op-update', definition })).toContain('expectedRevision')
    expect(validateAutomationWorkspaceCommandV1({ schemaVersion: 1, operation: 'set-enabled', operationId: 'op', expectedRevision: 1, automationId: definition.id, enabled: true, extra: true })).toContain('Unrecognized key')
  })

  it('does not let emit-event callers self-assign a trusted source kind', () => {
    expect(validateAutomationWorkspaceCommandV1({
      schemaVersion: 1,
      operation: 'emit-event',
      operationId: 'op-emit',
      event,
      sourceKind: 'mortise',
    })).toContain('Unrecognized key')
  })

  it('refines the generic capability envelope without changing it', () => {
    const request: AutomationWorkspaceCapabilityRequestV1<'create'> = {
      version: 1,
      requestId: 'request-1',
      capability: 'automation.workspace',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      extensionId: 'extension-1',
      operation: 'create',
      input: { schemaVersion: 1, operationId: 'op-create', expectedRevision: 1, definition },
    }
    expect(parseAutomationWorkspaceCapabilityRequestV1(request)).toEqual(request)
    expect(validateAutomationWorkspaceCapabilityRequestV1({ ...request, capability: 'scheduler.workspace' })).toContain('automation.workspace')
    expect(validateAutomationWorkspaceCapabilityRequestV1({
      ...request,
      input: { ...request.input, operation: 'delete' },
    })).toContain('operation belongs to the capability envelope')
  })
})

describe('automation.workspace/v1 results', () => {
  it('validates operation-specific success data', () => {
    expect(parseAutomationWorkspaceOperationResultV1('run', {
      schemaVersion: 1,
      operationId: 'op-run',
      status: 'accepted',
      data: { runId: 'run_01K0EXAMPLE' },
    })).toMatchObject({ status: 'accepted' })

    expect(validateAutomationWorkspaceOperationResultV1('emit-event', {
      schemaVersion: 1,
      operationId: 'op-emit',
      status: 'accepted',
      data: { eventId: 'event_01K0EXAMPLE', runIds: [], persisted: true },
    })).toBeNull()

    expect(parseAutomationWorkspaceCapabilityResultV1('run', {
      requestId: 'request-1',
      status: 'success',
      output: {
        schemaVersion: 1,
        operationId: 'op-run',
        status: 'accepted',
        data: { runId: 'run_01K0EXAMPLE' },
      },
    })).toMatchObject({ status: 'success' })
  })

  it('rejects mismatched data and missing operation correlation', () => {
    expect(validateAutomationWorkspaceOperationResultV1('run', {
      schemaVersion: 1,
      operationId: 'op-run',
      status: 'accepted',
      data: { runIds: ['run_01K0EXAMPLE'] },
    })).toContain('runId')
    expect(validateAutomationWorkspaceOperationResultV1('delete', {
      schemaVersion: 1,
      status: 'ok',
    })).toContain('operationId')
    expect(validateAutomationWorkspaceOperationResultV1('run', {
      schemaVersion: 1,
      operationId: 'op-run',
      status: 'accepted',
    })).toContain('require data')
    expect(validateAutomationWorkspaceCapabilityResultV1('run', {
      requestId: 'request-1',
      status: 'success',
      output: { schemaVersion: 1, operationId: 'op-run', status: 'accepted', data: { runIds: [] } },
    })).toContain('runId')
  })
})

import { describe, expect, it } from 'bun:test'
import { createAutomationAsyncApiDocumentV1 } from './v3-asyncapi.ts'

describe('Automations AsyncAPI description', () => {
  it('derives a description-only CloudEvents channel from the normative schema', () => {
    const document = createAutomationAsyncApiDocumentV1() as any
    expect(document.asyncapi).toBe('3.0.0')
    expect(document.channels.workspaceAutomationEvents).toMatchObject({
      address: '/api/automations/workspaces/{workspaceId}/events',
      bindings: { http: { method: 'POST' } },
    })
    const payload = document.components.messages.cloudEventV1.payload
    expect(payload.required).toEqual(expect.arrayContaining(['specversion', 'id', 'source', 'type', 'time', 'data']))
    expect(payload.properties.specversion.const).toBe('1.0')
    expect(payload.additionalProperties).toBe(false)
  })
})

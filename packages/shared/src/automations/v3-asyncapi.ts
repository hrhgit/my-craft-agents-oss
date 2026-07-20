import { z } from 'zod'
import { CloudEventV1Schema } from './v3-schemas.ts'

export interface AutomationAsyncApiDocumentOptionsV1 {
  serverHost?: string
  serverProtocol?: 'http' | 'https'
}

/** Generate an AsyncAPI description from the normative runtime event schema. */
export function createAutomationAsyncApiDocumentV1(
  options: AutomationAsyncApiDocumentOptionsV1 = {},
): Record<string, unknown> {
  return {
    asyncapi: '3.0.0',
    info: {
      title: 'Mortise Automations Event Ingress',
      version: '1.0.0',
      description: 'Description-only contract for Host-owned CloudEvents ingress. AsyncAPI is not the Mortise execution runtime.',
    },
    defaultContentType: 'application/cloudevents+json',
    servers: {
      local: {
        host: options.serverHost ?? '127.0.0.1:{port}',
        protocol: options.serverProtocol ?? 'http',
        description: 'Loopback-only Mortise Host ingress.',
        variables: { port: { default: '9100' } },
        security: [{ $ref: '#/components/securitySchemes/workspaceToken' }],
      },
    },
    channels: {
      workspaceAutomationEvents: {
        address: '/api/automations/workspaces/{workspaceId}/events',
        parameters: {
          workspaceId: { description: 'Workspace identity bound by the authenticated Host route.' },
        },
        messages: { cloudEvent: { $ref: '#/components/messages/cloudEventV1' } },
        bindings: { http: { method: 'POST', bindingVersion: '0.3.0' } },
      },
    },
    operations: {
      emitWorkspaceAutomationEvent: {
        action: 'send',
        channel: { $ref: '#/channels/workspaceAutomationEvents' },
        messages: [{ $ref: '#/channels/workspaceAutomationEvents/messages/cloudEvent' }],
      },
    },
    components: {
      messages: {
        cloudEventV1: {
          name: 'CloudEventV1',
          title: 'Mortise Automation CloudEvent',
          contentType: 'application/cloudevents+json',
          payload: z.toJSONSchema(CloudEventV1Schema, { target: 'draft-7' }),
        },
      },
      securitySchemes: {
        workspaceToken: {
          type: 'httpApiKey',
          name: 'Authorization',
          in: 'header',
          scheme: 'bearer',
          description: 'Workspace-scoped rotatable bearer token.',
        },
      },
    },
  }
}

import type { CapabilityProvider } from '../types.ts'

export interface SystemNotificationInput {
  title: string
  body: string
}

export type ShowSystemNotification = (
  input: SystemNotificationInput,
  route: { sessionId: string },
) => void | Promise<void>

function parseInput(input: unknown): SystemNotificationInput {
  if (!input || typeof input !== 'object') throw new Error('Notification input must be an object')
  const value = input as Record<string, unknown>
  if (typeof value.title !== 'string' || value.title.trim() === '') throw new Error('Notification title must be a non-empty string')
  if (typeof value.body !== 'string') throw new Error('Notification body must be a string')
  return {
    title: value.title,
    body: value.body,
  }
}

export function createSystemNotificationProvider(show: ShowSystemNotification): CapabilityProvider {
  return {
    capability: 'system.notification',
    async invoke(operation, input, context) {
      if (operation !== 'show') throw new Error(`Unsupported system.notification operation: ${operation}`)
      await show(parseInput(input), { sessionId: context.request.sessionId })
      return { shown: true }
    },
  }
}

import type { SendMessageToSessionRequest, SessionToolContext } from '../context.ts'
import type { ToolResult } from '../types.ts'
import { errorResponse, successResponse } from '../response.ts'

export type SendMessageToSessionArgs = Omit<SendMessageToSessionRequest, 'sourceSessionId'>

export async function handleSendMessageToSession(
  ctx: SessionToolContext,
  args: SendMessageToSessionArgs,
): Promise<ToolResult> {
  if (!ctx.sendMessageToSession) return errorResponse('send_message_to_session is not available in this context.')
  if (!args.sessionId?.trim()) return errorResponse('sessionId is required.')
  if (!args.message?.trim()) return errorResponse('message is required.')
  if (args.sessionId === ctx.sessionId) {
    return errorResponse('Cannot send a cross-session message to the current session.')
  }
  try {
    const result = await ctx.sendMessageToSession({ ...args, sourceSessionId: ctx.sessionId })
    return successResponse(JSON.stringify(result, null, 2))
  } catch (error) {
    return errorResponse(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`)
  }
}

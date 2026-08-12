import type { CreateSessionRequest, SessionToolContext } from '../context.ts'
import type { ToolResult } from '../types.ts'
import { errorResponse, successResponse } from '../response.ts'

export type CreateSessionArgs = Omit<CreateSessionRequest, 'sourceSessionId'>

export async function handleCreateSession(
  ctx: SessionToolContext,
  args: CreateSessionArgs,
): Promise<ToolResult> {
  if (!ctx.createSession) return errorResponse('create_session is not available in this context.')
  if (!args.message?.trim()) return errorResponse('message is required.')
  try {
    const result = await ctx.createSession({ ...args, sourceSessionId: ctx.sessionId })
    return successResponse(JSON.stringify(result, null, 2))
  } catch (error) {
    return errorResponse(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`)
  }
}

import type { ReadSessionOptions, SessionToolContext } from '../context.ts'
import type { ToolResult } from '../types.ts'
import { errorResponse, successResponse } from '../response.ts'

export interface ReadSessionArgs extends ReadSessionOptions {
  sessionId: string
}

export async function handleReadSession(
  ctx: SessionToolContext,
  args: ReadSessionArgs,
): Promise<ToolResult> {
  if (!ctx.readSession) return errorResponse('read_session is not available in this context.')
  if (!args.sessionId?.trim()) return errorResponse('sessionId is required.')
  try {
    const { sessionId, ...options } = args
    const result = await ctx.readSession(sessionId, options)
    return successResponse(JSON.stringify(result, null, 2))
  } catch (error) {
    return errorResponse(`Failed to read session: ${error instanceof Error ? error.message : String(error)}`)
  }
}

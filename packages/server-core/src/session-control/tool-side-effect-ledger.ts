import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getSessionPath } from '@mortise/shared/sessions'

export const TOOL_SIDE_EFFECT_RECORD_SCHEMA = 'mortise.tool-side-effect/v1' as const

export type ToolSideEffectStatus = 'started' | 'completed' | 'outcome-unknown'

export interface ToolSideEffectRecordV1 {
  schema: typeof TOOL_SIDE_EFFECT_RECORD_SCHEMA
  sessionId: string
  attemptId: string
  toolCallId: string
  toolName: string
  status: ToolSideEffectStatus
  recordedAt: string
  isError?: boolean
}

export interface ToolSideEffectRecorder {
  record(input: Omit<ToolSideEffectRecordV1, 'schema' | 'recordedAt'>): Promise<void>
}

export class FileToolSideEffectLedger implements ToolSideEffectRecorder {
  constructor(private readonly workspaceId: string, private readonly sessionId: string) {}

  get path(): string {
    return join(getSessionPath(this.workspaceId, this.sessionId), 'tool-side-effects.v1.jsonl')
  }

  async record(input: Omit<ToolSideEffectRecordV1, 'schema' | 'recordedAt'>): Promise<void> {
    if (input.sessionId !== this.sessionId) {
      throw new Error(`Tool side-effect Session mismatch: ${input.sessionId}`)
    }
    const record: ToolSideEffectRecordV1 = {
      schema: TOOL_SIDE_EFFECT_RECORD_SCHEMA,
      ...input,
      recordedAt: new Date().toISOString(),
    }
    await mkdir(dirname(this.path), { recursive: true })
    const handle = await open(this.path, 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

export async function readToolSideEffectRecords(path: string): Promise<ToolSideEffectRecordV1[]> {
  const contents = await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as ToolSideEffectRecordV1)
}

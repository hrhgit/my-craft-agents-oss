import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSharedPiSessionsDirForTests } from '@mortise/shared/sessions'
import { FileToolSideEffectLedger, readToolSideEffectRecords, TOOL_SIDE_EFFECT_RECORD_SCHEMA } from './tool-side-effect-ledger'

describe('tool side-effect ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-side-effects-'))

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined)
    rmSync(root, { recursive: true, force: true })
  })

  it('writes versioned started, completed and outcome-unknown receipts outside the transcript', async () => {
    setSharedPiSessionsDirForTests(root)
    const ledger = new FileToolSideEffectLedger('workspace', 'session')
    const base = {
      sessionId: 'session',
      attemptId: 'attempt-1',
      toolName: 'bash',
    }
    await ledger.record({ ...base, toolCallId: 'known', status: 'started' })
    await ledger.record({ ...base, toolCallId: 'known', status: 'completed', isError: false })
    await ledger.record({ ...base, toolCallId: 'unknown', status: 'started' })
    await ledger.record({ ...base, toolCallId: 'unknown', status: 'outcome-unknown' })

    const records = await readToolSideEffectRecords(ledger.path)
    expect(records.map(record => [record.schema, record.toolCallId, record.status])).toEqual([
      [TOOL_SIDE_EFFECT_RECORD_SCHEMA, 'known', 'started'],
      [TOOL_SIDE_EFFECT_RECORD_SCHEMA, 'known', 'completed'],
      [TOOL_SIDE_EFFECT_RECORD_SCHEMA, 'unknown', 'started'],
      [TOOL_SIDE_EFFECT_RECORD_SCHEMA, 'unknown', 'outcome-unknown'],
    ])
  })
})

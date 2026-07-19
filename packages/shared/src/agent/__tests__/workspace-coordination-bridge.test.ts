import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceCoordinationStore } from '../../coordination/index.ts'
import {
  WorkspaceCoordinationBridge,
  type CoordinationToolRequest,
} from '../workspace-coordination-bridge.ts'

const temporaryDirectories: string[] = []

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'mortise-coordination-bridge-'))
  const configDir = join(root, 'config')
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  temporaryDirectories.push(root)
  return { configDir, workspaceRoot }
}

function request(toolCallId: string, toolName: string, input: Record<string, unknown>): CoordinationToolRequest {
  return {
    toolCallId,
    toolName,
    input,
    assistantResponseId: `response-${toolCallId}`,
    assistantTimestamp: 1_000,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('WorkspaceCoordinationBridge', () => {
  it('blocks a second agent before it edits a claimed file', async () => {
    const paths = harness()
    const filePath = join(paths.workspaceRoot, 'shared.ts')
    writeFileSync(filePath, 'before\n')
    const first = new WorkspaceCoordinationBridge({ ...paths, workspaceId: 'ws', sessionId: 'session-a' })
    const second = new WorkspaceCoordinationBridge({ ...paths, workspaceId: 'ws', sessionId: 'session-b' })
    try {
      expect(await first.afterPermission(request('tool-a', 'write', { path: filePath }), { action: 'allow' }))
        .toEqual({ action: 'allow' })
      await first.recordResult({ ...request('tool-a', 'write', { path: filePath }), isError: false })
      const blocked = await second.afterPermission(request('tool-b', 'edit', { path: filePath }), { action: 'allow' })
      expect(blocked.action).toBe('block')
      if (blocked.action === 'block') expect(blocked.reason).toContain('session-a')
      first.completeTurn()
      expect(await second.afterPermission(request('tool-c', 'edit', { path: filePath }), { action: 'allow' }))
        .toEqual({ action: 'allow' })
    } finally {
      first.close()
      second.close()
    }
  })

  it('records exact before and after blobs with response provenance', async () => {
    const paths = harness()
    const filePath = join(paths.workspaceRoot, 'example.ts')
    writeFileSync(filePath, 'before\n')
    const bridge = new WorkspaceCoordinationBridge({ ...paths, workspaceId: 'ws', sessionId: 'session-a' })
    try {
      const toolRequest = request('tool-a', 'write', { path: filePath, _intent: 'Update example' })
      await bridge.afterPermission(toolRequest, { action: 'allow' })
      writeFileSync(filePath, 'after\n')
      await bridge.recordResult({ ...toolRequest, isError: false })

      const store = WorkspaceCoordinationStore.open({ ...paths, workspaceId: 'ws', writerId: 'reader' })
      try {
        const [change] = store.listRecentChanges(1)
        expect(change?.actor).toMatchObject({
          sessionId: 'session-a',
          toolUseId: 'tool-a',
          assistantResponseId: 'response-tool-a',
        })
        expect(change?.summary).toBe('Update example')
        expect(change?.before && Buffer.from(store.readBlob(change.before.oid)).toString()).toBe('before\n')
        expect(change?.after && Buffer.from(store.readBlob(change.after.oid)).toString()).toBe('after\n')
        expect(store.snapshot().activities).toHaveLength(1)
        bridge.completeTurn()
        expect(store.snapshot().activities).toEqual([])
      } finally {
        store.close()
      }
    } finally {
      bridge.close()
    }
    expect(readFileSync(filePath, 'utf8')).toBe('after\n')
  })

  it('ignores read-only shell commands and records broad advisory mutation attribution', async () => {
    const paths = harness()
    const bridge = new WorkspaceCoordinationBridge({
      ...paths,
      workspaceId: 'ws',
      sessionId: 'session-a',
      isReadOnlyShellCommand: command => command === 'git status',
    })
    try {
      const read = request('read', 'bash', { command: 'git status' })
      await bridge.afterPermission(read, { action: 'allow' })
      await bridge.recordResult({ ...read, isError: false })

      const write = request('write', 'bash', { command: 'git add src/app.ts' })
      await bridge.afterPermission(write, { action: 'allow' })
      await bridge.recordResult({ ...write, isError: false })
      bridge.completeTurn()

      const store = WorkspaceCoordinationStore.open({ ...paths, workspaceId: 'ws', writerId: 'reader' })
      try {
        const changes = store.listRecentChanges(10)
        expect(changes).toHaveLength(1)
        expect(changes[0]?.resource).toMatchObject({ kind: 'logical', name: 'workspace/fs' })
        expect(changes[0]?.summary).toContain('broad shell attribution')
      } finally {
        store.close()
      }
    } finally {
      bridge.close()
    }
  })
})

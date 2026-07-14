import { describe, expect, it } from 'bun:test'
import type { ExtensionUINode } from '@craft-agent/shared/protocol'
import { isAcceptableSandboxMessage, isSandboxValidationBridgeEnabled } from './SandboxAppHost'

type SandboxNode = Extract<ExtensionUINode, { type: 'sandbox-app' }>
const node: SandboxNode = { type: 'sandbox-app', appId: 'test', title: 'Test', html: '', permissions: ['validation'] }

describe('SandboxAppHost validation bridge', () => {
  it('rejects null, undefined, and values that stringify to undefined', () => {
    expect(isAcceptableSandboxMessage(null)).toBe(false)
    expect(isAcceptableSandboxMessage(undefined)).toBe(false)
    expect(isAcceptableSandboxMessage({ toJSON: () => undefined })).toBe(false)
  })

  it('rejects unserializable and oversized messages', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(isAcceptableSandboxMessage(circular)).toBe(false)
    expect(isAcceptableSandboxMessage({ value: 'x'.repeat(32_768) })).toBe(false)
  })

  it('accepts bounded object messages', () => {
    expect(isAcceptableSandboxMessage({ type: 'ready' })).toBe(true)
  })

  it('requires both an explicit permission and an advertised development host capability', () => {
    expect(isSandboxValidationBridgeEnabled(node, { schemaVersion: 1, available: true })).toBe(true)
    expect(isSandboxValidationBridgeEnabled({ ...node, permissions: [] }, { schemaVersion: 1, available: true })).toBe(false)
    expect(isSandboxValidationBridgeEnabled(node, null)).toBe(false)
  })

  it('keeps validation messages within the sandbox message budget', () => {
    expect(isAcceptableSandboxMessage({ type: 'validation.upsert', requestId: '1', definition: { id: 'panel' } })).toBe(true)
    expect(isAcceptableSandboxMessage({ type: 'validation.upsert', definition: { label: 'x'.repeat(40_000) } })).toBe(false)
  })
})

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, '../ChatDisplay.tsx'), 'utf8')

describe('ChatDisplay Pi-first turn ownership', () => {
  it('renders projection-derived turns through the established chat components', () => {
    expect(source).toContain('buildPiTurns(projectionEntities, projectionOverlay)')
    expect(source).toContain('<MemoizedMessageBubble')
    expect(source).toContain('<MemoizedAuthRequestCard')
    expect(source).toContain('<TurnCard')
  })

  it('rejects projection sequence numbers as elapsed-time timestamps', () => {
    expect(source).toContain('MIN_REASONABLE_TIMESTAMP_MS')
    expect(source).toContain('startTime >= MIN_REASONABLE_TIMESTAMP_MS')
    expect(source).toContain('resolveElapsedStartTime(startTime, mountedAt)')
    expect(source).toContain('Math.max(0, Math.floor((now - startTime) / 1000))')
  })

  it('does not keep a production legacy or standalone Pi timeline branch', () => {
    expect(source).not.toContain('groupMessagesByTurn')
    expect(source).not.toContain('showPiProjectionTimeline')
    expect(source).not.toContain('sessionOwnsPiProjection')
    expect(source).not.toContain('<PiProjectionTimeline')
    expect(source).not.toContain("session.messages.findLast(m => m.role === 'plan')")
  })
})

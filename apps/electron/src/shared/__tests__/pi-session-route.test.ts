import { describe, expect, it } from 'bun:test'
import {
  fromPiReadOnlySessionId,
  isPiReadOnlySessionId,
  toPiReadOnlySessionId,
  toPiReadOnlySessionRoute,
} from '../pi-session-route'

describe('pi session route helpers', () => {
  it('normalizes raw pi child ids to read-only route ids', () => {
    expect(toPiReadOnlySessionId('child-1')).toBe('pi-child-1')
    expect(toPiReadOnlySessionId('pi-child-1')).toBe('pi-child-1')
  })

  it('extracts raw pi ids from route ids', () => {
    expect(fromPiReadOnlySessionId('pi-child-1')).toBe('child-1')
    expect(fromPiReadOnlySessionId('child-1')).toBe('child-1')
  })

  it('builds the shared ChatPage route used by embedded and child windows', () => {
    expect(isPiReadOnlySessionId('pi-child-1')).toBe(true)
    expect(toPiReadOnlySessionRoute('child-1')).toBe('allSessions/session/pi-child-1')
  })
})

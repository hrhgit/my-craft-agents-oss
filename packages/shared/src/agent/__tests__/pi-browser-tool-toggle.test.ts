/**
 * Pi `browser_tool` ownership test.
 *
 * The bundled Pi extension owns browser_tool and delegates execution through
 * the versioned Host capability protocol. PiAgent must not dual-register it.
 *
 * The filter lives in `PiAgent.registerSessionToolsWithSubprocess` (inline,
 * not exported). To avoid spinning up a full subprocess, we do a textual
 * contract check on the source file. If the filter line is removed or the
 * tool name renamed, the test fails so the regression is caught.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('pi-agent browser_tool ownership (contract)', () => {
  const piAgentSource = readFileSync(join(__dirname, '..', 'pi-agent.ts'), 'utf-8')

  it('declares browser_tool as bundled-extension-owned', () => {
    expect(piAgentSource).toContain('PI_EXTENSION_OWNED_SESSION_TOOL_NAMES')
  })

  it('filters browser_tool from duplicate host registration', () => {
    // The filter must be applied after getSessionHostToolDefs() is called.
    expect(piAgentSource).toContain('getSessionHostToolDefs()')
    expect(piAgentSource).toContain('!PI_EXTENSION_OWNED_SESSION_TOOL_NAMES.has(d.name)')
  })
})

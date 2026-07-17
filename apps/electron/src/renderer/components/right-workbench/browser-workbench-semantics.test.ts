import { describe, expect, it } from 'bun:test'
import {
  BROWSER_CREATE_SEMANTIC_ID,
  browserWorkbenchSemanticId,
} from './browser-workbench-semantics'

describe('browser workbench semantic identity', () => {
  it('keeps the launcher stable and scopes instance controls', () => {
    expect(BROWSER_CREATE_SEMANTIC_ID).toBe('workspace.browser.create')
    expect(browserWorkbenchSemanticId('address', 'browser/one')).toBe(
      'workspace.browser.address.browser%2Fone',
    )
    expect(browserWorkbenchSemanticId('viewport', 'browser-two')).toBe(
      'workspace.browser.viewport.browser-two',
    )
  })
})

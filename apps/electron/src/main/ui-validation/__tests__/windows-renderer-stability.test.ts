import { describe, expect, it } from 'bun:test'
import {
  isWindowsForegroundUiValidationHost,
} from '../windows-renderer-stability'

describe('Windows foreground UI validation host', () => {
  it('identifies only the foreground Windows validation host', () => {
    expect(isWindowsForegroundUiValidationHost({
      platform: 'win32',
      validationBuild: true,
      testHostEnabled: true,
      windowMode: 'foreground',
    })).toBe(true)
  })

  it('rejects production, non-host, background, and non-Windows launches', () => {
    for (const options of [
      { platform: 'win32' as const, validationBuild: false, testHostEnabled: true, windowMode: 'foreground' },
      { platform: 'win32' as const, validationBuild: true, testHostEnabled: false, windowMode: 'foreground' },
      { platform: 'win32' as const, validationBuild: true, testHostEnabled: true, windowMode: 'background' },
      { platform: 'darwin' as const, validationBuild: true, testHostEnabled: true, windowMode: 'foreground' },
    ]) {
      expect(isWindowsForegroundUiValidationHost(options)).toBe(false)
    }
  })

  it('allows real app-shell validation to opt out of the direct playground host', () => {
    expect(isWindowsForegroundUiValidationHost({
      platform: 'win32',
      validationBuild: true,
      testHostEnabled: true,
      directScenarioHost: false,
      windowMode: 'foreground',
    })).toBe(false)
  })
})

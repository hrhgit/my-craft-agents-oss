/**
 * Truth table for `derivePickerMode`. The helper is small but its behavior
 * has been wrong before (issue #727 was a precedence ordering bug) — pinning
 * each row of the matrix here so future renames / reshufflings can't
 * silently regress to the trapped state.
 */

import { describe, test, expect } from 'bun:test'
import { derivePickerMode, type PickerModeInput } from '../picker-mode'

function input(overrides: Partial<PickerModeInput> = {}): PickerModeInput {
  return {
    providerUnavailable: false,
    providerDefaultModel: null,
    isEmptySession: false,
    providerCount: 1,
    ...overrides,
  }
}

describe('derivePickerMode', () => {
  // -------------------------------------------------------------------------
  // Precedence: unavailable wins
  // -------------------------------------------------------------------------

  test('providerUnavailable beats every other flag', () => {
    expect(
      derivePickerMode(
        input({
          providerUnavailable: true,
          providerDefaultModel: 'mistral-7b',
          isEmptySession: true,
          providerCount: 5,
        }),
      ),
    ).toBe('unavailable')
  })

  // -------------------------------------------------------------------------
  // The #727 regression: switcher must win over locked-single on empty session
  // -------------------------------------------------------------------------

  test('empty session + ≥2 providers + single-model Pi default → switcher (#727)', () => {
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: 'mistral-7b',
          isEmptySession: true,
          providerCount: 2,
        }),
      ),
    ).toBe('switcher')
  })

  test('empty session + many providers + single-model Pi default → switcher', () => {
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: 'llama3',
          isEmptySession: true,
          providerCount: 7,
        }),
      ),
    ).toBe('switcher')
  })

  test('empty session + ≥2 providers + multi-model default → switcher', () => {
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: null,
          isEmptySession: true,
          providerCount: 3,
        }),
      ),
    ).toBe('switcher')
  })

  // -------------------------------------------------------------------------
  // Mid-session switching: switcher stays available after the first message
  // -------------------------------------------------------------------------

  test('non-empty session + many providers + single-model Pi default → switcher', () => {
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: 'mistral-7b',
          isEmptySession: false,
          providerCount: 5,
        }),
      ),
    ).toBe('switcher')
  })

  test('empty session + only 1 provider + single-model Pi default → locked-single (no switcher possible)', () => {
    // No other provider to switch to, so the picker stays in the disabled
    // single-row UI even on a fresh session. That's correct.
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: 'mistral-7b',
          isEmptySession: true,
          providerCount: 1,
        }),
      ),
    ).toBe('locked-single')
  })

  // -------------------------------------------------------------------------
  // Flat list: the unremarkable "list models for the active provider" case
  // -------------------------------------------------------------------------

  test('non-empty session + many providers + multi-model provider → switcher', () => {
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: null,
          isEmptySession: false,
          providerCount: 3,
        }),
      ),
    ).toBe('switcher')
  })

  test('empty session + only 1 multi-model provider → flat', () => {
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: null,
          isEmptySession: true,
          providerCount: 1,
        }),
      ),
    ).toBe('flat')
  })

  test('non-empty session + 1 provider + multi-model → flat', () => {
    expect(
      derivePickerMode(
        input({
          providerDefaultModel: null,
          isEmptySession: false,
          providerCount: 1,
        }),
      ),
    ).toBe('flat')
  })

  // -------------------------------------------------------------------------
  // Boundary: providerCount > 1 vs == 1
  // -------------------------------------------------------------------------

  test('providerCount=2 triggers switcher even mid-session (lower bound for >1)', () => {
    expect(
      derivePickerMode(
        input({ providerDefaultModel: 'm', isEmptySession: false, providerCount: 2 }),
      ),
    ).toBe('switcher')
  })

  test('providerCount=1 on empty session never triggers switcher', () => {
    expect(
      derivePickerMode(
        input({ providerDefaultModel: 'm', isEmptySession: true, providerCount: 1 }),
      ),
    ).toBe('locked-single')
  })

  // -------------------------------------------------------------------------
  // providerCount=0 — defensive: should never panic, falls through to flat
  // -------------------------------------------------------------------------

  test('providerCount=0 (no providers configured) → flat (defensive fallthrough)', () => {
    expect(
      derivePickerMode(
        input({ providerDefaultModel: null, isEmptySession: true, providerCount: 0 }),
      ),
    ).toBe('flat')
  })
})





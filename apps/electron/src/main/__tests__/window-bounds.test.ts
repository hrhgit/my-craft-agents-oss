import { describe, expect, it } from 'bun:test'
import { clampWindowBounds } from '../window-bounds'

describe('auxiliary window bounds', () => {
  it('keeps a detached window fully visible on the selected display', () => {
    expect(clampWindowBounds(
      { x: 3_700, y: 1_900, width: 1_000, height: 800 },
      { x: 1_920, y: 0, width: 1_920, height: 1_040 },
    )).toEqual({ x: 2_840, y: 240, width: 1_000, height: 800 })
  })

  it('fits minimum-size windows onto a smaller work area', () => {
    expect(clampWindowBounds(
      { x: -500, y: -300, width: 300, height: 200 },
      { x: -1_280, y: 0, width: 640, height: 480 },
    )).toEqual({ x: -1_280, y: 0, width: 640, height: 480 })
  })
})

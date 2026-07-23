import { describe, expect, test } from 'bun:test'
import { isProjectionOwnedHostEvent } from '../projection-ownership'

describe('Host event projection ownership', () => {
  test('routes durable completion to the conversation processor', () => {
    expect(isProjectionOwnedHostEvent('complete')).toBe(false)
  })

  test.each([
    'text_delta',
    'text_complete',
    'tool_start',
    'tool_result',
    'user_message',
  ])('keeps %s owned by the Pi projection', eventType => {
    expect(isProjectionOwnedHostEvent(eventType)).toBe(true)
  })
})

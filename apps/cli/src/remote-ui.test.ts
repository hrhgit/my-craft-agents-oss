import { describe, expect, it } from 'bun:test'
import type { ExtensionInteractionBridgeRequestV1 } from '@craft-agent/shared/protocol'
import {
  asExtensionInteractionRequest,
  collectExtensionInteractionAnswers,
  handleExtensionInteractionNonInteractive,
  type InteractionTerminal,
} from './remote-ui.ts'

function interactionEvent(): ExtensionInteractionBridgeRequestV1 {
  return {
    type: 'extension_interaction_request',
    requestId: 'request-1',
    extensionId: 'ask-user',
    runtimeId: 'runtime-1',
    sessionId: 'session-1',
    request: {
      schemaVersion: 1,
      title: 'Questions',
      fields: [
        {
          id: 'targets',
          kind: 'choice',
          label: 'Targets',
          required: true,
          multiple: true,
          allowOther: true,
          allowComment: true,
          options: [
            { id: 'web', label: 'Web' },
            { id: 'desktop', label: 'Desktop' },
          ],
        },
        { id: 'notes', kind: 'text', label: 'Notes', required: true, multiline: true },
        { id: 'proceed', kind: 'confirm', label: 'Proceed?', defaultValue: true },
      ],
    },
  }
}

function terminalWithAnswers(...answers: string[]): InteractionTerminal {
  return {
    ask: async () => answers.shift() ?? '',
    write: () => {},
  }
}

describe('CLI extension interaction v1', () => {
  it('strictly recognizes versioned bridge requests', () => {
    const event = interactionEvent()
    expect(asExtensionInteractionRequest(event)).toEqual(event)
    expect(asExtensionInteractionRequest({ ...event, request: { ...event.request, schemaVersion: 2 } })).toBeNull()
  })

  it('returns a structured cancellation in non-interactive mode', async () => {
    const calls: unknown[][] = []
    await handleExtensionInteractionNonInteractive(
      interactionEvent(),
      async (...args) => { calls.push(args) },
    )
    expect(calls).toEqual([[
      'session-1',
      'request-1',
      { schemaVersion: 1, status: 'cancelled', reason: 'host-disconnected' },
    ]])
  })

  it('collects choice, multiline text and confirm answers with stable ids', async () => {
    const answers = await collectExtensionInteractionAnswers(
      interactionEvent(),
      terminalWithAnswers(
        '1, 2',
        '',
        'ship both',
        'first line',
        'second line',
        '',
        '',
      ),
    )
    expect(answers).toEqual([
      {
        fieldId: 'targets',
        kind: 'choice',
        selectedOptionIds: ['web', 'desktop'],
        comment: 'ship both',
      },
      { fieldId: 'notes', kind: 'text', value: 'first line\nsecond line' },
      { fieldId: 'proceed', kind: 'confirm', value: true },
    ])
  })

  it('keeps a single-choice other answer mutually exclusive', async () => {
    const event = interactionEvent()
    event.request.fields = [{
      id: 'target',
      kind: 'choice',
      label: 'Target',
      required: true,
      allowOther: true,
      options: [{ id: 'web', label: 'Web' }],
    }]
    expect(await collectExtensionInteractionAnswers(event, terminalWithAnswers('1', 'CLI'))).toEqual([{
      fieldId: 'target',
      kind: 'choice',
      selectedOptionIds: [],
      otherText: 'CLI',
    }])
  })
})

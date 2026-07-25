import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExtensionInteractionBridgeRequestV1, ExtensionInteractionFieldV1 } from '@mortise/shared/protocol'
import {
  ExtensionInteractionComposer,
  interactionDraftAnswer,
  isInteractionDraftValid,
  selectInteractionOption,
  setInteractionOtherText,
  type InteractionDraft,
} from './ExtensionInteractionComposer'

const singleChoice: ExtensionInteractionFieldV1 = {
  id: 'location',
  kind: 'choice',
  label: 'Location',
  required: true,
  allowOther: true,
  options: [{ id: 'new-york', label: 'New York, US' }],
}

describe('ExtensionInteractionComposer', () => {
  it('uses stable option ids and preserves other text and comments as separate values', () => {
    const field: ExtensionInteractionFieldV1 = {
      ...singleChoice,
      multiple: true,
      allowComment: true,
    }
    const draft: InteractionDraft = {
      kind: 'choice',
      selectedOptionIds: ['new-york'],
      otherText: 'Paris, FR',
      comment: 'Either region, preferably nearby',
    }

    expect(interactionDraftAnswer(field, draft)).toEqual({
      fieldId: 'location',
      kind: 'choice',
      selectedOptionIds: ['new-york'],
      otherText: 'Paris, FR',
      comment: 'Either region, preferably nearby',
    })
  })

  it('keeps known and other answers mutually exclusive for single choice', () => {
    const initial: InteractionDraft = { kind: 'choice', selectedOptionIds: [], otherText: '', comment: '' }
    const selected = selectInteractionOption(initial, 'new-york', false)
    const other = setInteractionOtherText(selected, 'Paris, FR', false)
    const selectedAgain = selectInteractionOption(other, 'new-york', false)

    expect(other).toMatchObject({ selectedOptionIds: [], otherText: 'Paris, FR' })
    expect(isInteractionDraftValid(singleChoice, other)).toBe(true)
    expect(selectedAgain).toMatchObject({ selectedOptionIds: ['new-york'], otherText: '' })
    expect(isInteractionDraftValid(singleChoice, selectedAgain)).toBe(true)
  })

  it('gives single-line and multiline text controls stable accessible names', () => {
    const event: ExtensionInteractionBridgeRequestV1 = {
      type: 'extension_interaction_request',
      requestId: 'text-inputs',
      extensionId: 'ask-user',
      runtimeId: 'runtime',
      sessionId: 'session',
      request: {
        schemaVersion: 1,
        fields: [
          { id: 'name', kind: 'text', label: 'Display name' },
          { id: 'notes', kind: 'text', label: 'Release notes', multiline: true },
        ],
      },
    }

    const markup = renderToStaticMarkup(<ExtensionInteractionComposer event={event} onRespond={() => {}} />)
    expect(markup).toContain('aria-label="Display name"')
    expect(markup).toContain('aria-label="Release notes"')
  })

  it('publishes stable validation identities from protocol field and option ids', () => {
    const event: ExtensionInteractionBridgeRequestV1 = {
      type: 'extension_interaction_request',
      requestId: 'choice-input',
      extensionId: 'ask-user',
      runtimeId: 'runtime',
      sessionId: 'session',
      request: {
        schemaVersion: 1,
        fields: [{
          id: 'approach',
          kind: 'choice',
          label: 'Localized field copy',
          options: [{ id: 'prototype', label: 'Localized option copy', description: 'Copy may change independently.' }],
          allowOther: true,
          allowComment: true,
        }],
      },
    }

    const markup = renderToStaticMarkup(<ExtensionInteractionComposer event={event} onRespond={() => {}} />)
    expect(markup).toContain('data-mortise-semantic-id="extension.interaction.field.approach"')
    expect(markup).toContain('data-mortise-semantic-id="extension.interaction.field.approach.option.prototype"')
    expect(markup).toContain('data-mortise-semantic-id="extension.interaction.field.approach.other"')
    expect(markup).toContain('data-mortise-semantic-id="extension.interaction.field.approach.comment"')
    expect(markup).toContain('data-mortise-semantic-id="extension.interaction.submit"')
    expect(markup).toContain('data-mortise-ui-interactions="shortcut clipboard ime rich-text"')
    expect(markup).not.toContain('data-mortise-semantic-id="Localized option copy"')
  })
})

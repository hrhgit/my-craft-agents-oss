import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExtensionInteractionBridgeRequestV1, ExtensionInteractionFieldV1 } from '@mortise/shared/protocol'
import {
  ExtensionInteractionComposer,
  interactionDraftAnswer,
  isInteractionDraftValid,
  selectInteractionOption,
  setInteractionOtherText,
  shouldAutoAdvanceChoice,
  shouldCancelInteraction,
  skippedInteractionAnswer,
  type InteractionDraft,
} from './ExtensionInteractionComposer'

const singleChoice: ExtensionInteractionFieldV1 = {
  id: 'location',
  kind: 'choice',
  label: 'Location',
  required: true,
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

  it('only auto-advances eligible single-choice wizard steps', () => {
    expect(shouldAutoAdvanceChoice(singleChoice, false, true)).toBe(true)
    expect(shouldAutoAdvanceChoice({ ...singleChoice, allowComment: true }, false, true)).toBe(false)
    expect(shouldAutoAdvanceChoice({ ...singleChoice, multiple: true }, false, true)).toBe(false)
    expect(shouldAutoAdvanceChoice(singleChoice, true, true)).toBe(false)
    expect(shouldAutoAdvanceChoice(singleChoice, false, false)).toBe(false)
  })

  it('serializes skipped fields as type-correct empty answers', () => {
    expect(skippedInteractionAnswer(singleChoice)).toEqual({
      fieldId: 'location',
      kind: 'choice',
      selectedOptionIds: [],
    })
    expect(skippedInteractionAnswer({ id: 'notes', kind: 'text', label: 'Notes' })).toEqual({
      fieldId: 'notes',
      kind: 'text',
      value: '',
    })
  })

  it('uses Escape to cancel without interrupting IME composition', () => {
    expect(shouldCancelInteraction('Escape', false, false)).toBe(true)
    expect(shouldCancelInteraction('Escape', true, false)).toBe(false)
    expect(shouldCancelInteraction('Escape', false, true)).toBe(false)
    expect(shouldCancelInteraction('Enter', false, false)).toBe(false)
  })

  it('hides wizard progress and navigation for a single question', () => {
    const event: ExtensionInteractionBridgeRequestV1 = {
      type: 'extension_interaction_request',
      requestId: 'single-wizard',
      extensionId: 'ask-user',
      runtimeId: 'runtime',
      sessionId: 'session',
      request: {
        schemaVersion: 1,
        presentation: { mode: 'wizard', allowSkip: true, autoAdvanceSingleChoice: true },
        fields: [singleChoice],
      },
    }
    const markup = renderToStaticMarkup(<ExtensionInteractionComposer event={event} onRespond={() => {}} />)
    expect(markup).not.toContain('1 / 1')
    expect(markup).not.toContain('extension.interaction.previous')
    expect(markup).not.toContain('extension.interaction.next')
    expect(markup).toContain('extension.interaction.submit')
  })

  it('renders one wizard field with navigation, skip and inline custom answer controls', () => {
    const event: ExtensionInteractionBridgeRequestV1 = {
      type: 'extension_interaction_request',
      requestId: 'wizard-input',
      extensionId: 'ask-user',
      runtimeId: 'runtime',
      sessionId: 'session',
      request: {
        schemaVersion: 1,
        presentation: { mode: 'wizard', allowSkip: true, autoAdvanceSingleChoice: true },
        fields: [
          { id: 'first', kind: 'choice', label: 'First question', options: singleChoice.options },
          { id: 'second', kind: 'choice', label: 'Second question', multiple: true, options: singleChoice.options },
        ],
      },
    }

    const markup = renderToStaticMarkup(<ExtensionInteractionComposer event={event} onRespond={() => {}} />)
    expect(markup).toContain('data-extension-interaction-mode="wizard"')
    expect(markup).toContain('data-interaction-field="first"')
    expect(markup).not.toContain('data-interaction-field="second"')
    expect(markup).toContain('extension.interaction.previous')
    expect(markup).toContain('extension.interaction.next')
    expect(markup).toContain('extension.interaction.skip')
    expect(markup).toContain('extension.interaction.field.first.other')
  })

  it('always renders a host-provided custom answer for form choices', () => {
    const event: ExtensionInteractionBridgeRequestV1 = {
      type: 'extension_interaction_request',
      requestId: 'form-choice',
      extensionId: 'ask-user',
      runtimeId: 'runtime',
      sessionId: 'session',
      request: {
        schemaVersion: 1,
        fields: [{ id: 'area', kind: 'choice', label: 'Area', options: singleChoice.options }],
      },
    }

    const markup = renderToStaticMarkup(<ExtensionInteractionComposer event={event} onRespond={() => {}} />)
    expect(markup).toContain('extension.interaction.field.area.other')
    expect(markup).toContain('placeholder="extensionInteraction.writeOwnAnswer"')
  })

  it('renders end-aligned black-fill indicators for multiple choices', () => {
    const event: ExtensionInteractionBridgeRequestV1 = {
      type: 'extension_interaction_request',
      requestId: 'multiple-choice',
      extensionId: 'ask-user',
      runtimeId: 'runtime',
      sessionId: 'session',
      request: {
        schemaVersion: 1,
        presentation: { mode: 'wizard' },
        fields: [{ ...singleChoice, multiple: true }],
      },
    }

    const markup = renderToStaticMarkup(<ExtensionInteractionComposer event={event} onRespond={() => {}} />)
    expect(markup).toContain('data-choice-indicator="checkbox"')
    expect(markup).toContain('peer-checked:bg-black')
    expect(markup).toContain('peer-checked:text-white')
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

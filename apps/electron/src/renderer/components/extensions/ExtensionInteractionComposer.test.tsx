import { describe, expect, it } from 'bun:test'
import type { ExtensionInteractionFieldV1 } from '@craft-agent/shared/protocol'
import {
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
})

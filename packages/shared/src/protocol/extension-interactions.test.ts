import { describe, expect, it } from 'bun:test'
import {
  validateExtensionInteractionRequestV1,
  validateExtensionInteractionResponseV1,
} from './extension-interactions.ts'

const request = {
  schemaVersion: 1,
  title: 'Deployment details',
  fields: [
    {
      id: 'targets',
      kind: 'choice',
      label: 'Targets',
      multiple: true,
      allowOther: true,
      allowComment: true,
      options: [
        { id: 'new-york', label: 'New York, US' },
        { id: 'paris', label: 'Paris, FR' },
      ],
    },
    { id: 'notes', kind: 'text', label: 'Notes', multiline: true },
  ],
} as const

describe('extension interaction v1 validation', () => {
  it('accepts stable ids and preserves structured arrays and supplemental text', () => {
    expect(validateExtensionInteractionRequestV1(request)).toBeNull()
    expect(validateExtensionInteractionResponseV1({
      schemaVersion: 1,
      status: 'submitted',
      answers: [
        {
          fieldId: 'targets',
          kind: 'choice',
          selectedOptionIds: ['new-york', 'paris'],
          otherText: 'Tokyo, JP',
          comment: 'Keep labels with commas intact',
        },
        { fieldId: 'notes', kind: 'text', value: '' },
      ],
    })).toBeNull()
  })

  it('rejects unknown properties, duplicate ids and malformed answers', () => {
    expect(validateExtensionInteractionRequestV1({ ...request, extensionId: 'forged' })).toContain('Unsupported')
    expect(validateExtensionInteractionRequestV1({
      ...request,
      fields: [request.fields[0], { ...request.fields[0] }],
    })).toContain('unique')
    expect(validateExtensionInteractionResponseV1({
      schemaVersion: 1,
      status: 'submitted',
      answers: [{ fieldId: 'targets', kind: 'choice', selectedOptionIds: ['bad id'] }],
    })).toContain('Invalid choice selections')
  })

  it('rejects text fields that cannot be rendered as both multiline and sensitive', () => {
    expect(validateExtensionInteractionRequestV1({
      schemaVersion: 1,
      fields: [{ id: 'secret', kind: 'text', label: 'Secret', multiline: true, sensitive: true }],
    })).toContain('cannot be both multiline and sensitive')
  })
})

import { describe, expect, it } from 'bun:test'
import {
  parseUnacceptedSessionFailure,
  shouldRestoreComposerSubmission,
  snapshotComposerSubmission,
} from '../composer-submission'

describe('composer submission contract', () => {
  it('freezes the exact composer and outbound payload under a stable attempt ID', () => {
    const attachments = [{
      type: 'text' as const,
      path: 'C:\\workspace\\notes.txt',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 12,
    }]
    const skillSlugs = ['review']
    const attempt = snapshotComposerSubmission({
      attemptId: 'attempt-1',
      composerText: '  review this  ',
      message: 'review this\n\n## Follow-ups\n- exact note',
      attachments,
      skillSlugs,
      midStreamSendIntent: 'alternate',
    })

    attachments[0]!.name = 'changed.txt'
    attachments.length = 0
    skillSlugs[0] = 'changed'

    expect(attempt).toEqual({
      attemptId: 'attempt-1',
      composerText: '  review this  ',
      message: 'review this\n\n## Follow-ups\n- exact note',
      attachments: [expect.objectContaining({ name: 'notes.txt' })],
      skillSlugs: ['review'],
      midStreamSendIntent: 'alternate',
    })
  })

  it('restores only an untouched post-submit empty composer', () => {
    expect(shouldRestoreComposerSubmission({
      clearedRevision: 4,
      currentRevision: 4,
      currentText: '',
      currentAttachmentCount: 0,
    })).toBe(true)
    expect(shouldRestoreComposerSubmission({
      clearedRevision: 4,
      currentRevision: 5,
      currentText: 'new edit',
      currentAttachmentCount: 0,
    })).toBe(false)
    expect(shouldRestoreComposerSubmission({
      clearedRevision: 4,
      currentRevision: 5,
      currentText: '',
      currentAttachmentCount: 1,
    })).toBe(false)
  })

  it('accepts only the canonical typed terminal unaccepted failure', () => {
    const valid = Object.assign(new Error('not durable'), {
      code: 'SESSION_PERSISTENCE_FAILED',
      data: { retryable: true, terminal: true, outcome: 'unaccepted' },
    })
    expect(parseUnacceptedSessionFailure(valid)).toEqual({
      retryable: true,
      terminal: true,
      outcome: 'unaccepted',
    })
    expect(parseUnacceptedSessionFailure(Object.assign(new Error('wrong'), {
      code: 'SESSION_PERSISTENCE_FAILED',
      data: { retryable: true, terminal: false, outcome: 'unaccepted' },
    }))).toBeNull()
    expect(parseUnacceptedSessionFailure(Object.assign(new Error('wrong'), {
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      data: { retryable: true, terminal: true, outcome: 'unpublished' },
    }))).toBeNull()
  })
})

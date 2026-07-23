import { beforeAll, describe, expect, it, mock } from 'bun:test'
import type { FileAttachment, Session } from '../../../shared/types'
import type { CreateAndSendFirstTurnResult } from '@mortise/shared/protocol'
import type { NewConversationDraftOptions } from '@/lib/new-conversation'

let runFirstTurnDraftSubmission: typeof import('../NewConversationPage')['runFirstTurnDraftSubmission']
let parseUnpublishedPublicationFailure: typeof import('../NewConversationPage')['parseUnpublishedPublicationFailure']
let snapshotFirstTurnPublicationAttempt: typeof import('../NewConversationPage')['snapshotFirstTurnPublicationAttempt']

beforeAll(async () => {
  Object.assign(globalThis, {
    DOMMatrix: class DOMMatrix {},
    ImageData: class ImageData {},
    Path2D: class Path2D {},
  })
  mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
  mock.module('@/components/app-shell/input/InputContainer', () => ({ InputContainer: () => null }))
  ;({
    runFirstTurnDraftSubmission,
    parseUnpublishedPublicationFailure,
    snapshotFirstTurnPublicationAttempt,
  } = await import('../NewConversationPage'))
})

const publishedResult: CreateAndSendFirstTurnResult = {
  session: { id: 'session-1' } as Session,
  messageId: 'assistant-1',
}

describe('new conversation first-turn submission', () => {
  it('does not clear the draft or navigate before publication resolves', async () => {
    const publication = Promise.withResolvers<CreateAndSendFirstTurnResult>()
    const commitPublishedSession = mock(() => undefined)
    const preserveDraft = mock(() => undefined)

    const submission = runFirstTurnDraftSubmission(
      () => publication.promise,
      commitPublishedSession,
      preserveDraft,
    )

    await Promise.resolve()
    expect(commitPublishedSession).not.toHaveBeenCalled()
    expect(preserveDraft).not.toHaveBeenCalled()

    publication.resolve(publishedResult)
    await expect(submission).resolves.toBe(publishedResult)
    expect(commitPublishedSession).toHaveBeenCalledTimes(1)
    expect(commitPublishedSession).toHaveBeenCalledWith(publishedResult)
    expect(preserveDraft).not.toHaveBeenCalled()
  })

  it('preserves the draft and never commits when publication fails', async () => {
    const failure = new Error('first assistant message was not persisted')
    const commitPublishedSession = mock(() => undefined)
    const preserveDraft = mock(() => undefined)

    await expect(runFirstTurnDraftSubmission(
      async () => { throw failure },
      commitPublishedSession,
      preserveDraft,
    )).rejects.toBe(failure)

    expect(preserveDraft).toHaveBeenCalledTimes(1)
    expect(commitPublishedSession).not.toHaveBeenCalled()
  })

  it('parses retryable and terminal-only unpublished durability failures', () => {
    const retryable = Object.assign(new Error('projection failed'), {
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      data: {
        sessionId: 'session-1',
        stage: 'projection',
        retryable: true,
        terminal: true,
        outcome: 'unpublished',
      },
    })
    expect(parseUnpublishedPublicationFailure(retryable)).toEqual({
      retryable: true,
      terminal: true,
      outcome: 'unpublished',
      stage: 'projection',
    })
    expect(parseUnpublishedPublicationFailure(Object.assign(new Error('schema rejected'), {
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      data: { retryable: false, terminal: true, outcome: 'unpublished', stage: 'metadata' },
    }))).toEqual({
      retryable: false,
      terminal: true,
      outcome: 'unpublished',
      stage: 'metadata',
    })
  })

  it('rejects incomplete or contradictory durability failure payloads', () => {
    const failure = (data: Record<string, unknown>) => Object.assign(new Error('failed'), {
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      data,
    })
    expect(parseUnpublishedPublicationFailure(failure({ retryable: true, terminal: false, outcome: 'unpublished' }))).toBeNull()
    expect(parseUnpublishedPublicationFailure(failure({ retryable: true, terminal: true, outcome: 'published' }))).toBeNull()
    expect(parseUnpublishedPublicationFailure(failure({ retryable: 'yes', terminal: true, outcome: 'unpublished' }))).toBeNull()
    expect(parseUnpublishedPublicationFailure(failure({ retryable: true, terminal: true, outcome: 'unpublished', stage: 'unknown' }))).toBeNull()
    expect(parseUnpublishedPublicationFailure(new Error('plain failure'))).toBeNull()
  })

  it('freezes the exact submitted message, attachments, skills, and options for retry', () => {
    const attachments: FileAttachment[] = [{
      type: 'text',
      path: 'C:\\workspace\\notes.txt',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 12,
    }]
    const skillSlugs = ['review']
    const options: NewConversationDraftOptions = {
      provider: 'provider-a',
      model: 'model-a',
      thinkingLevel: 'medium',
      permissionMode: 'allow-all',
    }
    const attempt = snapshotFirstTurnPublicationAttempt(
      'the exact submitted message',
      attachments,
      skillSlugs,
      options,
    )

    attachments[0]!.name = 'changed.txt'
    attachments.length = 0
    skillSlugs[0] = 'changed'
    options.model = 'model-b'

    expect(attempt).toMatchObject({
      message: 'the exact submitted message',
      skillSlugs: ['review'],
      options: { provider: 'provider-a', model: 'model-a' },
    })
    expect(attempt.attachments).toEqual([expect.objectContaining({ name: 'notes.txt' })])
  })
})

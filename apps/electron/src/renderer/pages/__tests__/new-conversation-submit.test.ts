import { beforeAll, describe, expect, it, mock } from 'bun:test'
import type { Session } from '../../../shared/types'
import type { CreateAndSendFirstTurnResult } from '@mortise/shared/protocol'

let runFirstTurnDraftSubmission: typeof import('../NewConversationPage')['runFirstTurnDraftSubmission']

beforeAll(async () => {
  Object.assign(globalThis, {
    DOMMatrix: class DOMMatrix {},
    ImageData: class ImageData {},
    Path2D: class Path2D {},
  })
  mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
  mock.module('@/components/app-shell/input/InputContainer', () => ({ InputContainer: () => null }))
  ;({ runFirstTurnDraftSubmission } = await import('../NewConversationPage'))
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
})

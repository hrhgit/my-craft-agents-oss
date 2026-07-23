import type { SessionDraft } from '@mortise/shared/config'

export type PersistDraft = (draftId: string, draft: SessionDraft) => Promise<void>

/**
 * Serializes the shared draft-record writes without making composer input wait
 * for disk I/O. A later clear is therefore ordered after an earlier text write.
 */
export class DraftWriteQueue {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly persist: PersistDraft) {}

  write(draftId: string, draft: SessionDraft): Promise<void> {
    const snapshot = cloneDraft(draft)
    const operation = this.tail
      .catch(() => undefined)
      .then(() => this.persist(draftId, snapshot))

    // Keep the queue live after an individual persistence failure while still
    // returning that failure to the caller that initiated the write.
    this.tail = operation.catch(() => undefined)
    return operation
  }

  flush(): Promise<void> {
    return this.tail
  }
}

function cloneDraft(draft: SessionDraft): SessionDraft {
  return {
    text: draft.text,
    ...(draft.attachments?.length
      ? {
          attachments: draft.attachments.map(attachment => ({
            path: attachment.path,
            name: attachment.name,
            ...(attachment.content ? { content: { ...attachment.content } } : {}),
          })),
        }
      : {}),
  }
}

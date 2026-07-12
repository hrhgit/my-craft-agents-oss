import { describe, expect, it } from 'bun:test'
import type { PiProjectionEntityV1 } from '@craft-agent/shared/protocol'
import type { Message, StoredAttachment } from '../../../shared/types'
import { buildPiTurnOverlay, buildPiTurns } from '../../components/app-shell/pi-turn-model'
import {
  removePiUserOverlayCarrier,
  settlePiUserOverlayCarrier,
  upsertPiUserOverlayCarrier,
} from '../pi-message-overlay'

const storedAttachment: StoredAttachment = {
  id: 'attachment-1',
  type: 'image',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 42,
  storedPath: 'C:/workspace/photo.png',
  thumbnailBase64: 'preview',
}

const carrier: Message = {
  id: 'mutation-1',
  role: 'user',
  content: 'must not become transcript content',
  timestamp: 1234,
  attachments: [storedAttachment],
  badges: [{
    type: 'command',
    label: 'Compact',
    rawText: '/compact',
    start: 0,
    end: 8,
  }],
  isPending: true,
  isQueued: false,
}

function projectedUserEntities(): PiProjectionEntityV1[] {
  return [{
    entityId: 'content:user:mutation-1',
    entityType: 'content_block',
    entityVersion: 1,
    createdSeq: 1,
    kind: 'user_text',
    payload: {
      role: 'user',
      messageId: 'mutation-1',
      clientMutationId: 'mutation-1',
      text: 'Pi owns this text',
      streaming: false,
    },
    lastEventId: 'event-1',
    lastSeq: 1,
  }, {
    entityId: 'artifact:attachment:mutation-1:attachment-1',
    entityType: 'artifact_ref',
    entityVersion: 1,
    createdSeq: 2,
    kind: 'user_attachment',
    payload: {
      ownerMessageId: 'mutation-1',
      attachment: { id: 'attachment-1', name: 'photo.png', mediaType: 'image/png', size: 42 },
      order: 0,
    },
    lastEventId: 'event-2',
    lastSeq: 2,
  }]
}

describe('Pi user overlay carrier', () => {
  it('provides complete attachment metadata and badges to the projected user bubble', () => {
    const messages = upsertPiUserOverlayCarrier([], carrier)
    expect(messages[0]?.content).toBe('')

    const turns = buildPiTurns(projectedUserEntities(), buildPiTurnOverlay(messages))
    expect(turns[0]).toMatchObject({
      type: 'user',
      message: {
        content: 'Pi owns this text',
        attachments: [storedAttachment],
        badges: carrier.badges,
      },
    })

    const reloadedMessages = structuredClone(settlePiUserOverlayCarrier(messages, carrier.id))
    const reloadedTurns = buildPiTurns(projectedUserEntities(), buildPiTurnOverlay(reloadedMessages))
    expect(reloadedTurns[0]).toMatchObject({
      type: 'user',
      message: {
        content: 'Pi owns this text',
        isPending: false,
        attachments: [storedAttachment],
        badges: carrier.badges,
      },
    })
  })

  it('upserts by projection message identity and preserves an existing annotation overlay', () => {
    const annotated = {
      ...carrier,
      content: '',
      attachments: undefined,
      badges: undefined,
      annotations: [{
        schemaVersion: 1 as const,
        id: 'annotation-1',
        createdAt: 1,
        updatedAt: 1,
        intent: 'comment' as const,
        body: [{ type: 'note' as const, text: 'note' }],
        target: {
          source: { sessionId: 'session-1', messageId: carrier.id },
          selectors: [],
        },
      }],
    }
    const messages = upsertPiUserOverlayCarrier([annotated], carrier)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: carrier.id,
      content: '',
      attachments: [storedAttachment],
      badges: carrier.badges,
      annotations: annotated.annotations,
    })
  })

  it('settles accepted carriers and removes rejected carriers without touching neighbors', () => {
    const neighbor: Message = { id: 'neighbor', role: 'assistant', content: '', timestamp: 1 }
    const pending = upsertPiUserOverlayCarrier([neighbor], carrier)
    const settled = settlePiUserOverlayCarrier(pending, carrier.id)
    expect(settled.find(message => message.id === carrier.id)?.isPending).toBe(false)

    const rolledBack = removePiUserOverlayCarrier(pending, carrier.id)
    expect(rolledBack).toEqual([neighbor])
  })
})

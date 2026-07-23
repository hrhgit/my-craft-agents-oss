import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session } from '@mortise/shared/protocol'
import type { ISessionManager } from '@mortise/server-core/handlers'
import { BindingStore } from '../binding-store'
import { Commands } from '../commands'
import type { IncomingMessage, PlatformAdapter, SentMessage } from '../types'

function makeSession(id: string, name: string, lastMessageAt: number): Session {
  return {
    id,
    name,
    workspaceId: 'ws1',
    workspaceName: 'Workspace',
    messages: [],
    createdAt: lastMessageAt - 1000,
    updatedAt: lastMessageAt,
    lastMessageAt,
  } as unknown as Session
}

function makeSessionManager(sessions: Session[]): ISessionManager {
  return {
    getSessions: () => sessions,
    getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
    createSession: async () => { throw new Error('not implemented') },
    sendMessage: async () => {},
    cancelProcessing: async () => {},
    respondToPermission: () => true,
  } as unknown as ISessionManager
}

function makeAdapter(platform: 'telegram' | 'whatsapp', inlineButtons: boolean): PlatformAdapter & { sent: string[] } {
  const sent: string[] = []
  return {
    platform,
    capabilities: {
      messageEditing: inlineButtons,
      inlineButtons,
      maxButtons: 10,
      maxMessageLength: 4096,
      markdown: platform === 'telegram' ? 'v2' : 'whatsapp',
      webhookSupport: false,
    },
    sent,
    async initialize() {},
    async destroy() {},
    isConnected() { return true },
    onMessage() {},
    onButtonPress() {},
    async sendText(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async editMessage() {},
    async sendButtons(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async sendTyping() {},
    async sendFile(): Promise<SentMessage> {
      return { platform, channelId: 'chan-1', messageId: String(sent.length + 1) }
    },
  }
}

function makeMessage(text: string): IncomingMessage {
  return {
    platform: 'whatsapp',
    channelId: 'chan-1',
    messageId: 'm1',
    senderId: 'u1',
    senderName: 'Alice',
    text,
    timestamp: Date.now(),
    raw: {},
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStore(): BindingStore {
  const dir = mkdtempSync(join(tmpdir(), 'commands-bind-'))
  tempDirs.push(dir)
  return new BindingStore(dir)
}

describe('Commands', () => {
  it('keeps /new ephemeral and publishes/binds on the first message', async () => {
    const store = makeStore()
    const published = makeSession('new-session', 'Draft name', Date.now())
    let createSessionCalls = 0
    let firstTurnCalls = 0
    const manager = {
      ...makeSessionManager([]),
      createSession: async () => {
        createSessionCalls++
        throw new Error('ordinary empty Session creation is forbidden')
      },
      createAndSendFirstTurn: async (input: { beforePublish?: (session: Session) => Promise<void> | void }) => {
        firstTurnCalls++
        await input.beforePublish?.(published)
        return { session: published, messageId: 'first-message' }
      },
    } as unknown as ISessionManager
    const commands = new Commands(manager, store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/new Draft name'))
    expect(createSessionCalls).toBe(0)
    expect(firstTurnCalls).toBe(0)
    expect(store.findByChannel('whatsapp', 'chan-1')).toBeUndefined()

    await commands.handle(adapter, makeMessage('start the task'))
    expect(firstTurnCalls).toBe(1)
    expect(store.findByChannel('whatsapp', 'chan-1')?.sessionId).toBe('new-session')
  })

  it('retains the draft and leaves no binding when first-turn publication fails', async () => {
    const store = makeStore()
    let attempts = 0
    const manager = {
      ...makeSessionManager([]),
      createAndSendFirstTurn: async () => {
        attempts++
        throw new Error('first-turn persistence failed')
      },
    } as unknown as ISessionManager
    const commands = new Commands(manager, store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/new Retryable'))
    await commands.handle(adapter, makeMessage('try once'))
    await commands.handle(adapter, makeMessage('try again'))

    expect(attempts).toBe(2)
    expect(store.findByChannel('whatsapp', 'chan-1')).toBeUndefined()
    expect(adapter.sent.filter(text => text.includes('first-turn persistence failed'))).toHaveLength(2)
  })

  it('binds by numbered recent-session index on non-inline platforms', async () => {
    const sessions = [
      makeSession('sess-1', 'Old', 100),
      makeSession('sess-2', 'Newest', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind 1'))

    expect(store.findByChannel('whatsapp', 'chan-1')?.sessionId).toBe('sess-2')
    expect(adapter.sent.at(-1)).toContain('Newest')
  })

  it('lists numbered recent sessions with usable /bind instructions on WhatsApp', async () => {
    const sessions = [
      makeSession('sess-1', 'Alpha', 100),
      makeSession('sess-2', 'Beta', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind'))

    expect(adapter.sent[0]).toContain('1. Beta (sess-2)')
    expect(adapter.sent[0]).toContain('/bind <number>')
  })
})

/**
 * Session types for conversation management
 *
 * Sessions are the primary isolation boundary. Each session maps 1:1
 * with a CraftAgent instance and SDK conversation.
 */

import type { StoredMessage, TokenUsage } from './message.ts';

/**
 * Session represents a conversation scope (SDK session = our scope boundary)
 */
export interface Session {
  id: string;                    // Unique identifier (stable, known immediately)
  /** Missing identifies a pre-Pi-projection Craft transcript. */
  conversationFormat?: 'pi-projection-v1';
  sdkSessionId?: string;         // SDK session ID (captured after first message)
  workspaceId: string;           // Which workspace this session belongs to
  name?: string;                 // Optional user-defined name
  createdAt: number;
  lastUsedAt: number;
  // Inbox/Archive features
  isArchived?: boolean;          // Whether this session is archived
  isFlagged?: boolean;           // Whether this session is flagged
  status?: string;               // Workflow status (dynamic ID validated at runtime via shared/protocol)
  // Read/unread tracking
  lastReadMessageId?: string;    // ID of the last message the user has read
}

/**
 * Stored session with conversation data (for persistence)
 */
export interface StoredSession extends Session {
  messages: StoredMessage[];
  tokenUsage: TokenUsage;
}

/**
 * Session metadata for listing (without loading full messages)
 * Extended with archive status for Inbox/Archive features
 *
 * NOTE: 此接口为 IPC 契约层（ElectronAPI）的运行时 DTO，使用 `id` 字段。
 * 持久化层使用 `@craft-agent/shared/sessions` 的 `SessionHeader` 接口，其对应字段
 * 名为 `craftId`。二者在运行时通过 managedToSession 等 mapper 显式映射
 * (ManagedSession.id → SessionHeader.craftId ↔ SessionMetadata.id)。
 * 添加新字段时，需同时考虑此接口与 SessionHeader 的同步。
 */
export interface SessionMetadata {
  id: string;
  /** Missing identifies a pre-Pi-projection Craft transcript. */
  conversationFormat?: 'pi-projection-v1';
  workspaceId: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  preview?: string;        // Preview of first user message
  sdkSessionId?: string;
  // Inbox/Archive features
  isArchived?: boolean;    // Whether this session is archived
  isFlagged?: boolean;     // Whether this session is flagged
  status?: string;        // Workflow status (dynamic ID validated at runtime via shared/protocol)
  hidden?: boolean;        // Whether this session is hidden from session list
}

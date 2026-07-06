/**
 * Session Types
 *
 * Unified type definitions for workspace-scoped sessions.
 * Sessions are stored at ~/.pi/agent/sessions/{encoded-cwd}/{timestamp}_{sessionId}.jsonl
 *
 * Pi Tree JSONL v3 Format (primary):
 * - On-disk 第一行结构: Pi 顶层字段 + `craft` 子对象（Craft 扩展字段）
 * - 内部类型拆分为 PiSessionHeader / CraftSessionMetadata / SessionComputedMetadata
 * - renderer/RPC 兼容 DTO 仍可使用扁平 SessionHeader
 * - 序列化层（tree-jsonl.ts）负责扁平 DTO ↔ 嵌套 tree header 转换
 * Legacy JSONL ({workspaceRootPath}/sessions/{id}/session.jsonl) 仍支持读取：
 * - legacy 文件无 Pi 字段，读取时 piSessionId/piTimestamp/piCwd 等为 undefined
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { StoredMessage } from '@craft-agent/core/types';

/**
 * Craft session metadata fields that persist to disk (写入 Pi 文件 craft 子对象).
 * Add new Craft metadata fields here - they automatically propagate to JSONL
 * read/write via pickCraftSessionMetadata().
 *
 * IMPORTANT: When adding a new field:
 * 1. Add it to this array
 * 2. Add it to CraftSessionMetadata below
 * 3. Done - serialization is automatic
 */
export const CRAFT_SESSION_METADATA_FIELDS = [
  // Identity
  'craftId', 'workspaceRootPath', 'sdkSessionId', 'sdkCwd',
  // Timestamps
  'createdAt', 'lastUsedAt', 'lastMessageAt',
  // Display
  'name', 'isFlagged', 'sessionStatus', 'labels', 'hidden',
  // Read tracking
  'lastReadMessageId', 'hasUnread',
  // Config
  'enabledSourceSlugs', 'permissionMode', 'previousPermissionMode', 'workingDirectory',
  // Model/Connection
  'model', 'llmConnection', 'connectionLocked', 'thinkingLevel',
  // Sharing
  'sharedUrl', 'sharedId',
  // Plan execution
  'pendingPlanExecution',
  // Archive
  'isArchived', 'archivedAt',
  // Branching
  'branchFromMessageId',
  'branchFromSdkSessionId',
  'branchFromSessionPath',
  'branchFromPiSessionFile',
  'branchFromSdkCwd',
  'branchFromSdkTurnId',
  // Remote transfer handoff
  'transferredSessionSummary',
  'transferredSessionSummaryApplied',
  // Automation origin
  'triggeredBy',
] as const;

export type CraftSessionMetadataField = typeof CRAFT_SESSION_METADATA_FIELDS[number];

/**
 * Compatibility alias for older call sites/tests. This now means "Craft
 * persistent metadata fields", not Pi header fields or computed cache fields.
 */
export const SESSION_PERSISTENT_FIELDS = CRAFT_SESSION_METADATA_FIELDS;
export type SessionPersistentField = CraftSessionMetadataField;

/**
 * Computed/list metadata cached in the craft sub-object for fast session lists.
 * These are derived from messages/runtime state, so they are intentionally not
 * part of CRAFT_SESSION_METADATA_FIELDS.
 */
export const SESSION_COMPUTED_METADATA_FIELDS = [
  'messageCount',
  'lastMessageRole',
  'preview',
  'tokenUsage',
  'lastFinalMessageId',
] as const;

export type SessionComputedMetadataField = typeof SESSION_COMPUTED_METADATA_FIELDS[number];

/**
 * Session status (user-controlled, never automatic)
 *
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string;

/**
 * Built-in status IDs (for TypeScript consumers)
 * These are the default statuses but users can add/remove custom ones
 */
export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled';

/**
 * Session token usage tracking
 */
export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
}

/**
 * Stored message format (simplified for persistence)
 * Re-exported from @craft-agent/core for convenience
 */
export type { StoredMessage } from '@craft-agent/core/types';

/**
 * Pi tree top-level header fields.
 *
 * These fields are owned by Pi runtime and are only mirrored into Craft DTOs
 * for lookup/list rendering. Legacy Craft JSONL files do not have them.
 */
export interface PiSessionHeader {
  /** Pi entry type，固定为 'session' */
  type?: 'session';
  /** Pi schema 版本（当前为 3） */
  version?: number;
  /**
   * Pi session UUID — Pi runtime 主键，文件名一部分。
   * 与 craftId 区分：piSessionId 是 Pi runtime 内部 ID，craftId 是 Craft 人类可读 ID。
   * legacy 文件无此字段。
   */
  piSessionId?: string;
  /** Pi session 创建时间（ISO 8601，由 Pi runtime 写入） */
  piTimestamp?: string;
  /** Pi session 工作目录（Pi runtime 主工作目录） */
  piCwd?: string;
  /** Pi session 父级 ID（Pi branching 用） */
  parentSession?: string;
}

/**
 * Craft-owned persistent metadata, serialized under the tree header's `craft`
 * sub-object. On disk, `craftId` is mapped to `craft.id`.
 */
export interface CraftSessionMetadata {
  /**
   * Craft session ID — 人类可读格式（YYMMDD-adjective-noun），文件名一部分。
   * 在 Pi 文件中序列化为 `craft.id`。
   */
  craftId: string;
  /** SDK session ID（Claude SDK 等底层 SDK 的 session 标识，捕获于首条消息后） */
  sdkSessionId?: string;
  /** Craft workspace 根路径 */
  workspaceRootPath: string;

  // ============================================
  // Craft 时间戳
  // ============================================

  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 最后访问时间（epoch ms，任何访问都更新） */
  lastUsedAt: number;
  /** 最后有意义消息时间（epoch ms，用于日期分组，区别于 lastUsedAt） */
  lastMessageAt?: number;

  // ============================================
  // Craft 显示
  // ============================================

  /** 用户自定义名称 */
  name?: string;
  /** 是否标记 */
  isFlagged?: boolean;
  /** 用户控制的 session 状态（决定 inbox vs completed） */
  sessionStatus?: SessionStatus;
  /** 标签（bare IDs 或 "id::value" 条目） */
  labels?: string[];
  /** 是否从 session 列表隐藏（如 mini edit sessions） */
  hidden?: boolean;

  // ============================================
  // Craft 读取跟踪
  // ============================================

  /** 最后用户已读消息 ID */
  lastReadMessageId?: string;
  /**
   * 显式未读标记 — NEW badge 的单一来源。
   * 助手消息完成且用户未查看时设为 true；用户查看时设为 false。
   */
  hasUnread?: boolean;

  // ============================================
  // Craft 配置
  // ============================================

  /** Per-session source 选择（source slugs） */
  enabledSourceSlugs?: string[];
  /** 权限模式（'safe', 'ask', 'allow-all'） */
  permissionMode?: PermissionMode;
  /** 前一次权限模式（保留 modeTransition 上下文跨重启） */
  previousPermissionMode?: PermissionMode;
  /** 工作目录（agent 用于 bash 命令和上下文） */
  workingDirectory?: string;
  /** SDK cwd — 创建时设置一次，永不更改（确保 SDK 能找到 session transcripts） */
  sdkCwd?: string;

  // ============================================
  // Craft 模型/连接
  // ============================================

  /** 模型 ID（覆盖全局配置） */
  model?: string;
  /** LLM connection slug（首条消息后锁定） */
  llmConnection?: string;
  /** 连接是否锁定（首 agent 创建后不可更改） */
  connectionLocked?: boolean;
  /** 思考级别（'off', 'think', 'max'） */
  thinkingLevel?: ThinkingLevel;

  // ============================================
  // Craft 分享
  // ============================================

  /** 分享查看器 URL */
  sharedUrl?: string;
  /** 分享 session ID（用于撤销） */
  sharedId?: string;

  // ============================================
  // Craft Plan 执行
  // ============================================

  /**
   * 待执行 plan 状态 — 跟踪 "Accept & Compact" 流程。
   * 成功执行 / 新用户消息 / 手动清除时清空。
   */
  pendingPlanExecution?: {
    /** 要执行的 plan 文件路径 */
    planPath: string;
    /** accept 时捕获的 draft input 快照 */
    draftInputSnapshot?: string;
    /** 是否仍在等待 compaction 完成 */
    awaitingCompaction: boolean;
    /** 是否已从 UI 派发执行 */
    executionDispatched?: boolean;
  };

  // ============================================
  // Craft 归档
  // ============================================

  /** 是否归档 */
  isArchived?: boolean;
  /** 归档时间戳（用于保留策略） */
  archivedAt?: number;

  // ============================================
  // Craft 分支
  // ============================================

  /** 分支起点消息 ID（硬上下文截止标记） */
  branchFromMessageId?: string;
  /** 父 session 的 SDK session ID（仅支持 SDK 级 forking 的 provider） */
  branchFromSdkSessionId?: string;
  /** 父 session 的存储路径（仅 provider 级 forking 需要） */
  branchFromSessionPath?: string;
  /** 父 Pi session JSONL 文件（仅 Pi 共享原生 session 存储） */
  branchFromPiSessionFile?: string;
  /** 父 session 的 sdkCwd（forking 需要子进程使用父 CWD 定位父 session 文件） */
  branchFromSdkCwd?: string;
  /** 分支点的 provider-native anchor（Claude: assistant message UUID; Pi: session entry ID） */
  branchFromSdkTurnId?: string;

  // ============================================
  // Craft 远程传输
  // ============================================

  /** 远程传输后首条 turn 注入的一次性隐藏摘要 */
  transferredSessionSummary?: string;
  /** 传输的 session 摘要是否已注入 */
  transferredSessionSummaryApplied?: boolean;

  // ============================================
  // Craft 自动化
  // ============================================

  /** 自动化创建的 session 元数据 */
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number };
}

/**
 * Derived metadata used by session lists/runtime views.
 *
 * Some fields are cached in the tree header's `craft` sub-object to avoid
 * loading large message bodies for every list render. They are still computed
 * data, not user-editable Craft metadata.
 */
export interface SessionComputedMetadata {
  /** 消息数（列表展示用，免加载 messages） */
  messageCount?: number;
  /** 最后消息角色（列表展示用） */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  /** 首条用户消息预览（前 150 字符） */
  preview?: string;
  /** Token 用量统计 */
  tokenUsage?: SessionTokenUsage;
  /** 最后一条 final（非中间）助手消息 ID — 未读检测用 */
  lastFinalMessageId?: string;

  // ============================================
  // UI 元数据（仅列表场景使用，不持久化）
  // ============================================

  /** Plan 文件数 */
  planCount?: number;
}

/**
 * Flat compatibility DTO exposed to renderer/RPC and older shared/server call
 * sites. New storage/projection code should prefer the split interfaces above.
 */
export interface SessionHeader
  extends PiSessionHeader, CraftSessionMetadata, SessionComputedMetadata {}

/**
 * Stored session with conversation data
 */
export interface StoredSession extends SessionHeader {
  messages: StoredMessage[];
  tokenUsage: SessionTokenUsage;
}

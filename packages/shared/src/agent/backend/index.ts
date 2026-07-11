/**
 * Agent Backend Abstraction Layer
 *
 * This module provides a unified interface for AI agents.
 *
 * Naming convention:
 * - PiAgent: Pi unified API implementation
 * - AgentBackend: Interface that all agents implement
 * - createBackend: Factory function to create agents
 *
 * Usage:
 * ```typescript
 * import { createBackend, type AgentBackend } from '@craft-agent/shared/agent/backend';
 *
 * const agent = createBackend({
 *   provider: 'pi',
 *   workspace: myWorkspace,
 *   model: 'pi/claude-sonnet-4-6',
 * });
 *
 * for await (const event of agent.chat('Hello')) {
 *   console.log(event);
 * }
 * ```
 */

// Core types
export type {
  AgentBackend,
  ModelProvider,
  CoreBackendConfig,
  BackendConfig,
  BackendHostRuntimeContext,
  PermissionCallback,
  PlanCallback,
  AuthCallback,
  SourceChangeCallback,
  SourceActivationCallback,
  ChatOptions,
  RecoveryMessage,
  SdkMcpServerConfig,
  LlmAuthType,
  LlmProviderType,
  PostInitResult,
  ExtensionBridgeEvent,
  PiExtensionCommand,
} from './types.ts';

// Enums need to be exported as values, not just types
export { AbortReason } from './types.ts';

// Factory
export {
  createBackend,
  // LLM Connection support
  resolveSessionConnection,
  resolveBackendContext,
  resolveSetupTestConnectionHint,
  createBackendFromConnection,
  createBackendFromResolvedContext,
  initializeBackendHostRuntime,
  resolveBackendHostTooling,
  fetchBackendModels,
  validateStoredBackendConnection,
  AGENT_PROVIDER,
  // Utilities
  resolveModelForProvider,
  getDefaultAuthType,
  cleanupSourceRuntimeArtifacts,
  testBackendConnection,
} from './factory.ts';

// Shared infrastructure
export { BaseEventAdapter } from './base-event-adapter.ts';
export { EventQueue } from './event-queue.ts';

// Provider-specific event adapters
export { PiEventAdapter } from './pi/event-adapter.ts';

// Agent implementations are imported directly by factory.ts
// Consumers should use createBackend() instead of concrete classes

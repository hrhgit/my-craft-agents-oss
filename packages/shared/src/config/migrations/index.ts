/**
 * Migration functions extracted from storage.ts.
 *
 * Legacy provider/model migration logic lives here, keeping storage.ts focused
 * on runtime config IO. Migrations import runtime helpers (loadStoredConfig,
 * saveConfig, getWorkspaces, ensureDefaultLlmConnection) from ../storage.ts —
 * this is a safe circular dependency because all cross-module calls happen
 * inside function bodies, not at module evaluation time.
 *
 * Public API (re-exported via config/index.ts barrel):
 * - migrateLegacyLlmConnectionsConfig — main startup orchestrator
 * - migrateOrphanedDefaultConnections — fixes broken defaultLlmConnection refs
 * - shouldMigratePiOpenAiProvider — predicate
 * - shouldRepairPiApiKeyCodexProvider — predicate
 * - inferModelSelectionMode — predicate
 */
export { migrateLegacyLlmConnectionsConfig } from './migrate-llm-connections.ts';
export { migrateOrphanedDefaultConnections } from './migrate-orphaned-defaults.ts';
export {
  shouldMigratePiOpenAiProvider,
  shouldRepairPiApiKeyCodexProvider,
  inferModelSelectionMode,
} from './predicates.ts';

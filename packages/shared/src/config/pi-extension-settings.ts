/**
 * Pi 扩展设置（mortise GUI 专属字段）
 *
 * Task 7 瘦身后：本文件只保留 mortise GUI 专属的开关类字段。
 * 以下字段位于 Mortise Agent root 的 `settings.json.extensionConfig.<id>.*` 命名空间：
 * - `extensionConfig.<id>.enabled`（扩展启停）
 * - `extensionConfig.trace-audit.model` / `extensionConfig.trace-audit.concurrency`
 * - `extensionConfig.yourself.model`
 * - `extensionConfig.repo-memory.model`
 * - webSearch（pi 原生搜索配置）
 * - ambiguityDictionary（pi 原生歧义词典）
 *
 * 保留字段均为 mortise GUI 专属概念，pi settings.json 无对应项：
 * - `enabled`：控制 pi 扩展相关 UI 组件的可见性（不影响子进程扩展加载）
 * - `managedAgentDir`：测试覆盖用的 agentDir
 * - `traceAudit.showStatusBadge`：mortise GUI 状态展示
 * - `yourself.showStatusBadge` / `repoMemory.showStatusBadge`：mortise GUI 状态展示
 */

export type PiExtensionCategory =
  | 'ui'
  | 'automation'
  | 'agent'
  | 'shell'
  | 'diagnostics'
  | 'memory'
  | 'search'
  | 'other';

export type PiExtensionSettingScalar = string | number | boolean;
export const PI_MODEL_REFERENCE_CURRENT_SESSION = 'current-session' as const;
export type PiExtensionModelReference =
  | typeof PI_MODEL_REFERENCE_CURRENT_SESSION
  | `default:${number}`
  | `model:${string}/${string}`;
export function isPiExtensionModelReference(value: unknown): value is PiExtensionModelReference {
  return typeof value === 'string'
    && (value === 'current-session' || /^default:[1-9]\d*$/.test(value) || /^model:[^/]+\/.+$/.test(value));
}
export type PiExtensionSettingField = {
  key: string;
  label: string;
  description?: string;
  group?: string;
  requiresReload?: boolean;
  visibleWhen?: { key: string; equals: PiExtensionSettingScalar };
} & (
  | { type: 'boolean'; default: boolean }
  | { type: 'string' | 'textarea'; default?: string; minLength?: number; maxLength?: number }
  | { type: 'number'; default?: number; min?: number; max?: number; step?: number }
  | { type: 'select'; default?: string; options: Array<{ value: string; label: string; description?: string }> }
  | { type: 'model'; default?: string }
  | { type: 'model-reference'; default?: PiExtensionModelReference }
);
export interface PiExtensionSettingsSchema {
  schemaVersion: 1;
  groups?: Array<{ id: string; title: string; description?: string }>;
  fields: PiExtensionSettingField[];
}
export interface PiExtensionManifestUI {
  schemaVersion: 1;
  title?: string;
  description?: string;
  category?: PiExtensionCategory;
  settings?: PiExtensionSettingsSchema;
}
export interface PiExtensionManifestV1 {
  schemaVersion: 1;
  name: string;
  version: string;
  author: { name: string; url?: string };
  publisher?: string;
  description?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  conflicts?: Record<string, string>;
  capabilities?: string[];
  permissions?: string[];
  subagents?: Array<{
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    tools?: string[];
    model?: string;
  }>;
  loadOrder?: { priority?: number; after?: string[]; before?: string[] };
}
export type PiExtensionManifestStatus = 'compatible' | 'warning' | 'blocked' | 'legacy';
export interface PiExtensionManifestDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  relatedExtensionId?: string;
}
export interface PiExtensionConfigPatch {
  schemaVersion: 1;
  extensionId: string;
  set?: Record<string, PiExtensionSettingScalar>;
  unset?: string[];
}

export interface PiExtensionConfigPatchResult {
  config: Record<string, unknown>;
  requiresReload: boolean;
  takesEffect: 'immediate' | 'next-backend-load';
}

/**
 * Pi 返回给 host shell 的扩展展示 DTO。
 * 扩展发现、启停配置和元数据归 Pi；Mortise 只消费这个 catalog 渲染设置 UI。
 */
export interface PiExtensionCatalogEntry {
  id: string;
  loaded: boolean;
  title: string;
  description: string;
  category: PiExtensionCategory;
  configurable: boolean;
  manifest?: PiExtensionManifestV1;
  manifestStatus: PiExtensionManifestStatus;
  manifestDiagnostics: PiExtensionManifestDiagnostic[];
  loadable: boolean;
  ui?: PiExtensionManifestUI;
  enabled: boolean;
  path: string;
  resolvedPath: string;
  commands: string[];
  tools: string[];
  config?: Record<string, unknown>;
}

export interface PiExtensionCatalogError {
  path: string;
  error: string;
}

export interface PiExtensionCatalogResult {
  extensions: PiExtensionCatalogEntry[];
  errors: PiExtensionCatalogError[];
}

export interface PiExtensionSettingsWriteResult {
  status: 'saved_for_next_backend_load';
}

/**
 * Pi 扩展设置——仅 mortise GUI 专属字段。
 *
 * 扩展级 model/enabled/webSearch/ambiguityDictionary 已回归 pi settings.json，
 * 见文件顶部说明。
 */
export interface PiExtensionSettings {
  /** Mortise Agent 扩展 UI 可见性总开关。不影响子进程扩展加载。 */
  enabled: boolean;
  /** 测试覆盖用的 agentDir；生产路径永不传入。 */
  managedAgentDir?: string;
  traceAudit: {
    /** mortise GUI 状态徽章可见性。 */
    showStatusBadge: boolean;
  };
  yourself: {
    showStatusBadge: boolean;
  };
  repoMemory: {
    showStatusBadge: boolean;
  };
}

/**
 * 持久化层使用的宽松类型——所有字段可选，便于局部 patch。
 */
export type StoredPiExtensionSettings = {
  enabled?: boolean;
  managedAgentDir?: string;
  traceAudit?: Partial<PiExtensionSettings['traceAudit']>;
  yourself?: Partial<PiExtensionSettings['yourself']>;
  repoMemory?: Partial<PiExtensionSettings['repoMemory']>;
};

export const DEFAULT_PI_EXTENSION_SETTINGS: PiExtensionSettings = {
  enabled: true,
  traceAudit: {
    showStatusBadge: true,
  },
  yourself: {
    showStatusBadge: true,
  },
  repoMemory: {
    showStatusBadge: true,
  },
};

function cloneSettings(settings: PiExtensionSettings): PiExtensionSettings {
  return {
    ...settings,
    traceAudit: { ...settings.traceAudit },
    yourself: { ...settings.yourself },
    repoMemory: { ...settings.repoMemory },
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function createDefaultPiExtensionSettings(): PiExtensionSettings {
  return cloneSettings(DEFAULT_PI_EXTENSION_SETTINGS);
}

export function normalizePiExtensionSettings(
  raw?: StoredPiExtensionSettings | null,
  base: PiExtensionSettings = DEFAULT_PI_EXTENSION_SETTINGS,
): PiExtensionSettings {
  const defaults = cloneSettings(base);
  if (!raw || typeof raw !== 'object') {
    return defaults;
  }

  return {
    enabled: bool(raw.enabled, defaults.enabled),
    managedAgentDir: typeof raw.managedAgentDir === 'string' && raw.managedAgentDir.trim()
      ? raw.managedAgentDir.trim()
      : defaults.managedAgentDir,
    traceAudit: {
      showStatusBadge: bool(raw.traceAudit?.showStatusBadge, defaults.traceAudit.showStatusBadge),
    },
    yourself: {
      showStatusBadge: bool(raw.yourself?.showStatusBadge, defaults.yourself.showStatusBadge),
    },
    repoMemory: {
      showStatusBadge: bool(raw.repoMemory?.showStatusBadge, defaults.repoMemory.showStatusBadge),
    },
  };
}

export function mergePiExtensionSettings(
  current: PiExtensionSettings,
  patch: StoredPiExtensionSettings,
): PiExtensionSettings {
  const merged: StoredPiExtensionSettings = {
    ...current,
    ...patch,
    traceAudit: { ...current.traceAudit, ...(patch.traceAudit ?? {}) },
    yourself: { ...current.yourself, ...(patch.yourself ?? {}) },
    repoMemory: { ...current.repoMemory, ...(patch.repoMemory ?? {}) },
  };
  return normalizePiExtensionSettings(merged, current);
}

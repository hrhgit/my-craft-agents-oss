/**
 * Pi 扩展设置（craft GUI 专属字段）
 *
 * Task 7 瘦身后：本文件只保留 craft GUI 专属的开关类字段。
 * 以下字段已回归到 `~/.pi/agent/settings.json` 的 `extensions.<name>.*` 命名空间：
 * - `extensions.<name>.enabled`（扩展启停）
 * - `extensions.subagent.defaultModel`
 * - `extensions.trace-audit.model` / `extensions.trace-audit.concurrency`
 * - `extensions.yourself.model`
 * - `extensions.repo-memory.model`
 * - webSearch（pi 原生搜索配置）
 * - ambiguityDictionary（pi 原生歧义词典）
 *
 * 保留字段均为 craft GUI 专属概念，pi settings.json 无对应项：
 * - `enabled`：控制 pi 扩展相关 UI 组件的可见性（不影响子进程扩展加载）
 * - `delegatePromptAutomation`：automation 委托开关
 * - `managedAgentDir`：测试覆盖用的 agentDir
 * - `subagent.reviewEnabled` / `subagent.reviewModel`：craft 专属 review 流
 * - `traceAudit.reviewSubagentEnabled` / `traceAudit.showStatusBadge`：craft GUI 状态展示
 * - `yourself.showStatusBadge` / `repoMemory.showStatusBadge`：craft GUI 状态展示
 * - `promptAutomation.*` / `planMode.*`：craft GUI 控件可见性
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

/**
 * Pi 返回给 host shell 的扩展展示 DTO。
 * 扩展发现、启停配置和元数据归 Pi；Craft 只消费这个 catalog 渲染设置 UI。
 */
export interface PiExtensionCatalogEntry {
  id: string;
  title: string;
  description: string;
  category: PiExtensionCategory;
  configurable: boolean;
  enabled: boolean;
  path: string;
  resolvedPath: string;
  commands: string[];
  tools: string[];
  flags: string[];
  shortcuts: string[];
  config?: Record<string, unknown>;
}

/**
 * Pi 扩展设置——仅 craft GUI 专属字段。
 *
 * 扩展级 model/enabled/webSearch/ambiguityDictionary 已回归 pi settings.json，
 * 见文件顶部说明。
 */
export interface PiExtensionSettings {
  /** 全局 pi 扩展 UI 可见性总开关。不影响子进程扩展加载（子进程始终加载全局 pi 扩展）。 */
  enabled: boolean;
  /** 是否将 automation 的 prompt 触发执行委托给 pi prompt-automation 扩展。 */
  delegatePromptAutomation: boolean;
  /** 测试覆盖用的 agentDir；生产路径永不传入。 */
  managedAgentDir?: string;
  subagent: {
    /** craft 专属 review 流程开关（非 pi subagent 默认模型）。 */
    reviewEnabled: boolean;
    reviewModel: string;
  };
  traceAudit: {
    /** craft 专属：是否对 trace-audit 启用 review subagent。 */
    reviewSubagentEnabled: boolean;
    /** craft GUI 状态徽章可见性。 */
    showStatusBadge: boolean;
  };
  yourself: {
    showStatusBadge: boolean;
  };
  repoMemory: {
    showStatusBadge: boolean;
  };
  promptAutomation: {
    widgetVisible: boolean;
    defaultJobScope: 'session' | 'workdir';
  };
  planMode: {
    showDiscussionButton: boolean;
    showPlanButton: boolean;
    renderPlanMarkdown: boolean;
  };
}

/**
 * 持久化层使用的宽松类型——所有字段可选，便于局部 patch。
 */
export type StoredPiExtensionSettings = {
  enabled?: boolean;
  delegatePromptAutomation?: boolean;
  managedAgentDir?: string;
  subagent?: Partial<PiExtensionSettings['subagent']>;
  traceAudit?: Partial<PiExtensionSettings['traceAudit']>;
  yourself?: Partial<PiExtensionSettings['yourself']>;
  repoMemory?: Partial<PiExtensionSettings['repoMemory']>;
  promptAutomation?: Partial<PiExtensionSettings['promptAutomation']>;
  planMode?: Partial<PiExtensionSettings['planMode']>;
};

export const DEFAULT_PI_EXTENSION_SETTINGS: PiExtensionSettings = {
  enabled: true,
  delegatePromptAutomation: false,
  subagent: {
    reviewEnabled: true,
    reviewModel: 'stepfun/step-3.7-flash',
  },
  traceAudit: {
    reviewSubagentEnabled: true,
    showStatusBadge: true,
  },
  yourself: {
    showStatusBadge: true,
  },
  repoMemory: {
    showStatusBadge: true,
  },
  promptAutomation: {
    widgetVisible: true,
    defaultJobScope: 'session',
  },
  planMode: {
    showDiscussionButton: true,
    showPlanButton: true,
    renderPlanMarkdown: true,
  },
};

function cloneSettings(settings: PiExtensionSettings): PiExtensionSettings {
  return {
    ...settings,
    subagent: { ...settings.subagent },
    traceAudit: { ...settings.traceAudit },
    yourself: { ...settings.yourself },
    repoMemory: { ...settings.repoMemory },
    promptAutomation: { ...settings.promptAutomation },
    planMode: { ...settings.planMode },
  };
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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

  const promptAutomationScope = raw.promptAutomation?.defaultJobScope;

  return {
    enabled: bool(raw.enabled, defaults.enabled),
    delegatePromptAutomation: bool(raw.delegatePromptAutomation, defaults.delegatePromptAutomation),
    managedAgentDir: typeof raw.managedAgentDir === 'string' && raw.managedAgentDir.trim()
      ? raw.managedAgentDir.trim()
      : defaults.managedAgentDir,
    subagent: {
      reviewEnabled: bool(raw.subagent?.reviewEnabled, defaults.subagent.reviewEnabled),
      reviewModel: nonEmptyString(raw.subagent?.reviewModel, defaults.subagent.reviewModel),
    },
    traceAudit: {
      reviewSubagentEnabled: bool(raw.traceAudit?.reviewSubagentEnabled, defaults.traceAudit.reviewSubagentEnabled),
      showStatusBadge: bool(raw.traceAudit?.showStatusBadge, defaults.traceAudit.showStatusBadge),
    },
    yourself: {
      showStatusBadge: bool(raw.yourself?.showStatusBadge, defaults.yourself.showStatusBadge),
    },
    repoMemory: {
      showStatusBadge: bool(raw.repoMemory?.showStatusBadge, defaults.repoMemory.showStatusBadge),
    },
    promptAutomation: {
      widgetVisible: bool(raw.promptAutomation?.widgetVisible, defaults.promptAutomation.widgetVisible),
      defaultJobScope: promptAutomationScope === 'workdir' || promptAutomationScope === 'session'
        ? promptAutomationScope
        : defaults.promptAutomation.defaultJobScope,
    },
    planMode: {
      showDiscussionButton: bool(raw.planMode?.showDiscussionButton, defaults.planMode.showDiscussionButton),
      showPlanButton: bool(raw.planMode?.showPlanButton, defaults.planMode.showPlanButton),
      renderPlanMarkdown: bool(raw.planMode?.renderPlanMarkdown, defaults.planMode.renderPlanMarkdown),
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
    subagent: { ...current.subagent, ...(patch.subagent ?? {}) },
    traceAudit: { ...current.traceAudit, ...(patch.traceAudit ?? {}) },
    yourself: { ...current.yourself, ...(patch.yourself ?? {}) },
    repoMemory: { ...current.repoMemory, ...(patch.repoMemory ?? {}) },
    promptAutomation: { ...current.promptAutomation, ...(patch.promptAutomation ?? {}) },
    planMode: { ...current.planMode, ...(patch.planMode ?? {}) },
  };
  return normalizePiExtensionSettings(merged, current);
}

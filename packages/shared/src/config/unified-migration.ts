/**
 * Unified One-Shot Migration (spec: unify-pi-craft-one-body)
 *
 * 强制升级策略：检测到旧格式文件则批量改写为新规范，改写后删除旧文件。
 * - 改写前整体备份到 ~/.craft-agent/.pre-upgrade-backup-{timestamp}/
 * - 任一子迁移失败则中止并从备份回滚已改写的
 * - 成功后写入标记文件，后续启动跳过
 *
 * 子迁移顺序：
 *   1. config.json 旧字段 → pi settings.json (shellGui.* 命名空间)
 *   2. credentials.enc 删除（用户重新认证，跳过凭证迁移）
 *   3. 旧会话 session.jsonl → pi 树形 JSONL v3 + sidecar 迁移
 *   4. skills 从旧路径 → ~/.pi/agent/skills/ + {projectRoot}/.pi/skills/
 *
 * 设计决策：
 * - 同步执行（避免与 pi 子进程并发写 settings.json/auth.json）
 * - 标记文件检测：首次启动执行一次，后续启动直接跳过
 * - 失败回滚：从备份目录整体恢复（简单可靠，避免 journal 复杂性）
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  readdirSync,
  copyFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { CONFIG_DIR, PI_SKILLS_DIR, PI_SESSIONS_DIR, PI_SETTINGS_FILE, PI_MODELS_FILE, encodePiSessionCwd } from './paths.ts';
import { debug } from '../utils/debug.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import {
  writePiShellGuiBoolean,
  writePiShellGuiSetting,
  setPiGlobalDefaultThinkingLevel,
  writePiCraftAgentSettingsBulk,
} from './pi-global-config.ts';
import {
  discoverWorkspacesInDefaultLocation,
  getWorkspaceCwd,
  loadWorkspaceConfig,
  getWorkspaceSkillsPath,
} from '../workspaces/storage.ts';
import type { StoredSession } from '../sessions/types.ts';
import { readSessionJsonl } from '../sessions/jsonl.ts';
import { createNewTreeSessionFile, readTreeSessionHeader } from '../sessions/tree-jsonl.ts';
import { buildPiSessionFileName, getSharedPiSidecarPathForFile } from '../sessions/storage.ts';

// ============================================================
// Constants
// ============================================================

const MIGRATION_MARKER_FILE = join(CONFIG_DIR, '.unified-migration-completed');
const MIGRATION_LOCK_FILE = join(CONFIG_DIR, '.unified-migration.lock');
const LEGACY_CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.enc');
const LEGACY_GLOBAL_SKILLS_DIR = join(homedir(), '.agents', 'skills');
const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');
const MIGRATION_LOCK_STALE_MS = 120_000;
const MIGRATION_LOCK_RETRY_DELAY_MS = 100;
const MIGRATION_LOCK_RETRY_COUNT = 600;

// Sidecar 子目录名（旧 sidecar 与新 sidecar 共用同一套子目录名）
const SIDECAR_SUBDIRS = ['attachments', 'plans', 'data', 'long_responses', 'downloads'];

// ============================================================
// Public API
// ============================================================

export interface MigrationResult {
  skipped: boolean;
  backupDir?: string;
  migratedConfigFields: number;
  deletedCredentialsEnc: boolean;
  migratedSessions: number;
  migratedSkills: number;
}

interface MigrationCreatedPaths {
  files: string[];
  dirs: string[];
}

/**
 * 检测是否需要迁移。
 * 标记文件存在则跳过。
 */
export function isUnifiedMigrationNeeded(): boolean {
  return !existsSync(MIGRATION_MARKER_FILE);
}

function skippedMigrationResult(): MigrationResult {
  return {
    skipped: true,
    migratedConfigFields: 0,
    deletedCredentialsEnc: false,
    migratedSessions: 0,
    migratedSkills: 0,
  };
}

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function tryAcquireUnifiedMigrationLock(): (() => void) | null {
  try {
    const fd = openSync(MIGRATION_LOCK_FILE, 'wx');
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    return () => {
      try { closeSync(fd); } catch {}
      try { unlinkSync(MIGRATION_LOCK_FILE); } catch {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    try {
      const lockStat = statSync(MIGRATION_LOCK_FILE);
      if (lockStat.mtimeMs < Date.now() - MIGRATION_LOCK_STALE_MS) {
        unlinkSync(MIGRATION_LOCK_FILE);
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw statError;
      }
    }
    return null;
  }
}

function acquireUnifiedMigrationLock(): () => void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let lastError: unknown;
  for (let attempt = 1; attempt <= MIGRATION_LOCK_RETRY_COUNT; attempt++) {
    const release = tryAcquireUnifiedMigrationLock();
    if (release) return release;
    lastError = new Error(`Unified migration lock is held: ${MIGRATION_LOCK_FILE}`);
    if (attempt < MIGRATION_LOCK_RETRY_COUNT) {
      sleepSync(MIGRATION_LOCK_RETRY_DELAY_MS);
    }
  }
  throw (lastError as Error) ?? new Error(`Failed to acquire unified migration lock: ${MIGRATION_LOCK_FILE}`);
}

/**
 * 执行统一迁移（如果需要）。
 *
 * 在 SessionManager.initialize() 早期调用，先于其他 migrateLegacy* 函数。
 * 任一子迁移失败则回滚并抛出异常，阻止启动。
 */
export async function runUnifiedMigrationIfNeeded(): Promise<MigrationResult> {
  if (!isUnifiedMigrationNeeded()) {
    return skippedMigrationResult();
  }

  const releaseMigrationLock = acquireUnifiedMigrationLock();
  try {
    if (!isUnifiedMigrationNeeded()) {
      return skippedMigrationResult();
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(CONFIG_DIR, `.pre-upgrade-backup-${timestamp}`);

    debug(`[unified-migration] Starting one-shot migration. Backup: ${backupDir}`);

    // 1. 整体备份
    createBackup(backupDir);

    // 记录 pi settings.json/models.json 迁移前是否存在，用于回滚时识别"迁移中新建"的文件
    const piSettingsExistedBefore = existsSync(PI_SETTINGS_FILE);
    const piModelsExistedBefore = existsSync(PI_MODELS_FILE);

    // 2. 执行子迁移（任一失败则回滚）
    let result: MigrationResult;
    const createdPaths: MigrationCreatedPaths = { files: [], dirs: [] };
    try {
      const configFields = await migrateConfigFields();
      const deletedCreds = deleteLegacyCredentials();
      const sessions = migrateLegacySessions(createdPaths);
      const skills = migrateLegacySkills(createdPaths);

      result = {
        skipped: false,
        backupDir,
        migratedConfigFields: configFields,
        deletedCredentialsEnc: deletedCreds,
        migratedSessions: sessions,
        migratedSkills: skills,
      };
    } catch (error) {
      debug('[unified-migration] Migration failed, rolling back from backup:', error);
      rollbackFromBackup(backupDir, createdPaths, { piSettingsExistedBefore, piModelsExistedBefore });
      throw new Error(
        `Unified migration failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 3. 写入标记文件
    atomicWriteFileSync(
      MIGRATION_MARKER_FILE,
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          backupDir,
          ...result,
        },
        null,
        2,
      ),
    );

    debug('[unified-migration] Migration completed successfully:', result);
    return result;
  } finally {
    releaseMigrationLock();
  }
}

// ============================================================
// Backup & Rollback
// ============================================================

/**
 * 整体备份需要改写的旧文件。
 *
 * 备份内容：
 * - config.json → backup/config.json
 * - credentials.enc → backup/credentials.enc（如果存在）
 * - ~/.pi/agent/settings.json → backup/pi-settings.json（migrateConfigFields 会改写它）
 * - workspaces/{id}/sessions/ → backup/workspaces/{id}/sessions/（整个目录树）
 * - workspaces/{id}/skills/ → backup/workspaces/{id}/skills/（整个目录树）
 * - ~/.agents/skills/ → backup/agents-skills/（如果存在）
 *
 * 注意：pi 目录下的其他文件（sessions/skills 子目录）不备份——它们是新写入的目标，
 * 由 createdPaths 跟踪在回滚时单独清理。但 settings.json 是被 migrateConfigFields
 * 原地修改的（而非新建），必须备份以便回滚恢复。
 */
function createBackup(backupDir: string): void {
  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }
  mkdirSync(backupDir, { recursive: true });

  // config.json
  const configFile = join(CONFIG_DIR, 'config.json');
  if (existsSync(configFile)) {
    copyFileSync(configFile, join(backupDir, 'config.json'));
  }

  // credentials.enc
  if (existsSync(LEGACY_CREDENTIALS_FILE)) {
    copyFileSync(LEGACY_CREDENTIALS_FILE, join(backupDir, 'credentials.enc'));
  }

  // ~/.pi/agent/settings.json（migrateConfigFields 会通过 SettingsManager 原地改写）
  if (existsSync(PI_SETTINGS_FILE)) {
    copyFileSync(PI_SETTINGS_FILE, join(backupDir, 'pi-settings.json'));
  }

  // ~/.pi/agent/models.json（migrateConfigFields 可能通过 craft.agent.* 写入；
  // LLM 迁移也会写 craftConnections，但 LLM 迁移在统一迁移之后独立幂等执行）
  if (existsSync(PI_MODELS_FILE)) {
    copyFileSync(PI_MODELS_FILE, join(backupDir, 'pi-models.json'));
  }

  // workspaces/{id}/sessions/ 和 workspaces/{id}/skills/
  if (existsSync(DEFAULT_WORKSPACES_DIR)) {
    const backupWorkspacesDir = join(backupDir, 'workspaces');
    mkdirSync(backupWorkspacesDir, { recursive: true });

    for (const wsRootPath of discoverWorkspacesInDefaultLocation()) {
      const wsId = basename(wsRootPath);
      const backupWsDir = join(backupWorkspacesDir, wsId);
      mkdirSync(backupWsDir, { recursive: true });

      // sessions/
      const sessionsDir = join(wsRootPath, 'sessions');
      if (existsSync(sessionsDir)) {
        copyDirRecursive(sessionsDir, join(backupWsDir, 'sessions'));
      }

      // skills/
      const skillsDir = join(wsRootPath, 'skills');
      if (existsSync(skillsDir)) {
        copyDirRecursive(skillsDir, join(backupWsDir, 'skills'));
      }
    }
  }

  // ~/.agents/skills/
  if (existsSync(LEGACY_GLOBAL_SKILLS_DIR)) {
    copyDirRecursive(LEGACY_GLOBAL_SKILLS_DIR, join(backupDir, 'agents-skills'));
  }

  debug(`[unified-migration] Backup created at ${backupDir}`);
}

/**
 * 从备份回滚。
 *
 * 策略：
 * 1. 恢复 config.json 和 credentials.enc（从备份覆盖）
 * 2. 恢复 ~/.pi/agent/settings.json（从备份覆盖，撤销 migrateConfigFields 的改动）；
 *    若迁移前 settings.json 不存在（迁移中新建），则直接删除而非恢复
 * 3. 同理处理 ~/.pi/agent/models.json（migrateConfigFields 可能通过 craftConnections 写入）
 * 4. 恢复 workspaces/{id}/sessions/ 和 workspaces/{id}/skills/（从备份覆盖）
 * 5. 恢复 ~/.agents/skills/（从备份覆盖）
 * 6. 删除迁移过程中新建的 pi 目录下文件（sessions/skills）
 *
 * 注意：回滚不删除标记文件（标记文件只在成功时写入）。
 */
function rollbackFromBackup(
  backupDir: string,
  createdPaths?: MigrationCreatedPaths,
  preExistence?: { piSettingsExistedBefore: boolean; piModelsExistedBefore: boolean },
): void {
  try {
    // 恢复 config.json
    const backupConfig = join(backupDir, 'config.json');
    if (existsSync(backupConfig)) {
      copyFileSync(backupConfig, join(CONFIG_DIR, 'config.json'));
    }

    // 恢复 credentials.enc
    const backupCreds = join(backupDir, 'credentials.enc');
    if (existsSync(backupCreds)) {
      copyFileSync(backupCreds, LEGACY_CREDENTIALS_FILE);
    }

    // 恢复 ~/.pi/agent/settings.json
    const backupPiSettings = join(backupDir, 'pi-settings.json');
    if (existsSync(backupPiSettings)) {
      // 迁移前已存在 → 从备份恢复
      copyFileSync(backupPiSettings, PI_SETTINGS_FILE);
    } else if (preExistence && !preExistence.piSettingsExistedBefore && existsSync(PI_SETTINGS_FILE)) {
      // 迁移前不存在、迁移中新建 → 删除新建的文件
      rmSync(PI_SETTINGS_FILE, { force: true });
    }

    // 恢复 ~/.pi/agent/models.json（migrateConfigFields 不直接写，但 writePiCraftAgentSettingsBulk
    // 等若被未来变更调用可能写入；保守处理）
    const backupPiModels = join(backupDir, 'pi-models.json');
    if (existsSync(backupPiModels)) {
      copyFileSync(backupPiModels, PI_MODELS_FILE);
    } else if (preExistence && !preExistence.piModelsExistedBefore && existsSync(PI_MODELS_FILE)) {
      rmSync(PI_MODELS_FILE, { force: true });
    }

    // 恢复 workspaces/{id}/sessions/ 和 skills/
    const backupWorkspacesDir = join(backupDir, 'workspaces');
    if (existsSync(backupWorkspacesDir)) {
      for (const wsBackup of readdirSync(backupWorkspacesDir, { withFileTypes: true })) {
        if (!wsBackup.isDirectory()) continue;
        const wsId = wsBackup.name;
        // 找到对应的实际 workspace 目录
        const wsRootPath = join(DEFAULT_WORKSPACES_DIR, wsId);
        if (!existsSync(wsRootPath)) continue;

        const backupSessions = join(backupWorkspacesDir, wsId, 'sessions');
        if (existsSync(backupSessions)) {
          const targetSessions = join(wsRootPath, 'sessions');
          if (existsSync(targetSessions)) rmSync(targetSessions, { recursive: true, force: true });
          copyDirRecursive(backupSessions, targetSessions);
        }

        const backupSkills = join(backupWorkspacesDir, wsId, 'skills');
        if (existsSync(backupSkills)) {
          const targetSkills = join(wsRootPath, 'skills');
          if (existsSync(targetSkills)) rmSync(targetSkills, { recursive: true, force: true });
          copyDirRecursive(backupSkills, targetSkills);
        }
      }
    }

    // 恢复 ~/.agents/skills/
    const backupAgentsSkills = join(backupDir, 'agents-skills');
    if (existsSync(backupAgentsSkills)) {
      if (existsSync(LEGACY_GLOBAL_SKILLS_DIR)) {
        rmSync(LEGACY_GLOBAL_SKILLS_DIR, { recursive: true, force: true });
      }
      copyDirRecursive(backupAgentsSkills, LEGACY_GLOBAL_SKILLS_DIR);
    }

    // 清理本次迁移明确创建的 Pi 目标，保留迁移前已经存在的 Pi 数据。
    deleteCreatedPaths(createdPaths);

    debug('[unified-migration] Rollback completed. Backup preserved at:', backupDir);
  } catch (rollbackError) {
    debug('[unified-migration] Rollback failed (backup still available):', rollbackError);
  }
}

// ============================================================
// Sub-migration 1: config.json → pi settings.json
// ============================================================

/**
 * 将 config.json 中的旧 agent 行为配置字段迁移到 pi settings.json。
 *
 * 迁移的字段：
 * - browserToolEnabled → shellGui.craft.browserToolEnabled
 * - piShellFullPassthrough / piShell.fullPassthrough → shellGui.craft.piShellFullPassthrough
 * - extendedPromptCache / enable1MContext / rtkEnabled → craft.agent.*
 * - defaultThinkingLevel → pi settings.json defaultThinkingLevel
 * - piExtensions.* (legacy) → shellGui.* 命名空间
 *
 * 迁移后从 config.json 中删除这些字段（避免双写）。
 *
 * 返回：迁移的字段数。
 */
async function migrateConfigFields(): Promise<number> {
  const configFile = join(CONFIG_DIR, 'config.json');
  if (!existsSync(configFile)) {
    debug('[unified-migration] No config.json found, skipping config migration');
    return 0;
  }

  // 读取原始 JSON（不经过 loadStoredConfig，以访问已从类型中移除的 legacy 字段）。
  // Legacy Craft config is best-effort only; malformed config must not block
  // session/skill migration or app startup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf-8')) as Record<string, any>;
  } catch (error) {
    debug('[unified-migration] Skipping unreadable legacy config.json:', error);
    return 0;
  }
  let migratedCount = 0;

  // 1. browserToolEnabled → shellGui.craft.browserToolEnabled
  if (typeof raw.browserToolEnabled === 'boolean') {
    await writePiShellGuiBoolean('craft', 'browserToolEnabled', raw.browserToolEnabled);
    delete raw.browserToolEnabled;
    migratedCount++;
    debug('[unified-migration] Migrated browserToolEnabled → shellGui.craft.browserToolEnabled');
  }

  // 2. piShellFullPassthrough / piShell.fullPassthrough → shellGui.craft.piShellFullPassthrough
  // 优先读 piShellFullPassthrough（顶层），其次读 piShell.fullPassthrough（嵌套）
  const fullPassthroughValue =
    typeof raw.piShellFullPassthrough === 'boolean'
      ? raw.piShellFullPassthrough
      : typeof raw.piShell?.fullPassthrough === 'boolean'
        ? raw.piShell.fullPassthrough
        : undefined;
  if (typeof fullPassthroughValue === 'boolean') {
    await writePiShellGuiBoolean('craft', 'piShellFullPassthrough', fullPassthroughValue);
    delete raw.piShellFullPassthrough;
    if (raw.piShell) {
      delete raw.piShell.fullPassthrough;
      if (Object.keys(raw.piShell).length === 0) delete raw.piShell;
    }
    migratedCount++;
    debug('[unified-migration] Migrated piShellFullPassthrough → shellGui.craft.piShellFullPassthrough');
  }

  // 3. Agent runtime toggles → craft.agent.* namespace
  const craftAgentUpdates: Record<string, unknown> = {};
  for (const key of ['extendedPromptCache', 'enable1MContext', 'rtkEnabled']) {
    if (typeof raw[key] === 'boolean') {
      craftAgentUpdates[key] = raw[key];
      delete raw[key];
      migratedCount++;
    }
  }
  if (Object.keys(craftAgentUpdates).length > 0) {
    writePiCraftAgentSettingsBulk(craftAgentUpdates);
    debug('[unified-migration] Migrated agent runtime toggles → craft.agent.* namespace:', craftAgentUpdates);
  }

  // 4. defaultThinkingLevel → pi settings.json defaultThinkingLevel
  if (typeof raw.defaultThinkingLevel === 'string' && raw.defaultThinkingLevel) {
    await setPiGlobalDefaultThinkingLevel(raw.defaultThinkingLevel);
    delete raw.defaultThinkingLevel;
    migratedCount++;
    debug('[unified-migration] Migrated defaultThinkingLevel → pi settings.json');
  }

  // 5. piExtensions.* (legacy) → shellGui.* 命名空间
  // piExtensions 字段已从 StoredConfig 类型移除，但老用户 config.json 可能仍有
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (raw.piExtensions && typeof raw.piExtensions === 'object') {
    const piExt = raw.piExtensions as Record<string, any>;
    let extMigrated = 0;

    // craft 全局开关
    if (typeof piExt.enabled === 'boolean') {
      await writePiShellGuiBoolean('craft', 'enabled', piExt.enabled);
      extMigrated++;
    }
    if (typeof piExt.delegatePromptAutomation === 'boolean') {
      await writePiShellGuiBoolean('craft', 'delegatePromptAutomation', piExt.delegatePromptAutomation);
      extMigrated++;
    }
    if (typeof piExt.managedAgentDir === 'string') {
      await writePiShellGuiSetting('craft', 'managedAgentDir', piExt.managedAgentDir);
      extMigrated++;
    }

    // 各扩展的 GUI 开关字段（showStatusBadge / widgetVisible / planMode.* 等）
    // 这些字段原本在 piExtensions.<name>.* 下，迁移到 shellGui.<name>.*
    const EXTENSION_GUI_FIELDS: Record<string, string[]> = {
      'repo-memory': ['showStatusBadge'],
      yourself: ['showStatusBadge'],
      'trace-audit': ['showStatusBadge'],
      'prompt-automation': ['widgetVisible', 'defaultJobScope'],
      'plan-mode': ['showDiscussionButton', 'showPlanButton', 'renderPlanMarkdown'],
      subagent: ['reviewEnabled', 'reviewModel'],
    };

    for (const [extName, fields] of Object.entries(EXTENSION_GUI_FIELDS)) {
      const extConfig = piExt[extName];
      if (!extConfig || typeof extConfig !== 'object') continue;
      for (const field of fields) {
        if (field in extConfig) {
          await writePiShellGuiSetting(extName, field, extConfig[field]);
          extMigrated++;
        }
      }
    }

    if (extMigrated > 0) {
      delete raw.piExtensions;
      migratedCount += extMigrated;
      debug(`[unified-migration] Migrated ${extMigrated} piExtensions fields → shellGui.* namespace`);
    }
  }

  // 写回 config.json（已删除迁移的字段）
  if (migratedCount > 0) {
    atomicWriteFileSync(configFile, JSON.stringify(raw, null, 2));
    debug(`[unified-migration] config.json updated: ${migratedCount} fields migrated, config.json cleaned`);
  } else {
    debug('[unified-migration] No legacy config fields found to migrate');
  }

  return migratedCount;
}

// ============================================================
// Sub-migration 2: Preserve credentials.enc
// ============================================================

/**
 * 保留旧的 credentials.enc。
 *
 * 当前版本跳过凭证迁移；在恢复解密迁移或接入 OS keychain 前，
 * 不能删除旧文件，否则老用户升级会不可逆丢失全部凭证。
 *
 * 返回：是否删除了文件（当前始终为 false）。
 */
function deleteLegacyCredentials(): boolean {
  if (!existsSync(LEGACY_CREDENTIALS_FILE)) {
    debug('[unified-migration] No credentials.enc found, skipping');
    return false;
  }

  debug('[unified-migration] Preserved legacy credentials.enc; credential migration is not available in this build');
  return false;
}

// ============================================================
// Sub-migration 3: Legacy sessions → Pi tree JSONL v3
// ============================================================

/**
 * 扫描所有工作区的旧会话目录，将 session.jsonl 转换为 pi 树形 JSONL v3 格式。
 *
 * 旧路径：~/.craft-agent/workspaces/{id}/sessions/{sessionId}/session.jsonl
 *         + sidecar 子目录（attachments/plans/data/long_responses/downloads）
 *
 * 新路径：~/.pi/agent/sessions/{encoded-cwd}/{timestamp}_{sessionId}.jsonl
 *         + sidecar 目录 .craft/{sessionId}/（含 attachments/plans/data/long_responses/downloads）
 *
 * 迁移后删除旧的 session 目录（含 session.jsonl 和所有 sidecar 子目录）。
 *
 * 返回：迁移的会话数。
 */
function migrateLegacySessions(createdPaths: MigrationCreatedPaths): number {
  const workspacePaths = discoverWorkspacesInDefaultLocation();
  let migratedCount = 0;

  for (const wsRootPath of workspacePaths) {
    const wsSessionsDir = join(wsRootPath, 'sessions');
    if (!existsSync(wsSessionsDir)) continue;

    // 获取工作区的 cwd（用于确定 pi sessions bucket）
    const wsCwd = getWorkspaceCwd(wsRootPath);

    let sessionDirs: string[] = [];
    try {
      sessionDirs = readdirSync(wsSessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(wsSessionsDir, e.name));
    } catch {
      continue;
    }

    for (const sessionDir of sessionDirs) {
      const sessionFile = join(sessionDir, 'session.jsonl');
      if (!existsSync(sessionFile)) continue;

      // 读取完整会话（含 header + messages）。单个坏 session 不应阻断整个
      // one-shot 迁移；保留原目录，后续可手动恢复。
      let session: StoredSession | null = null;
      try {
        session = readSessionJsonl(sessionFile);
      } catch (error) {
        debug(
          `[unified-migration] Skipping unreadable legacy session ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!session) {
        debug(`[unified-migration] Skipping unreadable legacy session ${sessionFile}`);
        continue;
      }

      // 确定会话的 cwd（优先用 session 级 workingDirectory，其次 workspace cwd）
      const sessionCwd = session.workingDirectory || wsCwd;

      // 构造新文件路径
      const newFileName = buildPiSessionFileName(session.craftId, session.createdAt);
      const newBucketDir = join(PI_SESSIONS_DIR, encodePiSessionCwd(sessionCwd));
      const preferredSessionFile = join(newBucketDir, newFileName);

      // 确保目录存在
      if (!existsSync(newBucketDir)) {
        mkdirSync(newBucketDir, { recursive: true });
        trackCreatedDir(createdPaths, newBucketDir);
      }

      const targetResolution = resolveSessionMigrationTarget(preferredSessionFile, session);
      const newSessionFile = targetResolution.filePath;

      // 写入新格式（pi 树形 JSONL v3 + craft metadata）
      if (!targetResolution.alreadyMigrated) {
        trackCreatedFile(createdPaths, newSessionFile);
        if (!createNewTreeSessionFile(newSessionFile, session)) {
          throw new Error(`Failed to create tree session file: ${newSessionFile}`);
        }
      }

      // 迁移 sidecar 子目录到 .craft/{sessionId}/
      const newSidecarDir = getSharedPiSidecarPathForFile(newSessionFile, session.craftId);
      for (const subdir of SIDECAR_SUBDIRS) {
        const oldSubdir = join(sessionDir, subdir);
        if (existsSync(oldSubdir)) {
          const newSubdir = join(newSidecarDir, subdir);
          if (!existsSync(newSidecarDir)) {
            mkdirSync(newSidecarDir, { recursive: true });
            trackCreatedDir(createdPaths, newSidecarDir);
          }
          if (existsSync(newSubdir)) {
            mergeDirContents(oldSubdir, newSubdir);
          } else {
            // 移动整个子目录
            trackCreatedDir(createdPaths, newSubdir);
            renameOrCopyDir(oldSubdir, newSubdir);
          }
        }
      }

      // 删除旧 session 目录（含 session.jsonl 和已清空的 sidecar 子目录）
      rmSync(sessionDir, { recursive: true, force: true });

      migratedCount++;
      debug(`[unified-migration] Migrated session ${session.craftId}: ${sessionFile} → ${newSessionFile}`);
    }

    // 如果工作区的 sessions 目录已空，删除空目录
    if (existsSync(wsSessionsDir)) {
      try {
        const remaining = readdirSync(wsSessionsDir);
        if (remaining.length === 0) {
          rmSync(wsSessionsDir, { recursive: true, force: true });
        }
      } catch {
        // 忽略
      }
    }
  }

  debug(`[unified-migration] Migrated ${migratedCount} legacy sessions`);
  return migratedCount;
}

// ============================================================
// Sub-migration 4: Legacy skills → Pi native paths
// ============================================================

/**
 * 迁移旧 skills 目录到 pi 原生路径。
 *
 * - ~/.agents/skills/{slug}/ → ~/.pi/agent/skills/{slug}/（全局）
 * - ~/.craft-agent/workspaces/{id}/skills/{slug}/ → {projectRoot}/.pi/skills/{slug}/（项目级）
 *
 * 目录结构无需改写（都是 {slug}/SKILL.md），只移动目录。
 *
 * 返回：迁移的 skill 数。
 */
function migrateLegacySkills(createdPaths: MigrationCreatedPaths): number {
  let migratedCount = 0;

  // 1. 全局 skills: ~/.agents/skills/ → ~/.pi/agent/skills/
  if (existsSync(LEGACY_GLOBAL_SKILLS_DIR)) {
    if (!existsSync(PI_SKILLS_DIR)) {
      mkdirSync(PI_SKILLS_DIR, { recursive: true });
      trackCreatedDir(createdPaths, PI_SKILLS_DIR);
    }

    let skillSlugs: string[] = [];
    try {
      skillSlugs = readdirSync(LEGACY_GLOBAL_SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // 忽略
    }

    for (const slug of skillSlugs) {
      const oldDir = join(LEGACY_GLOBAL_SKILLS_DIR, slug);
      const newDir = resolveSkillTargetDir(PI_SKILLS_DIR, slug);

      trackCreatedDir(createdPaths, newDir);
      renameOrCopyDir(oldDir, newDir);
      migratedCount++;
      debug(`[unified-migration] Migrated global skill: ${slug}`);
    }

    // 删除空的旧目录
    try {
      const remaining = readdirSync(LEGACY_GLOBAL_SKILLS_DIR);
      if (remaining.length === 0) {
        rmSync(LEGACY_GLOBAL_SKILLS_DIR, { recursive: true, force: true });
      }
    } catch {
      // 忽略
    }
  }

  // 2. 工作区 skills: workspaces/{id}/skills/ → {projectRoot}/.pi/skills/
  for (const wsRootPath of discoverWorkspacesInDefaultLocation()) {
    const wsSkillsDir = getWorkspaceSkillsPath(wsRootPath);
    if (!existsSync(wsSkillsDir)) continue;

    // 从 workspace config 获取 projectRoot（即 cwd / workingDirectory）
    const wsConfig = loadWorkspaceConfig(wsRootPath);
    const projectRoot = wsConfig?.defaults?.workingDirectory;
    if (!projectRoot) {
      debug(`[unified-migration] Workspace has skills but no workingDirectory; skipping project skill migration: ${wsRootPath}`);
      continue;
    }

    const targetSkillsDir = join(projectRoot, '.pi', 'skills');

    let skillSlugs: string[] = [];
    try {
      skillSlugs = readdirSync(wsSkillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    if (skillSlugs.length === 0) continue;

    if (!existsSync(targetSkillsDir)) {
      mkdirSync(targetSkillsDir, { recursive: true });
      trackCreatedDir(createdPaths, targetSkillsDir);
    }

    for (const slug of skillSlugs) {
      const oldDir = join(wsSkillsDir, slug);
      const newDir = resolveSkillTargetDir(targetSkillsDir, slug);

      trackCreatedDir(createdPaths, newDir);
      renameOrCopyDir(oldDir, newDir);
      migratedCount++;
      debug(`[unified-migration] Migrated workspace skill: ${slug} → ${projectRoot}/.pi/skills/${slug}`);
    }

    // 删除空的旧 skills 目录
    try {
      const remaining = readdirSync(wsSkillsDir);
      if (remaining.length === 0) {
        rmSync(wsSkillsDir, { recursive: true, force: true });
      }
    } catch {
      // 忽略
    }
  }

  debug(`[unified-migration] Migrated ${migratedCount} skills`);
  return migratedCount;
}

// ============================================================
// Utilities
// ============================================================

function resolveSessionMigrationTarget(
  preferredSessionFile: string,
  session: StoredSession,
): { filePath: string; alreadyMigrated: boolean } {
  if (!existsSync(preferredSessionFile)) {
    return { filePath: preferredSessionFile, alreadyMigrated: false };
  }

  const existingHeader = readTreeSessionHeader(preferredSessionFile);
  if (existingHeader?.craft?.id === session.craftId) {
    debug(`[unified-migration] Session target already migrated, reusing: ${preferredSessionFile}`);
    return { filePath: preferredSessionFile, alreadyMigrated: true };
  }

  const filePath = findAvailableJsonlSibling(preferredSessionFile);
  debug(`[unified-migration] Session target collision, using alternate path: ${filePath}`);
  return { filePath, alreadyMigrated: false };
}

function findAvailableJsonlSibling(preferredPath: string): string {
  if (!existsSync(preferredPath)) return preferredPath;

  const suffix = '.jsonl';
  const base = preferredPath.endsWith(suffix)
    ? preferredPath.slice(0, -suffix.length)
    : preferredPath;

  for (let index = 1; ; index++) {
    const candidate = `${base}.legacy-${index}${preferredPath.endsWith(suffix) ? suffix : ''}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function resolveSkillTargetDir(parentDir: string, slug: string): string {
  const preferred = join(parentDir, slug);
  if (!existsSync(preferred)) return preferred;

  for (let index = 1; ; index++) {
    const candidate = join(parentDir, `${slug}-legacy-${index}`);
    if (!existsSync(candidate)) {
      debug(`[unified-migration] Skill target collision, using alternate path: ${candidate}`);
      return candidate;
    }
  }
}

function trackCreatedFile(createdPaths: MigrationCreatedPaths, filePath: string): void {
  if (!createdPaths.files.includes(filePath)) {
    createdPaths.files.push(filePath);
  }
}

function trackCreatedDir(createdPaths: MigrationCreatedPaths, dirPath: string): void {
  if (!createdPaths.dirs.includes(dirPath)) {
    createdPaths.dirs.push(dirPath);
  }
}

function deleteCreatedPaths(createdPaths?: MigrationCreatedPaths): void {
  if (!createdPaths) return;

  for (const filePath of createdPaths.files) {
    try {
      if (existsSync(filePath)) rmSync(filePath, { force: true });
    } catch (error) {
      debug('[unified-migration] Failed to delete created file during rollback:', filePath, error);
    }
  }

  const dirs = [...createdPaths.dirs].sort((a, b) => b.length - a.length);
  for (const dirPath of dirs) {
    try {
      if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true });
    } catch (error) {
      debug('[unified-migration] Failed to delete created dir during rollback:', dirPath, error);
    }
  }
}

/**
 * 递归复制目录。
 */
function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 重命名目录，如果跨设备失败则回退到复制+删除。
 */
function renameOrCopyDir(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch {
    // 跨设备或权限问题，回退到复制+删除
    copyDirRecursive(src, dest);
    rmSync(src, { recursive: true, force: true });
  }
}

function findAvailableChildPath(destDir: string, name: string): string {
  const preferred = join(destDir, name);
  if (!existsSync(preferred)) return preferred;

  for (let index = 1; ; index++) {
    const candidate = join(destDir, `${name}.legacy-${index}`);
    if (!existsSync(candidate)) return candidate;
  }
}

function moveFileOrCopy(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    rmSync(src, { force: true });
  }
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mergeDirContents(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const preferredDestPath = join(dest, entry.name);

    if (entry.isDirectory() && isDirectoryPath(preferredDestPath)) {
      mergeDirContents(srcPath, preferredDestPath);
      continue;
    }

    const destPath = existsSync(preferredDestPath)
      ? findAvailableChildPath(dest, entry.name)
      : preferredDestPath;

    if (entry.isDirectory()) {
      renameOrCopyDir(srcPath, destPath);
    } else {
      moveFileOrCopy(srcPath, destPath);
    }
  }

  rmSync(src, { recursive: true, force: true });
}

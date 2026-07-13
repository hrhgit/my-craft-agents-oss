/**
 * Pi Global → Craft thin wrapper
 *
 * ~/.pi/agent/ 是 "pure Pi + custom provider" 模式的唯一数据源（SoT）。
 * Craft 现在直接读写 ~/.pi/agent/，不再在 config.json 中维护 `pi-*`
 * Pi 凭证统一存储在 ~/.pi/agent/auth.json。
 *
 * 职责（thin wrapper）：
 * - 读取 ~/.pi/agent/ 的 providers + settings（用于启动校验与 defaultProvider
 *   自动修复）。
 *
 * 不再做的事：
 * - 不构建 Craft provider 副本，不调用 saveConfig。
 * - 不调用 credentialManager.setProviderApiKey / setProviderOAuth / setProviderIamCredentials
 *   写入 `pi-*` slug 的凭证。
 *
 * 触发时机：
 *   1. 服务器启动时一次（registerPiProviderHandlers）。
 *   2. 每次 pi:saveGlobalProvider / pi:deleteGlobalProvider /
 *      pi:setGlobalDefault 之后。
 */

import {
  migratePiGlobalProviderApiKeysToAuth,
  readPiGlobalProviders,
  readPiGlobalSettings,
  setPiGlobalDefault,
  type PiGlobalProvider,
} from '@craft-agent/shared/config'

/** 同步运行结果——调用方依据 `changed` 决定是否广播。 */
export interface SyncResult {
  changed: boolean
  error?: string
}

/**
 * ~/.pi/agent/ 的 thin wrapper。
 *
 * - 读取 ~/.pi/agent/ 的 providers + default，并对失效的 defaultProvider 做自动修复。
 * - 不写入 Craft 旧配置或旧凭证路径。
 *
 * 返回 SyncResult。永不抛错——错误会被记录并以 `error` 字段返回。
 */
export async function syncPiGlobalConfig(): Promise<SyncResult> {
  let providers: Record<string, PiGlobalProvider> = {}
  let settings: { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string } = {}
  let changed = false

  try {
    const migration = migratePiGlobalProviderApiKeysToAuth()
    changed = migration.changed
  } catch (e) {
    return {
      changed: false,
      error: `Failed to migrate ~/.pi/agent/models.json apiKey fields into auth.json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  try {
    providers = readPiGlobalProviders()
  } catch (e) {
    return {
      changed: false,
      error: `Failed to read ~/.pi/agent/models.json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  try {
    settings = readPiGlobalSettings()
  } catch {
    // settings.json 可选——不存在时不应用默认值
  }

  // 自动修复：当 defaultProvider 是保留的内部名称（如 'custom-endpoint'）或
  // 不匹配 models.json 中的任何真实 provider 时，改写为第一个真实 provider，
  // 以便 PiProvidersSection 和 subprocess 的 InitMessage 路径能正确解析。
  const providerKeys = Object.keys(providers)
  if (settings.defaultProvider && !providers[settings.defaultProvider]) {
    const fixedProvider = providerKeys[0]
    const fixedModel = fixedProvider
      ? providers[fixedProvider]?.models?.[0]?.id
      : undefined
    if (fixedProvider && fixedModel) {
      console.warn(
        `[pi-global-sync] defaultProvider "${settings.defaultProvider}" 在 models.json 中不存在——自动修复为 "${fixedProvider}"`,
      )
      try {
        await setPiGlobalDefault(fixedProvider, fixedModel, settings.defaultThinkingLevel)
        settings.defaultProvider = fixedProvider
        settings.defaultModel = fixedModel
        changed = true
      } catch (e) {
        console.error('[pi-global-sync] 自动修复 defaultProvider 失败:', e)
        return {
          changed: false,
          error: `Failed to repair ~/.pi/agent/settings.json defaultProvider: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }
  }

  return { changed }
}

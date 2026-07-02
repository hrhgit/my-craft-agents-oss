/**
 * Pi Global → Craft thin wrapper
 *
 * ~/.pi/agent/ 是 "pure Pi + custom provider" 模式的唯一数据源（SoT）。
 * Craft 现在直接读写 ~/.pi/agent/，不再在 config.json 中维护 `pi-*`
 * LlmConnection 副本，也不再在 credentials.enc 中存储 pi 凭证。
 *
 * 职责（thin wrapper）：
 * - 读取 ~/.pi/agent/ 的 providers + settings（用于启动校验与 defaultProvider
 *   自动修复）。
 * - 一次性凭证迁移：若 ~/.pi/agent/auth.json 不存在且 credentials.enc 中仍残留
 *   `pi-*` 凭证（来自旧的同步层），则把它们导出到 auth.json，随后从
 *   credentials.enc 中删除。该迁移是幂等的。
 *
 * 不再做的事：
 * - 不构建 config.llmConnections 中的 `pi-*` 条目，不调用 saveConfig。
 * - 不调用 credentialManager.setLlmApiKey / setLlmOAuth / setLlmIamCredentials
 *   写入 `pi-*` slug 的凭证。
 *
 * 触发时机：
 *   1. 服务器启动时一次（registerLlmConnectionsHandlers）。
 *   2. 每次 pi:saveGlobalProvider / pi:deleteGlobalProvider /
 *      pi:setGlobalDefault 之后。
 */

import {
  readPiGlobalProviders,
  readPiGlobalSettings,
  setPiGlobalDefault,
  type PiGlobalProvider,
  type PiGlobalAuthFile,
  type PiGlobalAuthCredential,
} from '@craft-agent/shared/config'
import { PI_AUTH_FILE, PI_AGENT_DIR } from '@craft-agent/shared/config/paths'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { getCredentialManager } from '@craft-agent/shared/credentials'

const PI_SYNCED_PREFIX = 'pi-'

/** 同步运行结果——调用方依据 `changed` 决定是否广播。 */
export interface SyncResult {
  changed: boolean
  synced: number
  removed: number
  error?: string
}

/**
 * 一次性凭证迁移：若 ~/.pi/agent/auth.json 不存在且 credentials.enc 中仍残留
 * `pi-*` 凭证（旧同步层遗留），则导出到 auth.json 并从 credentials.enc 删除。
 *
 * 幂等：一旦 auth.json 已存在，或 credentials.enc 中没有 `pi-*` 凭证，即为空操作。
 *
 * 返回 true 表示发生了迁移（调用方可据此广播）。
 */
async function migratePiCredentialsToAuthFile(): Promise<boolean> {
  // auth.json 已存在——无需迁移
  if (existsSync(PI_AUTH_FILE)) return false

  const credentialManager = getCredentialManager()
  // 列出所有凭证，筛选出 `pi-*` slug
  const allIds = await credentialManager.list({})
  const piSlugs = new Set<string>()
  for (const id of allIds) {
    if (id.connectionSlug && id.connectionSlug.startsWith(PI_SYNCED_PREFIX)) {
      piSlugs.add(id.connectionSlug)
    }
  }
  if (piSlugs.size === 0) return false

  // 从 credentials.enc 中的 `pi-*` 凭证构建 auth.json
  const providers: Record<string, PiGlobalAuthCredential> = {}
  for (const slug of piSlugs) {
    const providerKey = slug.slice(PI_SYNCED_PREFIX.length)
    const apiKey = await credentialManager.getLlmApiKey(slug)
    if (apiKey) {
      providers[providerKey] = { type: 'api_key', key: apiKey }
      continue
    }
    const oauth = await credentialManager.getLlmOAuth(slug)
    if (oauth) {
      providers[providerKey] = {
        type: 'oauth',
        access: oauth.accessToken,
        refresh: oauth.refreshToken,
        expires: oauth.expiresAt,
        idToken: oauth.idToken,
      }
      continue
    }
    const iam = await credentialManager.getLlmIamCredentials(slug)
    if (iam) {
      providers[providerKey] = {
        type: 'iam',
        accessKeyId: iam.accessKeyId,
        secretAccessKey: iam.secretAccessKey,
        region: iam.region,
        sessionToken: iam.sessionToken,
      }
    }
  }

  if (Object.keys(providers).length === 0) return false

  // 写入 auth.json
  if (!existsSync(PI_AGENT_DIR)) {
    mkdirSync(PI_AGENT_DIR, { recursive: true })
  }
  const authFile: PiGlobalAuthFile = { providers }
  writeFileSync(PI_AUTH_FILE, JSON.stringify(authFile, null, 2), 'utf-8')

  // 删除已迁移的 `pi-*` 凭证
  for (const slug of piSlugs) {
    try {
      await credentialManager.deleteLlmCredentials(slug)
    } catch (err) {
      console.error(`[pi-global-sync] 删除已迁移凭证失败 ${slug}:`, err)
    }
  }

  console.log(
    `[pi-global-sync] 已将 ${Object.keys(providers).length} 个 pi 凭证从 credentials.enc 迁移到 ${PI_AUTH_FILE}`,
  )
  return true
}

/**
 * ~/.pi/agent/ 的 thin wrapper。
 *
 * - 读取 ~/.pi/agent/ 的 providers + default，并对失效的 defaultProvider 做自动修复。
 * - 执行一次性凭证迁移（幂等）。
 * - 不写入 config.llmConnections 或 credentials.enc。
 *
 * 返回 SyncResult。永不抛错——错误会被记录并以 `error` 字段返回。
 */
export async function syncPiGlobalToLlmConnections(): Promise<SyncResult> {
  let providers: Record<string, PiGlobalProvider> = {}
  let settings: { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string } = {}

  try {
    providers = readPiGlobalProviders()
  } catch (e) {
    return {
      changed: false,
      synced: 0,
      removed: 0,
      error: `Failed to read ~/.pi/agent/models.json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  try {
    settings = readPiGlobalSettings()
  } catch {
    // settings.json 可选——不存在时不应用默认值
  }

  let changed = false

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
        setPiGlobalDefault(fixedProvider, fixedModel, settings.defaultThinkingLevel)
        settings.defaultProvider = fixedProvider
        settings.defaultModel = fixedModel
        changed = true
      } catch (e) {
        console.error('[pi-global-sync] 自动修复 defaultProvider 失败:', e)
      }
    }
  }

  // 一次性凭证迁移（幂等）
  try {
    const migrated = await migratePiCredentialsToAuthFile()
    if (migrated) changed = true
  } catch (e) {
    console.error('[pi-global-sync] 凭证迁移失败:', e)
  }

  return { changed, synced: providerKeys.length, removed: 0 }
}

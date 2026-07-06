/**
 * Pi Credential Store — pi auth.json wrapper
 *
 * 凭证统一存储在 ~/.pi/agent/auth.json 的 craft.<slug> 命名空间。此模块为
 * pi AuthStorage 的 thin wrapper，保留对外方法签名以兼容调用方。
 *
 * 设计要点：
 * - 所有凭证（含非 pi 的 LLM/OAuth/source/workspace 凭证）写入 pi auth.json 的
 *   `craft.<slug>` 命名空间，由 pi AuthStorage 的 craft helper 方法管理。
 * - pi 自身的凭证（auth.json 顶层 `providers` 命名空间）由 pi CLI / Pi RpcClient
 *   维护，craft 不触碰；pi CLI 单独运行时也不会读取 `craft.*` 条目。
 * - `craft.<slug>` 命名空间对 pi 是 opaque（pi auth-storage.ts 注释明确说明），
 *   因此 craft 可以用自定义 envelope 无损存储任意 StoredCredential。
 *
 * Slug 命名约定（沿用 credentialIdToAccount 的 `::` 分隔格式，无 `.`，符合
 * pi setCraftCredential 的 slug 校验）：
 *   - llm_api_key::<connectionSlug>
 *   - llm_oauth::<connectionSlug>
 *   - llm_iam::<connectionSlug>
 *   - llm_service_account::<connectionSlug>
 *   - workspace_oauth::<workspaceId>
 *   - source_oauth::<workspaceId>::<sourceId>
 *   - source_bearer::<workspaceId>::<sourceId>
 *   - source_apikey::<workspaceId>::<sourceId>
 *   - source_basic::<workspaceId>::<sourceId>
 *   - messaging_bearer::<workspaceId>::<platform>
 *   - <type>::global（legacy global credentials）
 *
 * 在 auth.json 中最终 key 形如 `craft.llm_api_key::my-connection`。
 */

import { AuthStorage, type AuthCredential } from '@earendil-works/pi-coding-agent';
import { PI_AUTH_FILE } from '../../config/paths.ts';
import type { CredentialBackend } from './types.ts';
import type { CredentialId, CredentialType, StoredCredential } from '../types.ts';
import {
  credentialIdToAccount,
  accountToCredentialId,
} from '../types.ts';
import { debug } from '../../utils/debug.ts';

/**
 * Envelope persisted in auth.json under `craft.<slug>`.
 *
 * pi 的 AuthCredential 联合（ApiKeyCredential | OAuthCredential | SourceCredential）
 * 无法无损承载 craft 的所有 StoredCredential 字段（如 IAM 的 awsAccessKeyId、
 * service_account 的 gcpProjectId、source_apikey 的任意 JSON value）。由于
 * `craft.*` 命名空间对 pi 是 opaque（pi 不解析这些条目），我们用自定义 envelope
 * 保存原始 StoredCredential 与 craft 凭证类型，保证零数据丢失。这与
 * Pi RpcClient 处理 IAM 凭证时的做法一致（`as unknown as AuthCredential`）。
 */
interface CraftCredentialEnvelope {
  type: 'craft_credential';
  /** craft 凭证类型（CredentialType），用于 list() 过滤 */
  craftType: CredentialType;
  /** 原始 StoredCredential，所有字段完整保留 */
  stored: StoredCredential;
}

/**
 * pi AuthStorage 单例（文件后端，指向 ~/.pi/agent/auth.json）。
 *
 * AuthStorage 在构造时读取 auth.json 到内存（this.data），后续 set/remove 会同时
 * 更新内存与磁盘（通过 FileAuthStorageBackend.withLock 加文件锁后读-改-写）。
 * craft 是 `craft.*` 命名空间的唯一写入者（Pi RpcClient 使用 in-memory
 * AuthStorage，不回写 auth.json），因此单进程内的内存缓存是一致的。
 */
let craftAuthStorage: AuthStorage | null = null;

function getAuthStorage(): AuthStorage {
  if (!craftAuthStorage) {
    craftAuthStorage = AuthStorage.create(PI_AUTH_FILE);
  }
  return craftStorageReloaded(craftAuthStorage);
}

export function clearAllCraftCredentials(): number {
  const storage = getAuthStorage();
  const slugs = storage.listCraftSlugs();
  for (const slug of slugs) {
    storage.deleteCraftCredential(slug);
  }
  storage.reload();
  return slugs.length;
}

/**
 * 在每次访问前 reload，确保读到其他进程（如 pi CLI）对 auth.json 的最新写入。
 * FileAuthStorageBackend.withLock 是同步文件锁，开销与原 secure-storage 的
 * readFileSync 相当。craft.* 条目由 craft 独占写入，但 pi CLI 可能修改同文件中
 * 的 pi 凭证（触发整体文件重写），reload 避免读到陈旧的 craft.* 副本。
 */
function craftStorageReloaded(storage: AuthStorage): AuthStorage {
  try {
    storage.reload();
  } catch (err) {
    debug('[secure-storage] reload auth.json failed:', err);
  }
  return storage;
}

/**
 * Slug 点号转义：pi 的 setCraftCredential 校验 slug 不含 `.`（与 `craft.<slug>`
 * 命名空间前缀冲突），而 craft 的 scope 段（connectionSlug / sourceId / 自定义
 * 连接名）可能含 `.`。使用百分号编码 `%2E`——可逆且无碰撞风险。
 *
 * 例：`source_oauth::ws1::my.api.source` → `source_oauth::ws1::my%2Eapi%2Esource`
 */
export function escapeSlugSegment(s: string): string {
  return s.replace(/\./g, '%2E');
}

/** slug 反转义：从 auth.json 读回的 slug 还原原始 `.` */
export function unescapeSlugSegment(s: string): string {
  return s.replace(/%2E/g, '.');
}

/** 将 StoredCredential 封装为 envelope，再 cast 为 AuthCredential 写入 pi auth.json */
function encodeCredential(stored: StoredCredential, craftType: CredentialType): AuthCredential {
  const envelope: CraftCredentialEnvelope = {
    type: 'craft_credential',
    craftType,
    stored,
  };
  return envelope as unknown as AuthCredential;
}

/** 从 pi AuthCredential 还原为 StoredCredential；非 envelope 返回 null */
function decodeCredential(cred: AuthCredential | undefined): { stored: StoredCredential; craftType: CredentialType } | null {
  if (!cred) return null;
  const candidate = cred as unknown as Partial<CraftCredentialEnvelope>;
  if (candidate?.type !== 'craft_credential' || !candidate.stored || typeof candidate.stored !== 'object') {
    return null;
  }
  return {
    stored: candidate.stored as StoredCredential,
    craftType: candidate.craftType as CredentialType,
  };
}

export class PiCredentialStore implements CredentialBackend {
  readonly name = 'pi-auth-json';
  readonly priority = 100;

  async isAvailable(): Promise<boolean> {
    // pi AuthStorage 文件后端始终可用（首次写入时自动创建 ~/.pi/agent/ 目录）
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const slug = escapeSlugSegment(credentialIdToAccount(id));
    const storage = getAuthStorage();
    const cred = storage.getCraftCredential(slug);
    const decoded = decodeCredential(cred);
    return decoded?.stored ?? null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    const slug = escapeSlugSegment(credentialIdToAccount(id));
    const storage = getAuthStorage();
    storage.setCraftCredential(slug, encodeCredential(credential, id.type));
    // 回读校验：强制从磁盘 reload 后再读，确保校验基于磁盘实际内容。
    //
    // 背景：setCraftCredential 先更新内存 this.data，再调 persistProviderChange
    // 写磁盘。但 persistProviderChange 在 this.loadError 非空时静默 return（不写盘），
    // 此时内存已更新但磁盘未写入。若直接读 this.data 会得到虚假的成功。
    //
    // reload() 从磁盘重新读取内容覆盖 this.data（成功时 loadError 被清空），
    // 因此 reload 后的 getCraftCredential 反映磁盘真实状态，能检测出 persist
    // 被跳过的情况。
    //
    // 已知限制：若 reload() 自身失败（如文件不可读），this.data 不会被更新，
    // 校验仍可能误报成功。pi 未暴露 loadError，无法 100% 检测此场景；但 reload
    // 成功的常见场景（写入失败但磁盘可读）能被正确检测。
    storage.reload();
    const readBack = storage.getCraftCredential(slug);
    if (readBack === undefined) {
      throw new Error(
        `Failed to persist credential: ${slug} (auth.json write did not reach disk)`,
      );
    }
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const slug = escapeSlugSegment(credentialIdToAccount(id));
    const storage = getAuthStorage();
    const existed = storage.getCraftCredential(slug) !== undefined;
    if (!existed) return false;
    storage.deleteCraftCredential(slug);
    // 回读校验：与 set() 同理——persistProviderChange 在 loadError 时静默
    // 跳过磁盘写入（但内存已删除），需 reload 后确认磁盘已真正删除。
    storage.reload();
    if (storage.getCraftCredential(slug) !== undefined) {
      throw new Error(
        `Failed to delete credential: ${slug} (still present on disk after reload)`,
      );
    }
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const storage = getAuthStorage();
    const slugs = storage.listCraftSlugs();
    const ids: CredentialId[] = [];
    for (const slug of slugs) {
      const id = accountToCredentialId(unescapeSlugSegment(slug));
      if (!id) continue;
      ids.push(id);
    }

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      if (filter.connectionSlug && id.connectionSlug !== filter.connectionSlug) return false;
      return true;
    });
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    craftAuthStorage = null;
  }
}

export { PiCredentialStore as SecureStorageBackend };

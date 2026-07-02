# Craft ↔ Pi 完全同步（壳模式）实施计划

## 目标

将 Craft 从「独立 Agent + Pi 后端」重构为「Pi 的薄壳」：
- Craft 保留：Electron 窗口、渲染 UI、ModeManager 权限网关、MCP 池、数据源（sources）、加密凭证管理
- 委托 Pi 为权威：身份（system prompt）、会话、技能、Agent 身份、自动化、计划模式

单一回滚开关：`piShell.fullPassthrough`（默认 `true`，已在 `config/storage.ts` 实现）。

---

## 当前状态分析

### 已完成（阶段 1-2 + 阶段 3 部分）

**阶段 1 - 身份透传（COMPLETED）**
- `packages/shared/src/config/storage.ts:623-640` — `getPiShellFullPassthrough()` / `setPiShellFullPassthrough()`
- `packages/shared/src/config/config-defaults-schema.ts` + `apps/electron/resources/config-defaults.json` — `piShell.fullPassthrough: true` 默认值
- `packages/shared/src/agent/pi-agent.ts:2067-2078` — passthrough 时跳过 Craft system prompt，使用 Pi 原生 prompt
- `packages/pi-agent-server/src/index.ts:~1623` — passthrough 时跳过 `applySystemPromptOverride`

**阶段 2 - 技能仓库统一（COMPLETED）**
- `packages/shared/src/config/paths.ts` — `PI_SKILLS_DIR`、`PI_PROJECT_SKILLS_DIR` 常量
- `packages/shared/src/skills/storage.ts:56-102` — `getActiveSkillsTiers()`、`resolveSkillDir()` 按 shell 模式返回 Pi 技能目录
- `packages/shared/src/skills/index.ts` — 已导出 `getActiveSkillsTiers`、`resolveSkillDir`
- `packages/server-core/src/handlers/rpc/skills.ts` — GET_FILES/OPEN_EDITOR/OPEN_FINDER 已用 `resolveSkillDir`
- 技能 UI（`SkillsListPanel.tsx`、`SkillInfoPage.tsx`）已支持 source 显示与 Pi 目录，无需改动

**阶段 3 - 会话统一（PARTIALLY DONE）**
- `packages/shared/src/config/paths.ts` — `PI_SESSIONS_DIR`、`PI_PROJECT_SESSIONS_DIR` 常量
- `packages/shared/src/sessions/storage.ts:386-517` — `listPiCliSessions()`、`listPiProjectSessions()`、`readPiSessionFile()` 已实现（Pi JSONL → SessionMetadata，id 加 `pi-` 前缀）
- **缺失**：未从 `sessions/index.ts` 导出；sessions RPC handler 未合并 Pi 会话

### 待实施（阶段 3 完成 + 阶段 4-6）

详见下文「拟议变更」。

---

## 拟议变更

### 阶段 3 完成：会话列表合并 + Pi 会话加载

#### 3.1 导出 Pi 会话函数

**文件**：`packages/shared/src/sessions/index.ts`

**变更**：在 storage 函数导出块（~line 27-83）中追加导出：
```typescript
  // Pi CLI sessions (shell mode)
  listPiCliSessions,
  listPiProjectSessions,
```

**原因**：RPC handler 与 SessionManager 需通过 barrel 导入这两个函数。

#### 3.2 合并 Pi 会话到 sessions.GET 列表

**文件**：`packages/server-core/src/handlers/rpc/sessions.ts`（line 139-164 的 `sessions.GET` handler）

**变更**：在 `getSessions(workspaceId)` 返回后，当 `getPiShellFullPassthrough()` 为 true 时，追加 Pi CLI 会话与项目级 Pi 会话：

```typescript
server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
  // ... 现有 waitForInit / workspace 解析 ...
  const sessions = sessionManager.getSessions(workspaceId ?? undefined)

  // Pi 壳模式：合并 Pi CLI 会话（~/.pi/agent/sessions/）与项目级 Pi 会话
  if (getPiShellFullPassthrough()) {
    const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : undefined
    const workspaceRoot = workspace?.rootPath ?? ''
    const piCliSessions = listPiCliSessions(PI_SESSIONS_DIR, workspaceRoot)
    // 项目级会话按当前 workspace 的活动 workingDirectory 解析（best-effort）
    const merged = [...sessions, ...piCliSessions]
    // 去重：Pi 会话 id 以 'pi-' 前缀，不会与 Craft 会话冲突
    end()
    return merged
  }

  end()
  return sessions
})
```

**新增导入**：`getPiShellFullPassthrough`（from `@craft-agent/shared/config`）、`listPiCliSessions`（from `@craft-agent/shared/sessions`）、`PI_SESSIONS_DIR`（from `@craft-agent/shared/config/paths`）、`getWorkspaceByNameOrId`（已导入）。

**原因**：让 Craft 会话列表显示 Pi CLI 创建的会话，实现「共用会话」。

#### 3.3 Pi 会话消息加载（只读）

**文件**：`packages/shared/src/sessions/storage.ts`

**变更**：新增 `loadPiSessionMessages(filePath: string): StoredMessage[]` 函数，解析 Pi JSONL 的 message 条目并转换为 Craft `StoredMessage`：

```typescript
/**
 * 加载 Pi 会话的完整消息（只读）。
 * 将 Pi 的 {type:"message", role, content} 条目转换为 Craft StoredMessage。
 */
export function loadPiSessionMessages(filePath: string): StoredMessage[] {
  // 读取 JSONL，跳过 header 行，对 type==="message" 条目做格式转换
  // Pi content (string | content_block[]) → Craft message.content
  // 生成 id: `pi-msg-{lineIndex}`，timestamp 从 entry 解析
  // 返回 StoredMessage[]（toolUse/toolResult 等条目尽力转换，无法识别的跳过）
}
```

**字段映射**（Pi → Craft StoredMessage）：
- `entry.id` → `message.id`（缺失则生成 `pi-msg-{i}`）
- `entry.role` → `message.role`（'user' | 'assistant'）
- `entry.content` → `message.content`（string 直接用；array 提取 text/tool_use/tool_result 块）
- `entry.timestamp` → `message.createdAt`
- `entry.type !== 'message'` → 跳过（summary/tool_result 等单独条目尽力合并到相邻消息）

**文件**：`packages/server-core/src/handlers/rpc/sessions.ts`（`sessions.GET_MESSAGES` handler，line 181-186）

**变更**：当 `sessionId` 以 `pi-` 前缀开头时，走 Pi 会话加载路径：

```typescript
server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async (_ctx, sessionId: string) => {
  // Pi 会话：从 Pi sessions 目录加载（只读）
  if (sessionId.startsWith('pi-') && getPiShellFullPassthrough()) {
    const piSessionId = sessionId.slice(3)
    const filePath = findPiSessionFile(PI_SESSIONS_DIR, piSessionId)
    if (filePath) {
      const messages = loadPiSessionMessages(filePath)
      const header = readPiSessionFile(filePath, '')
      // 返回 Session 形状（messages + metadata），标记 isReadOnly
      return buildReadOnlyPiSession(sessionId, header, messages)
    }
    return null
  }
  // Craft 会话：原有路径
  const session = await sessionManager.getSession(sessionId)
  return session
})
```

**新增辅助**：`findPiSessionFile(sessionsDir, piSessionId)` 在 `sessions/storage.ts` 中递归查找 `{id}.jsonl`；`buildReadOnlyPiSession` 组装返回对象。

**原因**：点击 Pi 会话时能查看其消息内容（只读），实现真正的「共用会话」。Pi 会话不支持发送新消息（会由 Craft 新建 Craft 会话走 Pi 后端）。

**决策**：Pi 会话在 Craft 中为**只读视图**。用户点击 Pi 会话可查看历史，但发新消息会创建新 Craft 会话（仍走 Pi 后端 + Pi 原生身份）。这避免双向写回 Pi 会话文件的复杂性，同时满足「共用会话」的核心诉求（可见、可查阅）。

---

### 阶段 4：凭证直读 Pi（auth.json 同步）

#### 4.1 读取 Pi auth.json

**文件**：`packages/shared/src/config/pi-global-config.ts`

**现状**：`PI_AUTH_FILE` 在 `paths.ts:26` 已定义但全代码库未使用。无 `readPiGlobalAuth()` 函数。

**变更**：新增类型与读取函数，镜像现有 `readPiGlobalModelsFile()` 模式：

```typescript
import { PI_AUTH_FILE } from './paths.ts'

/** Pi auth.json 中单个 provider 的凭证 */
export interface PiGlobalAuthCredential {
  type: 'api_key' | 'oauth' | 'iam'
  key?: string         // api_key
  access?: string      // oauth access token
  refresh?: string     // oauth refresh token
  expires?: number     // oauth expiry (ms)
  idToken?: string     // OIDC id token
  accessKeyId?: string // iam
  secretAccessKey?: string
  region?: string
  sessionToken?: string
}

/** Pi auth.json 顶层结构：{ providers: Record<providerKey, PiGlobalAuthCredential> } */
export interface PiGlobalAuthFile {
  providers?: Record<string, PiGlobalAuthCredential>
}

/** 读取 ~/.pi/agent/auth.json。文件不存在或解析失败返回 null。 */
export function readPiGlobalAuth(): PiGlobalAuthFile | null {
  if (!existsSync(PI_AUTH_FILE)) return null
  try {
    return readJsonFileSync<PiGlobalAuthFile>(PI_AUTH_FILE)
  } catch {
    return null
  }
}
```

**原因**：为凭证同步提供 Pi 侧 OAuth 凭证数据源。`PI_AUTH_FILE` 从死代码激活。

#### 4.2 扩展 pi-global-sync 同步 OAuth 凭证

**文件**：`packages/server-core/src/handlers/rpc/pi-global-sync.ts`（`syncPiGlobalToLlmConnections()`，line 97-230）

**现状**：仅同步 `provider.apiKey`（来自 `models.json`）到 `credentials.enc`（line 207-218）。从未读取 `auth.json`，故 Pi 原生 OAuth provider（如 Pi 直接登录的 Claude/ChatGPT/Copilot）的 OAuth token 不会被 Craft 拾取。

**变更**：在现有 apiKey 写入后，追加 OAuth/iam 凭证同步：

```typescript
// 现有 line 207-218: 写入 apiKey 到 credentials.enc
// ... 之后追加：

// 同步 OAuth / IAM 凭证从 ~/.pi/agent/auth.json
const piAuth = readPiGlobalAuth()
if (piAuth?.providers) {
  await Promise.all(Object.entries(piAuth.providers).map(async ([key, cred]) => {
    const slug = `pi-${key}`
    try {
      if (cred.type === 'oauth' && cred.access) {
        await credentialManager.setLlmOAuth(slug, {
          accessToken: cred.access,
          refreshToken: cred.refresh,
          expiresAt: cred.expires,
          idToken: cred.idToken,
        })
      } else if (cred.type === 'iam' && cred.accessKeyId) {
        await credentialManager.setLlmIamCredentials(slug, {
          awsAccessKeyId: cred.accessKeyId,
          awsSecretAccessKey: cred.secretAccessKey ?? '',
          awsRegion: cred.region,
          awsSessionToken: cred.sessionToken,
        })
      }
      // api_key 类型已由上方 models.json.apiKey 同步覆盖，此处不重复
    } catch (e) {
      debug(`[pi-global-sync] Failed to sync auth.json credential for ${slug}:`, e)
    }
  }))
}
```

**新增导入**：`readPiGlobalAuth`（from `@craft-agent/shared/config/pi-global-config`）。

**原因**：让 `getPiAuth()`（`pi-agent.ts:637-716`）通过现有 slug 查找路径（`credentialManager.getLlmOAuth(slug)` / `getLlmIamCredentials(slug)`）自动拾取 Pi 原生 OAuth 凭证，无需改动 `getPiAuth()` 本身。slug 约定一致（`pi-<key>`）。

**决策**：保持 `credentials.enc` 作为运行时唯一凭证源（`getPiAuth()` 不变），Pi 的 `auth.json` 作为同步源。这样既复用现有加密存储与刷新机制，又实现「凭证共用」。

---

### 阶段 5：自动化与计划模式委托

#### 5.1 启用 delegatePromptAutomation 默认值（passthrough 模式下）

**文件**：`packages/shared/src/config/storage.ts`（`getPiExtensionsDelegatePromptAutomation()`，line 594-601）

**现状**：`delegatePromptAutomation` 默认 `false`。

**变更**：在 passthrough 模式下默认启用委托。修改 getter：

```typescript
export function getPiExtensionsDelegatePromptAutomation(): boolean {
  const config = loadStoredConfig()
  if (config?.piExtensions?.delegatePromptAutomation !== undefined) {
    return config.piExtensions.delegatePromptAutomation
  }
  const defaults = loadConfigDefaults()
  const defaultValue = defaults.defaults.piExtensions?.delegatePromptAutomation ?? false
  // Pi 壳模式（fullPassthrough）下默认启用 automation 委托
  if (!defaultValue && getPiShellFullPassthrough()) {
    return true
  }
  return defaultValue
}
```

**原因**：壳模式下自动化应委托给 Pi prompt-automation 扩展，而非 Craft 自行执行。

#### 5.2 实现 onDelegatePrompts 委托回调

**文件**：`packages/server-core/src/sessions/SessionManager.ts`（`onDelegatePrompts` stub，~line 1588-1596）

**现状**：`onDelegatePrompts` 为 stub（仅日志，不实际委托）。

**变更**：实现委托逻辑——找到工作区内活动 Pi 会话，通过 `invokeExtensionCommand` 调用 `prompt-automation` 命令；无活动会话时回退到现有 `onPromptsReady` 路径：

```typescript
onDelegatePrompts: async (prompts) => {
  sessionLog.info(`[Automations] Delegating ${prompts.length} prompt(s) to pi prompt-automation`)

  const delegateSession = this.findActivePiSessionForWorkspace(workspaceRootPath)
  if (!delegateSession) {
    sessionLog.warn(`[Automations] No active Pi session — falling back to onPromptsReady`)
    await this.executePromptAutomationsFallback(workspaceId, workspaceRootPath, prompts)
    return
  }

  for (const pending of prompts) {
    const args = JSON.stringify({
      prompt: pending.prompt,
      labels: pending.labels,
      permissionMode: pending.permissionMode,
      llmConnection: pending.llmConnection,
      model: pending.model,
      thinkingLevel: pending.thinkingLevel,
      automationName: pending.automationName,
    })
    this.invokeExtensionCommand(delegateSession, 'prompt-automation', `run ${args}`)
  }
},
```

**新增辅助方法**（SessionManager）：
- `findActivePiSessionForWorkspace(workspaceRootPath): string | null` — 在 `this.sessions` 中查找该 workspace 下非销毁的 Pi 后端会话
- `executePromptAutomationsFallback(workspaceId, workspaceRootPath, prompts)` — 复用现有 `onPromptsReady` 逻辑（line 1597-1637）

**前置依赖**：`invokeExtensionCommand` 方法需在 SessionManager 中存在。根据探索，`PiAgent.sendExtensionCommandInvoke` 已存在（`pi-agent.ts:1958-1960`），但 SessionManager 层的 `invokeExtensionCommand` 方法与 RPC 通道可能未完整接通。**若未接通**，本阶段先实现 SessionManager.invokeExtensionCommand 方法（镜像 `sendRemoteUIResponse` 模式，调用 `managed.agent.sendExtensionCommandInvoke`），并在 `session-manager-interface.ts` 增加签名。

**决策**：自动化委托依赖 `invokeExtensionCommand` 桥梁。若该桥梁未完整实现，本阶段将其作为前置子任务一并完成（通道定义、RPC handler、SessionManager 方法）。这是实现「自动化委托给 Pi」的必要基础设施。

#### 5.3 计划模式工具门控

**现状**：根据探索，SubmitPlan 工具已被移除（session-tools-core 中无 SubmitPlan def）。计划模式的接受/执行流程由渲染层 `FreeFormInput.tsx` 通过 `invokeExtensionCommand(sessionId, 'plan-finalize', ...)` 走 Pi 扩展路径（当前为 stub 回退到文本路径）。

**变更**：无需额外工具门控。计划模式已天然委托给 Pi 的 plan-mode 扩展（通过 5.2 的 `invokeExtensionCommand` 桥梁接通后生效）。

**原因**：避免重复造轮子。Pi 的 plan-mode 扩展提供原生计划能力，Craft 仅作为触发壳。

---

### 阶段 6：UI 适配

#### 6.1 会话列表 Pi 会话标识

**文件**：`apps/electron/src/renderer/components/app-shell/SessionItem.tsx`

**变更**：为 `pi-` 前缀会话显示来源标识（小 Pi 图标或 badge），表明该会话来自 Pi CLI：

```typescript
// 在 SessionItem 中，检测 item.id.startsWith('pi-') 时显示 "Pi" badge
{item.id.startsWith('pi-') && (
  <span className="pi-session-badge">Pi</span>
)}
```

**原因**：让用户区分 Craft 会话与 Pi CLI 会话（Pi 会话为只读）。

#### 6.2 Pi 会话只读提示

**文件**：`apps/electron/src/renderer/`（会话视图组件，加载 `pi-` 会话时）

**变更**：当活动会话 id 以 `pi-` 开头时，输入框禁用并显示提示「该会话来自 Pi CLI（只读）。发送消息将创建新会话。」

**原因**：明确 Pi 会话只读语义，引导用户发新消息创建新会话。

#### 6.3 Agent 身份显示（最小改动）

**现状**：`getPiShellFullPassthrough()` 为 true 时，system prompt 已使用 Pi 原生（阶段 1 完成）。Agent 在对话中会自称为 Pi（由 Pi 原生 prompt 决定）。

**决策**：**不改动**窗口标题、HTML title、provider label 等 UI 字面量。原因：
- 窗口标题 `window-manager.ts:162-189` 显示 app 名「Craft Agents」— 这是产品壳标识，保留合理（Craft 是壳，Pi 是内核）
- 系统通知 `useNotifications.ts:232`「Craft Agent has a new message」— 壳层通知，保留
- 对话内 Agent 自称由 system prompt 决定，已透传为 Pi

**原因**：保持 Craft 作为产品外壳的品牌一致性，Pi 身份体现在对话内容中而非 UI chrome。避免大面积字面量改动。

---

## 假设与决策

1. **Pi 会话只读**：Pi CLI 会话在 Craft 中为只读视图。发新消息创建新 Craft 会话（走 Pi 后端 + Pi 原生身份）。避免双向写回 Pi 会话文件的复杂性。

2. **凭证同步方向**：Pi `auth.json` → Craft `credentials.enc`（单向同步），`getPiAuth()` 不变。保持运行时单一凭证源。

3. **slug 约定一致**：Pi provider key → `pi-<key>` slug，与 `pi-global-sync.ts` 现有约定一致，确保 `getPiAuth()` 能按 slug 查找。

4. **自动化委托依赖 invokeExtensionCommand 桥梁**：若桥梁未接通，阶段 5 一并实现（通道、RPC handler、SessionManager 方法）。

5. **UI 身份最小改动**：窗口标题/通知保留「Craft Agents」作为产品壳标识；Agent 对话自称由 Pi 原生 prompt 决定（已透传）。

6. **回滚开关**：所有行为由 `piShell.fullPassthrough` 门控。设为 `false` 即回退到 Craft 独立身份模式。

---

## 验证步骤

1. **类型检查**：`bun run typecheck:all` — 验证新增导出、RPC handler、SessionManager 方法无类型错误
2. **主进程构建**：`bun run electron:build:main` — 验证 server-core 改动编译通过
3. **会话列表**：启动应用，确认 Pi CLI 会话（`~/.pi/agent/sessions/`）出现在会话列表，带 `pi-` 前缀与 Pi badge
4. **Pi 会话加载**：点击 Pi 会话，确认消息加载（只读），输入框显示只读提示
5. **技能共用**：确认 `~/.pi/agent/skills/` 下技能出现在技能列表（阶段 2 已完成，回归验证）
6. **凭证同步**：在 Pi CLI 登录 OAuth provider 后重启 Craft，确认该 provider 连接显示已认证（`LIST_WITH_STATUS` 的 `isAuthenticated` 为 true）
7. **自动化委托**：配置 automation + prompt action，触发后确认日志显示 `[Automations] Delegating N prompt(s) to pi prompt-automation`
8. **回滚验证**：设 `piShell.fullPassthrough=false`，确认 Craft 回退独立身份（system prompt 恢复 Craft persona，Pi 会话不合并）
9. **现有测试**：`bun test` — 确认无回归

---

## 文件变更汇总

| 文件 | 变更 | 阶段 |
|------|------|------|
| `packages/shared/src/sessions/index.ts` | 导出 `listPiCliSessions`、`listPiProjectSessions` | 3.1 |
| `packages/server-core/src/handlers/rpc/sessions.ts` | sessions.GET 合并 Pi 会话；GET_MESSAGES 支持 pi- 会话加载 | 3.2, 3.3 |
| `packages/shared/src/sessions/storage.ts` | 新增 `loadPiSessionMessages`、`findPiSessionFile` | 3.3 |
| `packages/shared/src/config/pi-global-config.ts` | 新增 `readPiGlobalAuth` + 类型 | 4.1 |
| `packages/server-core/src/handlers/rpc/pi-global-sync.ts` | 同步 auth.json OAuth/iam 凭证到 credentials.enc | 4.2 |
| `packages/shared/src/config/storage.ts` | `getPiExtensionsDelegatePromptAutomation` passthrough 下默认 true | 5.1 |
| `packages/server-core/src/sessions/SessionManager.ts` | 实现 `onDelegatePrompts` + `invokeExtensionCommand` + 辅助方法 | 5.2 |
| `packages/server-core/src/handlers/session-manager-interface.ts` | 增加 `invokeExtensionCommand` 签名（若缺失） | 5.2 |
| `apps/electron/src/renderer/components/app-shell/SessionItem.tsx` | Pi 会话 badge | 6.1 |
| 渲染层会话视图组件 | Pi 会话只读提示 | 6.2 |

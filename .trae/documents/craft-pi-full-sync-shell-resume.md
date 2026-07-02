# Craft ↔ Pi 完全同步（壳模式）—— 续作计划

## 摘要

本计划承接上一会话已完成的 Phase 1-3 + Phase 4.1，继续完成剩余阶段：
- **Phase 4.2**：凭证直读 — 同步 Pi `auth.json` 的 OAuth/IAM 凭证到 `credentials.enc`
- **Phase 5.1**：`getPiExtensionsDelegatePromptAutomation` 在透传模式下默认 `true`
- **Phase 5.2**：搭建 `extension_command_invoke` 桥接基础设施（subprocess 侧保持 no-op，保底走 Craft 原生路径）
- **Phase 6.1**：SessionItem 渲染 Pi 会话 badge
- **Phase 6.2**：ChatInputZone 对 Pi 会话显示只读提示
- **验证**：typecheck + electron:build:main + 现有测试

> **Phase 5 范围决策**：经探索发现 Pi 仓库中 `prompt-automation` 扩展尚不存在，且 `pi-agent-server` 子进程的 `extension_command_invoke` 处理器是纯 stub（需 `ExtensionCommandContext`，子进程当前无法获取）。因此 Phase 5.2 采用「搭桥+保底」策略：搭好主进程侧桥接链路，subprocess 侧保持 logged no-op + TODO，实际 automation 仍走 Craft 原生 `onPromptsReady` 保底执行。待 Pi 扩展落地后只需实现 subprocess 侧。

---

## 当前状态分析

### 已完成（上一会话）
- Phase 1（身份透传）：`pi-agent.ts:2067-2078` 透传模式下跳过 Craft system prompt；`pi-agent-server/src/index.ts:1623` 跳过 `applySystemPromptOverride`
- Phase 2（Skill 仓库统一）：`skills/storage.ts` 的 `getActiveSkillsTiers()` / `resolveSkillDir()` 在透传模式下返回 Pi 目录
- Phase 3（会话统一）：Pi CLI 会话以 `pi-` 前缀出现在会话列表；`sessions.GET_MESSAGES` 支持只读加载 Pi 会话消息
- Phase 4.1：`pi-global-config.ts:90-142` 已新增 `PiGlobalAuthCredential` / `PiGlobalAuthFile` 接口与 `readPiGlobalAuth()` 函数

### 待完成（本计划）
- Phase 4.2：`pi-global-sync.ts` 当前仅同步 `provider.apiKey`（行 207-218），未读取 `auth.json` 的 OAuth/IAM 凭证
- Phase 5.1：`storage.ts:594-601` 的 `getPiExtensionsDelegatePromptAutomation()` 默认 `false`，未考虑透传模式
- Phase 5.2：`onDelegatePrompts` 在 `SessionManager.ts:1588-1596` 是纯日志 stub；`extension_command_invoke` 桥接链路有 6 处缺口
- Phase 6：SessionItem 无 Pi 会话标识；ChatInputZone 对 Pi 只读会话无提示

---

## 拟定变更

### Phase 4.2：凭证直读 — 同步 auth.json OAuth/IAM

**文件**：`packages/server-core/src/handlers/rpc/pi-global-sync.ts`

**变更**：
1. 在 imports（行 31-36）中添加 `readPiGlobalAuth`：
   ```typescript
   import {
     readPiGlobalProviders,
     readPiGlobalSettings,
     readPiGlobalAuth,
     setPiGlobalDefault,
     type PiGlobalProvider,
   } from '@craft-agent/shared/config'
   ```
2. 在现有 apiKey 同步块之后（行 218 `}` 之后、行 219 `// Clean credentials for removed slugs` 之前），插入 OAuth/IAM 同步：
   ```typescript
   // 同步 OAuth / IAM 凭证从 ~/.pi/agent/auth.json
   const piAuth = readPiGlobalAuth()
   if (piAuth?.providers) {
     for (const [key, cred] of Object.entries(piAuth.providers)) {
       const slug = `${PI_SYNCED_PREFIX}${key}`
       try {
         if (cred.type === 'oauth' && cred.access) {
           writes.push(
             credentialManager.setLlmOAuth(slug, {
               accessToken: cred.access,
               refreshToken: cred.refresh,
               expiresAt: cred.expires,
               idToken: cred.idToken,
             }).catch(err => {
               console.error(`[pi-global-sync] Failed to store OAuth for ${slug}:`, err)
             }),
           )
         } else if (cred.type === 'iam' && cred.accessKeyId) {
           writes.push(
             credentialManager.setLlmIamCredentials(slug, {
               accessKeyId: cred.accessKeyId,
               secretAccessKey: cred.secretAccessKey ?? '',
               region: cred.region,
               sessionToken: cred.sessionToken,
             }).catch(err => {
               console.error(`[pi-global-sync] Failed to store IAM for ${slug}:`, err)
             }),
           )
         }
       } catch (e) {
         console.error(`[pi-global-sync] Failed to sync auth.json credential for ${slug}:`, e)
       }
     }
   }
   ```

**原因**：`getPiAuth()`（`pi-agent.ts:637-716`）通过 slug 从 `credentials.enc` 查找凭证。现有同步只覆盖 api_key 类型，OAuth（OpenAI/Codex）和 IAM（AWS Bedrock）凭证丢失，导致 Pi 原生 OAuth provider 在壳模式下无法鉴权。

**验证点**：`credentialManager.setLlmOAuth` 和 `setLlmIamCredentials` 方法已存在于 `manager.ts:378` 和 `:434`，签名匹配。

---

### Phase 5.1：delegatePromptAutomation 透传默认 true

**文件**：`packages/shared/src/config/storage.ts`

**变更**：修改 `getPiExtensionsDelegatePromptAutomation()`（行 594-601），在返回默认值前检查透传模式：
```typescript
export function getPiExtensionsDelegatePromptAutomation(): boolean {
  const config = loadStoredConfig();
  if (config?.piExtensions?.delegatePromptAutomation !== undefined) {
    return config.piExtensions.delegatePromptAutomation;
  }
  // 透传（壳）模式下默认委托给 Pi 扩展；否则默认 false
  if (getPiShellFullPassthrough()) {
    return true;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.piExtensions?.delegatePromptAutomation ?? false;
}
```

需在同一文件确认 `getPiShellFullPassthrough` 已导入（行 618 附近已有定义，无需额外导入）。

**原因**：壳模式下 automation 的 prompt 触发应优先委托给 Pi 扩展（与 Pi CLI 行为一致）。用户显式配置 `delegatePromptAutomation` 时仍以用户值为准。

**保底机制**：即使默认 `true`，由于 Phase 5.2 的 subprocess 侧是 no-op，`onDelegatePrompts` 实际会走保底路径（见 5.2），不会丢失 automation 执行。

---

### Phase 5.2：搭建 extension_command_invoke 桥接基础设施

> 采用「搭桥+保底」：搭好主进程侧链路，subprocess 侧保持 no-op，`onDelegatePrompts` 失败时自动回退到 `onPromptsReady`。

#### 5.2.1 新增 RPC channel

**文件**：`packages/shared/src/protocol/channels.ts`（行 312-317 `extensions` 块）

**变更**：添加 `COMMAND_INVOKE`：
```typescript
extensions: {
  EVENT: 'extensions:event',
  REMOTEUI_REQUEST: 'extensions:remoteuiRequest',
  REMOTEUI_RESPONSE: 'extensions:remoteuiResponse',
  COMMAND_REGISTERED: 'extensions:commandRegistered',
  COMMAND_INVOKE: 'extensions:commandInvoke',
},
```

#### 5.2.2 路由允许列表

**文件**：`packages/shared/src/protocol/routing.ts`（行 447-451 附近）

**变更**：在 extensions 路由列表中添加 `extensions.COMMAND_INVOKE`，与现有 4 个 channel 并列。

#### 5.2.3 SessionManager 接口签名

**文件**：`packages/server-core/src/handlers/session-manager-interface.ts`（行 118-128 `sendRemoteUIResponse` 附近）

**变更**：添加 `invokeExtensionCommand` 方法签名，镜像 `sendRemoteUIResponse` 的形状：
```typescript
invokeExtensionCommand(
  sessionId: string,
  commandId: string,
  args?: string,
): boolean;
```

#### 5.2.4 SessionManager 实现

**文件**：`packages/server-core/src/sessions/SessionManager.ts`

**变更 A**：新增 `invokeExtensionCommand` 方法（在 `sendRemoteUIResponse` 方法附近，行 6536-6555 之后），镜像其访问模式：
```typescript
invokeExtensionCommand(sessionId: string, commandId: string, args?: string): boolean {
  const managed = this.sessions.get(sessionId)
  if (managed?.agent) {
    if (typeof managed.agent.sendExtensionCommandInvoke !== 'function') {
      sessionLog.warn(`[ExtensionBridge] Agent does not support sendExtensionCommandInvoke (session: ${sessionId})`)
      return false
    }
    managed.agent.sendExtensionCommandInvoke(commandId, args)
    return true
  }
  sessionLog.warn(`[ExtensionBridge] No active agent for session ${sessionId}`)
  return false
}
```

**变更 B**：实现 `onDelegatePrompts` 回调（替换行 1588-1596 的 stub），委托给扩展命令，失败时保底走原生 `executePromptAutomation`：
```typescript
onDelegatePrompts: async (prompts) => {
  sessionLog.info(`[Automations] Delegating ${prompts.length} prompt(s) to pi prompt-automation extension`)
  // 查找当前 workspace 下一个活跃的 Pi 会话作为命令执行载体
  const delegateSession = this.findActivePiSessionForWorkspace(workspaceRootPath)
  if (!delegateSession) {
    sessionLog.warn(`[Automations] No active Pi session for workspace ${workspaceRootPath}, falling back to native execution`)
    // 保底：走原生 onPromptsReady 路径
    await this.executePromptsNative(workspaceId, workspaceRootPath, prompts)
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
    const ok = this.invokeExtensionCommand(delegateSession, 'prompt-automation', `run ${args}`)
    if (!ok) {
      sessionLog.warn(`[Automations] Extension invoke failed for prompt, falling back to native execution`)
      await this.executePromptsNative(workspaceId, workspaceRootPath, [pending])
    }
  }
},
```

**变更 C**：新增辅助方法 `findActivePiSessionForWorkspace` 和 `executePromptsNative`：
```typescript
/** 查找 workspace 下首个活跃的 Pi 会话 ID（用于 extension 命令委托载体） */
private findActivePiSessionForWorkspace(workspaceRootPath: string): string | null {
  for (const [sessionId, managed] of this.sessions) {
    if (
      managed.workspace.rootPath === workspaceRootPath &&
      !managed.isDestroyed &&
      !managed.isProcessing &&
      managed.agent
    ) {
      return sessionId
    }
  }
  return null
}

/** 保底路径：原生执行 prompt automation（从 onPromptsReady 逻辑提取） */
private async executePromptsNative(
  workspaceId: string,
  workspaceRootPath: string,
  prompts: PendingPrompt[],
): Promise<void> {
  await Promise.allSettled(
    prompts.map((pending) =>
      this.executePromptAutomation({
        workspaceId,
        workspaceRootPath,
        prompt: pending.prompt,
        labels: pending.labels,
        permissionMode: pending.permissionMode,
        mentions: pending.mentions,
        llmConnection: pending.llmConnection,
        model: pending.model,
        thinkingLevel: pending.thinkingLevel,
        automationName: pending.automationName,
        telegramTopic: pending.telegramTopic,
      }),
    ),
  )
}
```

> 注：`onPromptsReady`（行 1597-1638）原有逻辑保持不变，仅在 `delegatePromptAutomation=false` 或 `onDelegatePrompts` 保底时使用。需确认 `PendingPrompt` 类型已导入（来自 `@craft-agent/shared/automations/types`）。

#### 5.2.5 RPC handler 接线

**文件**：`packages/server-core/src/handlers/rpc/sessions.ts`（行 345-349 `extensions.REMOTEUI_RESPONSE` handler 附近）

**变更**：添加 `extensions.COMMAND_INVOKE` handler：
```typescript
server.handle(RPC_CHANNELS.extensions.COMMAND_INVOKE, async (req) => {
  const { sessionId, commandId, args } = req.payload as {
    sessionId: string
    commandId: string
    args?: string
  }
  return sessionManager.invokeExtensionCommand(sessionId, commandId, args)
})
```

需在 `HANDLED_CHANNELS` 数组（行 107 附近）添加 `RPC_CHANNELS.extensions.COMMAND_INVOKE`。

#### 5.2.6 Subprocess 侧（保持 no-op，更新注释）

**文件**：`packages/pi-agent-server/src/index.ts`（行 2089-2093）

**变更**：更新注释，明确保底策略与后续实现方向：
```typescript
case 'extension_command_invoke':
  // 搭桥已就绪：主进程 → PiAgent.sendExtensionCommandInvoke → 本处理器。
  // 完整命令调用需要 ExtensionCommandContext，pi-agent-server 子进程当前
  // 无法直接获取该上下文。当前为 no-op，主进程侧 onDelegatePrompts 检测到
  // invoke 返回 false 时自动回退到 Craft 原生 executePromptAutomation。
  // TODO(pi-extensions): 待 Pi prompt-automation 扩展落地后，通过 SDK 命令
  // 注册表路由实现真正的命令执行。
  debugLog(`[extension-bridge] extension_command_invoke received (commandId: ${msg.commandId}) — no-op, caller will fall back to native execution`);
  break;
```

**原因**：搭桥让链路完整可观测，未来扩展落地时只需实现 subprocess 侧一处。保底机制确保 automation 不丢失执行。

---

### Phase 6.1：SessionItem Pi 会话 badge

**文件**：`apps/electron/src/renderer/components/app-shell/SessionItem.tsx`

**变更**：在 `SessionItem` 组件中（行 240 `badges={...}` 附近），检测 `item.id.startsWith('pi-')` 并渲染 Pi badge。

在组件内部（行 62 附近 `const title = ...` 之后）添加：
```typescript
const isPiSession = item.id.startsWith('pi-')
```

在 badges 渲染处（行 240 附近），合并 Pi badge：
```tsx
badges={
  <>
    {isPiSession && (
      <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-purple-500/10 text-purple-600 dark:bg-purple-400/15 dark:text-purple-300">
        Pi
      </span>
    )}
    {hasLabels ? <SessionBadges item={item} /> : undefined}
  </>
}
```

> 需确认 `badges` prop 接受 `ReactNode`（从 `EntityRow` 组件 prop 类型推断，通常为 `ReactNode`）。若类型不匹配，需调整为 `<>{...}</>` fragment 包裹。

**原因**：用户需在会话列表区分 Craft 原生会话与 Pi 只读会话。

---

### Phase 6.2：ChatInputZone Pi 会话只读提示

**文件**：`apps/electron/src/renderer/components/app-shell/input/ChatInputZone.tsx`

**变更**：在组件顶部（行 50 函数体开始处）检测 Pi 只读会话，渲染提示横幅并禁用输入：

在 `const inputResetKey = ...`（行 53）之后添加：
```typescript
const isPiReadOnlySession = sessionId.startsWith('pi-')
```

在 `return` 的 JSX 中（`InputContainer` 渲染之前），条件渲染只读提示：
```tsx
{isPiReadOnlySession && (
  <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
    此会话来自 Pi CLI（只读）。发送消息将创建新的 Craft 会话。
  </div>
)}
```

并将 `InputContainer` 包裹在 `{!isPiReadOnlySession && (...)}` 中，或通过 `inputProps` 传 `disabled` 禁用输入。

> **简化方案**（推荐）：不禁用输入框，仅显示提示横幅。用户发送消息时，`sessions.SEND_MESSAGE` handler 检测到 `pi-` 前缀会话应创建新会话（此逻辑已在 Phase 3 的会话统一中处理或需确认）。若未处理，则在提示文案中说明"发送消息将创建新的 Craft 会话"即可。

**原因**：Pi 会话是只读视图，需明确告知用户避免困惑。

---

## 假设与决策

1. **Phase 5.2 subprocess 侧保持 no-op**：Pi `prompt-automation` 扩展不存在，subprocess 无法获取 `ExtensionCommandContext`。保底走 Craft 原生 `executePromptAutomation`，automation 不会丢失执行。
2. **命令名约定**：采用 `commandId='prompt-automation'`、`args='run <json>'`（与 spec 草案一致）。扩展落地后需对齐。
3. **Pi 会话只读**：Phase 3 已确立 Pi 会话只读，Phase 6.2 仅添加 UI 提示，不改变后端行为。
4. **`findActivePiSessionForWorkspace` Pi 会话识别**：通过 `managed.agent` 存在性判断（壳模式下所有会话均为 Pi-backed），不额外引入 `isPiSession` 标志。
5. **不改 `getPiAuth()`**：Phase 4.2 通过同步 auth.json 到 `credentials.enc`，让现有 slug 查找路径自动拾取，`getPiAuth()` 本身无需改动。

---

## 验证步骤

1. **类型检查**：
   ```bash
   bun run typecheck:all
   ```
2. **Electron 主进程编译**（server-core 改动需要）：
   ```bash
   bun run electron:build:main
   ```
3. **现有测试**：
   ```bash
   bun test
   ```
   重点关注 `ipc-channels.test.ts`（Phase 5.2 新增 channel 需补测试，若该测试文件有 channel 完整性校验）。
4. **手动验证**（可选，用户侧）：
   - 启动应用，确认 `~/.pi/agent/auth.json` 中的 OAuth provider 在 AiSettingsPage 显示已鉴权
   - 确认 Pi CLI 会话在会话列表显示 Pi badge，点击查看消息显示只读提示
   - 触发 automation prompt，确认日志显示委托尝试 + 保底执行

# Craft 退化为 Pi 薄壳与增强回流 Spec

## Why

当前 craft 对 pi 的使用是"直接使用 + 复制"双轨：Pi SDK 运行时通过子进程直接复用，但扩展代码、配置数据、凭证靠物理复制 + 正则 patch 维护（`prepareCraftPiExtensionAgentDir` + `patchRuntimeDefaults`）。这导致 `~/.pi/agent` 与 `~/.craft-agent/pi-extensions` 双目录并存，craft 既要复用 pi 实现又要注入自己的模型默认值与路径，形成维护负担和行为漂移风险。

用户要求保证**唯一目录**（`~/.pi/agent` 为单一 SoT），并让双方矛盾点"互相学习、互相结合"——craft 的通用增强回流 pi，pi 缺失的契约补齐，craft 退化为薄壳。

## What Changes

### 消除复制层（唯一目录）
- **BREAKING**：废弃 `~/.craft-agent/pi-extensions` 目录，`agentDir` 始终指向 `~/.pi/agent`
- **BREAKING**：删除 `prepareCraftPiExtensionAgentDir` + `patchRuntimeDefaults`（整个复制 + patch 层）
- `pi-global-sync.ts` 从"文件复制同步"退化为"thin wrapper"，craft UI 直接读写 `~/.pi/agent/models.json`
- `credentials.enc` 不再存 `pi-*` 凭证，`CredentialManager` 对 pi 连接透传 `~/.pi/agent/auth.json`

### craft 增强回流 pi（Pi 上游改动，craft 删除对应 patch）
- pi repo 吸收 repo-memory 的 `stop` 命令 + `manualUpdateController`
- pi settings.json 新增扩展命名空间配置：`extensions.<name>.{model,enabled,concurrency,...}`
- pi SDK 提供 `createHeadlessUIContext(transport)` 官方实现（替代 craft 的 `createBridgeUIContext` + `stubTheme`）

### craft 退化为薄壳
- `pi-extension-settings.ts` 只保留 GUI 开关类字段（`showStatusBadge`/`widgetVisible`/`planMode.*`/`delegatePromptAutomation`/`managedAgentDir`）
- `createBridgeUIContext` 从 ~100 行缩到 ~10 行（调用 pi 官方 `createHeadlessUIContext`）
- 移除 craft 的 `call_llm`（pi 不再原生提供，craft 也不再需要——经评估该工具意义不大，双方均不保留）

### 保留 craft 独有（不变）
- GUI 渲染层（6 组件 + 2 hook，复用 pi UI 契约但渲染独立）
- GUI 主题（15 个 JSON，与 pi TUI themes 不同维度）
- `AutomationSystem`（事件驱动自动化，与 pi prompt-automation 的对话流 cron 注入不冲突，并存）
- `spawn_session`（会话级并行，与 pi subagent 的任务级并行正交）
- `browser_tool`（强依赖 Electron，pi 无法承载）
- OAuth 集成工具（`source_oauth_trigger` 等，与 craft source 管理深度绑定）

## Impact

- **Affected specs**: `pi-first-integration`（前一阶段建立桥接，本阶段在其基础上消除复制层）
- **Affected code（craft-agent 仓库内）**:
  - `packages/shared/src/config/pi-extension-runtime.ts`（**删除** `prepareCraftPiExtensionAgentDir`、`patchRuntimeDefaults`、`syncSupportingResources`）
  - `packages/shared/src/config/pi-extension-settings.ts`（**瘦身**：移除 `subagent/traceAudit/yourself/repoMemory` 的 model 字段、`extensions.*.enabled` 字段、`webSearch`、`ambiguityDictionary`）
  - `packages/shared/src/config/pi-global-config.ts`（**增强**：支持读写 `extensions.<name>.*` 命名空间）
  - `packages/server-core/src/handlers/rpc/pi-global-sync.ts`（**简化**：退化为 thin wrapper，不再写 `credentials.enc` 的 pi 凭证）
  - `packages/shared/src/agent/pi-agent.ts`（**简化**：`agentDir` 恒指 `~/.pi/agent`，移除 `prepareCraftPiExtensionAgentDir` 调用）
  - `packages/pi-agent-server/src/index.ts`（**瘦身**：`createBridgeUIContext` 改用 pi 官方 `createHeadlessUIContext`）
  - `packages/session-tools-core/src/tool-defs.ts`（**移除** `call_llm` 定义，pi 接管）
  - `packages/shared/src/agent/backend/internal/drivers/pi.ts`（**简化**：`pi_compat` 的 customEndpoint/customModels 从 pi 文件读取，非 craft config）
  - `apps/electron/src/renderer/`（UI 适配：设置页直接读写 `~/.pi/agent`，移除 craft 独立的扩展 model 配置 UI）
- **Affected Pi 上游（外部 PR，craft 仓库外）**:
  - pi repo `extensions/repo-memory/index.ts`（吸收 stop + manualUpdateController）
  - pi repo `settings.json` schema（新增 `extensions.<name>.*` 命名空间）
  - pi SDK（新增 `createHeadlessUIContext`）

## ADDED Requirements

### Requirement: Pi settings.json 扩展命名空间配置

Pi 的 `~/.pi/agent/settings.json` SHALL 原生支持 `extensions.<name>` 命名空间配置，包括 `model`、`enabled`、`concurrency` 等字段，使扩展级配置不再需要 craft patch 注入。

#### Scenario: 扩展 model 配置读取
- **WHEN** repo-memory 扩展启动需要 `MEMORY_GENERATOR_MODEL`
- **THEN** 扩展从 `settings.json` 的 `extensions.repo-memory.model` 读取
- **AND** 字段缺失时使用扩展内置默认值
- **AND** craft 不再通过 `CRAFT_PI_REPO_MEMORY_MODEL` 环境变量注入

#### Scenario: 扩展 enabled 开关
- **WHEN** 用户在 craft 设置页禁用某个 pi 扩展
- **THEN** craft 写入 `settings.json` 的 `extensions.<name>.enabled = false`
- **AND** Pi SDK 的 `DefaultResourceLoader` 加载时跳过 disabled 扩展
- **AND** craft 不再维护独立的 `pi-extension-settings.extensions` 列表

#### Scenario: subagent 路径常量
- **WHEN** subagent 扩展运行需要 supervisor/runs/background-manager 路径
- **THEN** 路径基于 `~/.pi/agent/extensions/subagent/` 解析（pi 原生约定）
- **AND** craft 不再通过 `PI_SUBAGENT_SUPERVISOR_ROOT` 等环境变量覆盖

### Requirement: Pi 原生 repo-memory stop 命令

Pi 的 repo-memory 扩展 SHALL 支持 `stop` 命令，中止后台更新控制器和手动更新控制器，并清理 UI 状态。

#### Scenario: stop 命令执行
- **WHEN** 用户执行 `repo-memory stop`
- **THEN** 扩展中止 `backgroundController` 和 `manualUpdateController`
- **AND** 清理控制器引用
- **AND** 通过 `createRepoMemoryUi(ctx, () => true).setStatus(undefined)` 清状态
- **AND** `ctx.ui.notify("Repo memory stop requested", "warning")` 通知用户

#### Scenario: manualUpdateController 独立中止
- **WHEN** 手动触发 repo-memory 更新
- **THEN** 使用独立的 `manualUpdateController`，不影响后台控制器
- **AND** 更新完成后在 `finally` 中清理 `manualUpdateController` 引用

### Requirement: Pi SDK Headless UIContext

Pi SDK SHALL 提供 `createHeadlessUIContext(transport)` 工厂函数，封装非 TUI 环境（RPC/子进程）下的 `ExtensionUIContext` 实现，包括 JSONL 转发、`stubTheme` 降级、`remoteui:request` 协议。

#### Scenario: headless UIContext 注入
- **WHEN** pi-agent-server 子进程创建会话且无 TUI
- **THEN** 调用 `createHeadlessUIContext({ send, onRemoteUI })` 创建 UIContext
- **AND** 通过 `session.extensionRunner.setUIContext(headlessCtx, 'rpc')` 注入
- **AND** `notify`/`setWidget` 经 transport 转发到主进程
- **AND** `select`/`confirm`/`input`/`editor` 经 `remoteui:request` 协议桥接
- **AND** TUI 专有方法（`setStatus`/`setFooter`/`pasteToEditor` 等）为 no-op

## MODIFIED Requirements

### Requirement: agentDir 解析

`pi-agent-server` 的 `agentDir` SHALL 始终指向 `~/.pi/agent`，不再支持 craft 管理目录覆盖。

#### Scenario: 默认 agentDir
- **WHEN** craft 启动新会话
- **THEN** `initConfig.agentDir` 为 `~/.pi/agent`
- **AND** Pi SDK 加载 `~/.pi/agent/extensions/` 下的扩展（受 `settings.json` 的 `extensions.<name>.enabled` 控制）
- **AND** craft 不再调用 `prepareCraftPiExtensionAgentDir` 复制扩展到 `~/.craft-agent/pi-extensions`

#### Scenario: 显式覆盖（仅测试）
- **WHEN** init 消息传入 `agentDir` 指向临时目录
- **THEN** 系统使用该目录（保留测试覆盖能力）
- **AND** 生产路径永不传入覆盖值

### Requirement: Pi 配置同步

`pi-global-sync.ts` SHALL 退化为 thin wrapper——craft UI 直接读写 `~/.pi/agent/models.json`，不再维护 craft config 的 `pi-*` 连接副本。

#### Scenario: provider 列表读取
- **WHEN** craft UI（AiSettingsPage、CompactModelSelector）需要 provider 列表
- **THEN** 直接读 `~/.pi/agent/models.json`
- **AND** 不再从 `config.llmConnections` 的 `pi-*` 条目读取

#### Scenario: provider 增删改
- **WHEN** 用户在 craft UI 增删改 provider
- **THEN** craft 直接写 `~/.pi/agent/models.json`
- **AND** 不再同步到 `config.llmConnections` 的 `pi-*` 条目

### Requirement: Pi 凭证管理

`CredentialManager` 对 pi 连接 SHALL 透传 `~/.pi/agent/auth.json`，不再在 `credentials.enc` 存储 `pi-*` 凭证。

#### Scenario: 凭证读取
- **WHEN** pi-agent-server 子进程需要 provider 凭证
- **THEN** 从 `~/.pi/agent/auth.json` 读取（apiKey/OAuth/IAM）
- **AND** 不再从 `credentials.enc` 读取 `pi-*` 凭证

#### Scenario: 凭证写入
- **WHEN** 用户在 craft UI 配置 provider 凭证
- **THEN** craft 写 `~/.pi/agent/auth.json`
- **AND** 不再写 `credentials.enc` 的 `pi-*` 凭证

### Requirement: ExtensionUIContext 桥接

`createBridgeUIContext` SHALL 改用 pi 官方 `createHeadlessUIContext`，从 ~100 行自实现缩到 ~10 行调用。

#### Scenario: 桥接初始化
- **WHEN** pi-agent-server 创建会话
- **THEN** 调用 `createHeadlessUIContext({ send, onRemoteUI })`
- **AND** 不再自实现 `stubTheme`、`notify`/`setWidget` 转发、`select`/`confirm` 降级
- **AND** 保留 craft 专属的 transport 适配（JSONL over stdio）

### Requirement: Pi 扩展设置瘦身

`pi-extension-settings.ts` SHALL 只保留 GUI 开关类字段，model/enabled/webSearch/ambiguityDictionary 字段回归 pi settings.json。

#### Scenario: 保留的 GUI 字段
- **WHEN** craft 读取 pi-extension-settings
- **THEN** 保留 `delegatePromptAutomation`、`managedAgentDir`、`subagent.reviewEnabled`/`reviewModel`、`traceAudit.reviewSubagentEnabled`/`showStatusBadge`、`yourself.showStatusBadge`、`repoMemory.showStatusBadge`、`promptAutomation.widgetVisible`/`defaultJobScope`、`planMode.*`
- **AND** 这些字段是 craft GUI 专属，pi settings.json 无对应概念

#### Scenario: 移除的配置字段
- **WHEN** craft 需要配置 repo-memory 的 model
- **THEN** 写入 `~/.pi/agent/settings.json` 的 `extensions.repo-memory.model`
- **AND** 不再读写 `pi-extension-settings.repoMemory.model`
- **AND** 同理处理 `yourself.model`、`traceAudit.defaultModel`/`concurrency`、`subagent.defaultModel`、`extensions.*.enabled`、`webSearch.*`、`ambiguityDictionary.*`

## REMOVED Requirements

### Requirement: prepareCraftPiExtensionAgentDir + patchRuntimeDefaults
**Reason**: 唯一目录要求下，扩展代码直接从 `~/.pi/agent` 加载，复制 + patch 层失去存在意义。patch 注入的配置（model、路径常量）回归 pi settings.json 或 pi 原生约定。
**Migration**:
- 删除 `packages/shared/src/config/pi-extension-runtime.ts` 的 `prepareCraftPiExtensionAgentDir`、`patchRuntimeDefaults`、`syncSupportingResources`、`getPiExtensionRuntimeEnv`
- `pi-agent.ts` 的 `agentDir` 分支简化为始终用 `~/.pi/agent`
- patch 注入的 model 配置迁移到 pi settings.json 命名空间（前置依赖：pi 支持 `extensions.<name>.model`）
- patch 改写的 subagent 路径常量回归 pi 原生 `~/.pi/agent/...`（前置依赖：pi settings.json 支持 enabled 开关）
- repo-memory stop 命令迁移到 pi 原生（前置依赖：pi 吸收 stop + manualUpdateController）

### Requirement: credentials.enc 中的 pi-* 凭证
**Reason**: pi 凭证的 SoT 应为 `~/.pi/agent/auth.json`，craft 维护副本导致双写和漂移。
**Migration**:
- `pi-global-sync.ts` 移除 `credentialManager.setLlmApiKey`/`setLlmOAuth`/`setLlmIamCredentials` 对 `pi-*` slug 的调用
- `CredentialManager` 对 `pi-*` 连接透传 `~/.pi/agent/auth.json`
- 迁移期：首次启动时将 `credentials.enc` 中的 pi 凭证导出到 `~/.pi/agent/auth.json`（若 auth.json 缺失），然后删除 credentials.enc 中的 pi 条目

### Requirement: call_llm 工具（craft 与 pi 双方移除）
**Reason**: 经评估 call_llm 工具意义不大，pi 不再原生提供，craft 也不再自实现。双方均不保留。
**Migration**:
- craft 侧已完成：从 `packages/session-tools-core/src/tool-defs.ts` 的 `SESSION_TOOL_DEFS` 移除 `call_llm`，移除 pi-agent 的 call_llm backend 适配代码
- pi 侧待执行：删除 `~/.pi/agent/extensions/call-llm/` 目录（前期作为 Task 4 创建，现已废弃）
- 保留 `spawn_session`、`browser_tool` 等 craft 独有工具不变

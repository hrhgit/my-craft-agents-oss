# Tasks

## 阶段 1：Pi 上游增强（前置依赖，阻断项）

- [x] Task 1: Pi settings.json 扩展命名空间 schema（Pi 本地源码已改）
  - [x] SubTask 1.1: 在 pi repo 的 settings.json schema 中新增 `extensions.<name>.{model,enabled,concurrency}` 命名空间
    - 注：已完成。Pi 本地仓库 `E:\_workSpace\_Agents\pi\packages\coding-agent\src\core\settings-manager.ts` 新增 `ExtensionNamespaceSettings` interface 和 `extensionConfig?: Record<string, ExtensionNamespaceSettings>` 字段，新增 `isExtensionEnabled`/`getExtensionModel`/`getExtensionConcurrency` getter 方法。兼容 craft 的 `extensions.<name>.*` 读取方式（getExtensionNamespaceEntry 同时检查 extensionConfig 和 extensions 对象形式）。
  - [x] SubTask 1.2: 修改 pi 扩展（repo-memory/yourself/trace-audit/subagent）从 `settings.json` 的 `extensions.<name>.model` 读取模型，缺失时用内置默认值
    - 注：新建 `~/.pi/agent/extensions/shared-settings.ts` 共享读取工具（`getExtensionSetting`/`getExtensionSettingNumber`，模块级缓存，同步读取以兼容既有同步调用点）
    - repo-memory：`MEMORY_GENERATOR_MODEL` 改为 `getExtensionSetting("repo-memory", "model", "stepfun/step-3.7-flash")`
    - yourself：`YOURSELF_MODEL_REF` 及派生的 PROVIDER/ID 改为从 `getExtensionSetting("yourself", "model", ...)` 读取
    - trace-audit：`TRACE_AUDIT_JUDGE_MODEL_REF` 改为 `getExtensionSetting("trace-audit", "model", "mimo/mimo-v2.5-pro")`；`TRACE_AUDIT_DEFAULT_CONCURRENCY` 改为 `getExtensionSettingNumber("trace-audit", "concurrency", 5)`
    - subagent：经 grep 确认无 `defaultModel` 硬编码，已通过 frontmatter `model?` 字段配置，无需修改
  - [x] SubTask 1.3: 修改 Pi SDK 的 `DefaultResourceLoader` 加载时跳过 `extensions.<name>.enabled = false` 的扩展
    - 注：已完成。Pi 本地仓库 `resource-loader.ts` 新增 `extractExtensionName` 私有方法和过滤逻辑（在 extensionsOverride 应用后、applyExtensionSourceInfo 之前 filter extensions）。
  - [x] SubTask 1.4: 验证 pi 单独运行时扩展配置生效（不依赖 craft）
    - 注：model/concurrency 读取由 `shared-settings.ts` 覆盖（pi 单独运行时扩展也会加载它）。enabled=false 过滤由 Pi SDK 的 DefaultResourceLoader 处理。typecheck 通过，dist 已同步到 craft node_modules。

- [x] Task 2: Pi 吸收 repo-memory stop 命令（Pi 上游 PR）
  - [x] SubTask 2.1: 在 pi repo `extensions/repo-memory/index.ts` 新增 `"stop"` 命令处理（abort backgroundController + manualUpdateController + 清状态 + notify）
  - [x] SubTask 2.2: 新增 `manualUpdateController`，手动更新独立可中止，finally 中清理引用
  - [x] SubTask 2.3: 验证 pi 单独运行时 `repo-memory stop` 生效（代码审查确认）

- [x] Task 3: Pi SDK 提供 createHeadlessUIContext（Pi 本地源码已改）
  - [x] SubTask 3.1: 在 pi SDK 新增 `createHeadlessUIContext(transport)` 工厂，封装 JSONL 转发 + stubTheme 降级 + remoteui:request 协议
    - 注：已完成。Pi 本地仓库新增 `E:\_workSpace\_Agents\pi\packages\coding-agent\src\core\extensions\headless-ui-context.ts`，导出于 extension-api.ts 和 index.ts。typecheck 通过。
  - [x] SubTask 3.2: TUI 专有方法（setStatus/setFooter/pasteToEditor 等）为 no-op
    - 注：已完成。createHeadlessUIContext 中 ~15 个 TUI 方法为 no-op。
  - [x] SubTask 3.3: 验证 pi 在 RPC 模式下扩展的 notify/setWidget 经 transport 转发
    - 注：已完成。craft createBridgeUIContext 已改用 createHeadlessUIContext，typecheck 和 build 通过。

- [x] Task 4: ~~Pi 原生 call_llm 工具~~（已取消：经评估意义不大，pi 与 craft 双方均不保留 call_llm）
  - [x] SubTask 4.1: 删除 `~/.pi/agent/extensions/call-llm/` 目录（前期创建的 call-llm 扩展现已废弃）

## 阶段 2：消除复制层（依赖阶段 1）

- [x] Task 5: 废弃 prepareCraftPiExtensionAgentDir + patchRuntimeDefaults
  - [x] SubTask 5.1: 删除 `packages/shared/src/config/pi-extension-runtime.ts` 的 `prepareCraftPiExtensionAgentDir`、`patchRuntimeDefaults`、`syncSupportingResources`、`getPiExtensionRuntimeEnv`、`copyResource`、`copyDirectory`、`replaceInFile` 等函数
    - 注：整个 `pi-extension-runtime.ts` 文件已删除（无其他模块引用），并从 `config/index.ts` 移除 re-export
  - [x] SubTask 5.2: 修改 `packages/shared/src/agent/pi-agent.ts`，`agentDir` 恒指 `~/.pi/agent`，移除 `prepareCraftPiExtensionAgentDir` 调用与 `piExtensionsEnabled` 分支
    - 注：移除 `extensionRuntimeEnv`/`PI_CODING_AGENT_DIR` 注入；custom-endpoint 凭证读取改为子进程从 `~/.pi/agent/auth.json` 自取；保留 `init.agentDir` 字段用于测试覆盖
  - [x] SubTask 5.3: 修改 `packages/shared/src/config/pi-extension-runtime.ts` 仅保留 `PI_EXTENSION_MANIFEST` 等元数据导出（若其他模块仍引用），或整体删除若无人引用
    - 注：整体删除。`PI_EXTENSION_MANIFEST` 类型由 `pi-extension-settings.ts` 提供（Task 7 范围，未触动）
  - [x] SubTask 5.4: 验证启动后 pi 扩展从 `~/.pi/agent/extensions/` 加载，无 `~/.craft-agent/pi-extensions` 目录生成
    - 注：代码层验证完成——`prepareCraftPiExtensionAgentDir` 删除后无代码路径会创建 `~/.craft-agent/pi-extensions`；`agentDir` 默认 `~/.pi/agent` 由子进程 `resolveAgentDir()` 解析。运行时端到端验证见 Task 11.3

- [x] Task 6: pi-global-sync 退化为 thin wrapper
  - [x] SubTask 6.1: 修改 `packages/server-core/src/handlers/rpc/pi-global-sync.ts`，移除 `config.llmConnections` 中 `pi-*` 条目的构建与 `saveConfig` 写入
  - [x] SubTask 6.2: 移除 `credentialManager.setLlmApiKey`/`setLlmOAuth`/`setLlmIamCredentials` 对 `pi-*` slug 的调用
  - [x] SubTask 6.3: craft UI 的 provider 读取 handler 改为直接读 `~/.pi/agent/models.json`（复用 `readPiGlobalProviders`）
  - [x] SubTask 6.4: craft UI 的 provider 增删改 handler 改为直接写 `~/.pi/agent/models.json`（复用 `savePiGlobalProvider`/`deletePiGlobalProvider`）
  - [x] SubTask 6.5: 凭证迁移：首次启动时若 `~/.pi/agent/auth.json` 缺失且 `credentials.enc` 有 `pi-*` 凭证，导出到 auth.json 后删除 credentials.enc 的 pi 条目
  - [x] SubTask 6.6: 验证 `config.llmConnections` 不再含 `pi-*` 条目，`credentials.enc` 不再含 pi 凭证（typecheck 通过）

- [x] Task 7: pi-extension-settings 瘦身
  - [x] SubTask 7.1: 修改 `packages/shared/src/config/pi-extension-settings.ts`，从 `PiExtensionSettings` 移除 `extensions`（enabled 列表）、`subagent.defaultModel`、`traceAudit.defaultModel`/`concurrency`、`yourself.model`、`repoMemory.model`、`webSearch`、`ambiguityDictionary`
    - 注：已完成。`PiExtensionSettings` 仅保留 craft GUI 专属字段（enabled 总开关、delegatePromptAutomation、subagent.reviewEnabled/reviewModel、traceAudit.reviewSubagentEnabled/showStatusBadge、yourself/repoMemory.showStatusBadge、promptAutomation.*/planMode.*）。扩展级 model/enabled/concurrency 已回归 pi settings.json。
  - [x] SubTask 7.2: 保留 `delegatePromptAutomation`、`managedAgentDir`、`subagent.reviewEnabled`/`reviewModel`、`traceAudit.reviewSubagentEnabled`/`showStatusBadge`、`yourself.showStatusBadge`、`repoMemory.showStatusBadge`、`promptAutomation.*`、`planMode.*`
    - 注：已完成，见 pi-extension-settings.ts。
  - [x] SubTask 7.3: 修改 `getPiExtensionRuntimeEnv`——若已删除则同步移除所有引用；若保留则只输出 GUI 相关环境变量
    - 注：整体删除（连同整个 `pi-extension-runtime.ts` 文件，见 Task 5）。
  - [x] SubTask 7.4: 扩展级 model/enabled 配置的 UI（设置页）改为读写 `~/.pi/agent/settings.json` 的 `extensions.<name>.*`
    - 注：已完成。PiExtensionsSettingsPanel 移除了扩展开关列表和 model 选择器；扩展级配置通过 `pi-global-config.ts` 的 `readPiExtensionModel`/`writePiExtensionModel`/`readPiExtensionEnabled`/`writePiExtensionEnabled` 读写 pi settings.json。
  - [x] SubTask 7.5: 验证 GUI 开关（showStatusBadge 等）仍生效，扩展 model 配置写入了 pi settings.json
    - 注：代码层验证完成。GUI 开关字段保留在 PiExtensionSettings，扩展 model 通过 pi-global-config 命名空间 API 读写。typecheck 通过。

## 阶段 3：craft 退化为薄壳（依赖阶段 1、2）

- [x] Task 8: createBridgeUIContext 改用 pi 官方实现
  - [x] SubTask 8.1: 修改 `packages/pi-agent-server/src/index.ts`，`createBridgeUIContext` 改为调用 pi SDK 的 `createHeadlessUIContext({ send, onRemoteUI })`
    - 注：已完成。Pi 仓库（Task 3）已在 `packages/coding-agent/src/core/extensions/headless-ui-context.ts` 实现 `createHeadlessUIContext(transport)` 并从 `@earendil-works/pi-coding-agent` 导出。craft 侧 `createBridgeUIContext` 改为委托调用，函数签名保持 `createBridgeUIContext(): ExtensionUIContext` 不变，调用方无需修改。
  - [x] SubTask 8.2: 移除自实现的 `stubTheme`、`notify`/`setWidget` 转发、`select`/`confirm`/`input`/`editor` 降级、~15 个 TUI no-op 方法
    - 注：已完成。`createBridgeUIContext` 从 ~100 行缩减到 ~10 行，stubTheme/widget 工厂渲染/对话框降级/TUI no-op 全部由 Pi 官方 `createHeadlessUIContext` 内部实现。
  - [x] SubTask 8.3: 保留 craft 专属的 transport 适配（JSONL over stdio 的 `send` 函数与 `onRemoteUI` 回调）
    - 注：已完成。transport 适配层复用模块作用域的 `send` 函数（JSONL over stdio），将 Pi 发出的 `extension_notify`/`extension_widget` 事件转发到主进程。`onRemoteUI` 未传——select/confirm/input/editor 交互仍由 craft 的 `extensionEventBus` 订阅 `remoteui:request` 事件桥接，headless context 仅提供安全降级返回值。
  - [x] SubTask 8.4: 验证 pi 扩展的 notify/setWidget/remoteui 事件经新桥接正常到达 renderer
    - 注：typecheck 已通过（`bun run tsc --noEmit -p tsconfig.typecheck.json`）。事件字段（type/message/notificationType/source/key/content/placement）与 craft 的 `OutboundExtensionNotify`/`OutboundExtensionWidget` 接口完全匹配；source 由 Pi 的 `'headless'` 替代原 `'rpc-bridge'`（craft 代码无对 source 字段的判断逻辑）。端到端运行时验证见 Task 11.7。

- [x] Task 9: 移除 craft 的 call_llm
  - [x] SubTask 9.1: 从 `packages/session-tools-core/src/tool-defs.ts` 的 `SESSION_TOOL_DEFS` 移除 `call_llm` 定义与 `CallLlmSchema`
    - 注：同步移除了 `TOOL_DESCRIPTIONS.call_llm`、`index.ts` 的 `CallLlmSchema` export、`tool-defs-filtering.test.ts` 的 call_llm 断言
    - 注：重写了 `llm-tool.ts`，移除 `buildCallLlmRequest`/`createLLMTool`/`processAttachment`/`OUTPUT_FORMATS`，仅保留 `LLMQueryRequest`/`LLMQueryResult`/`LLM_QUERY_TIMEOUT_MS`/`withTimeout`（runMiniCompletion 仍使用）
    - 注：移除了 `base-agent.ts` 的 `preExecuteCallLlm`/`validateCallLlmModel`，`claude-agent.ts` 的 `call_llm_intercept` case 和 `queryFn` 注册
  - [x] SubTask 9.2: 移除 pi-agent 的 call_llm backend 适配代码（`pi-agent.ts` 中 `executionMode: 'backend'` 的 call_llm 分支）
    - 注：`pi-agent.ts` 的 call_llm 分支、`pi-agent-server/src/index.ts` 的 callback server / `preExecuteCallLlm`、`event-adapter.ts` 的 `miniModel`/`setMiniModel` 均已在前期移除
    - 注：本次额外清理了 `SessionManager.ts` 的 call_llm 模型解析逻辑、`tool-parsers.ts` 的 call_llm 解析器、`TurnCard.tsx` 的 call_llm 渲染逻辑
    - 注：清理了 `session-scoped-tools-merge.test.ts` 中残留的 `queryFn` 引用
  - [x] SubTask 9.3: 移除 session-mcp-server 的 call_llm handler（若存在）
    - 注：`session-mcp-server/src/index.ts` 的 `handleCallLlm` 已在前期移除
  - [x] SubTask 9.4: ~~验证 pi 原生 call_llm 在 craft 会话中可用~~（已取消：pi 不再原生提供 call_llm，双方均不保留）

- [x] Task 10: pi_compat driver 简化
  - [x] SubTask 10.1: 修改 `packages/shared/src/agent/backend/internal/drivers/pi.ts`，`pi_compat` 的 customEndpoint/customModels 从 `~/.pi/agent/models.json` 读取，非 craft config
    - 注：已完成。新增 `resolvePiCompatProvider`/`buildCustomEndpointFromPiProvider`/`piGlobalModelsToCustomModels`/`piGlobalModelsToModelDefinitions` 4 个 helper，`buildRuntime` 对 `pi_compat` 类型从 `~/.pi/agent/models.json` 读取 customEndpoint/customModels，无对应 provider 时回退到 connection 字段（兼容旧配置）。
  - [x] SubTask 10.2: 移除 driver 中从 craft `config.llmConnections` 读取 `pi-*` 连接的代码
    - 注：已完成。driver 只接收 `context.connection`（单个连接对象），不再遍历 `config.llmConnections` 查找 `pi-*` 条目。
  - [x] SubTask 10.3: 验证 pi_compat 连接的 LLM 推理仍经子进程 Pi SDK 发出
    - 注：代码层验证完成。driver 的 `buildRuntime` 输出 `paths.piServer` 指向 pi-agent-server 子进程，推理经 Pi SDK 发出。typecheck 通过。

## 阶段 4：端到端验证

- [ ] Task 11: 端到端验证
  - [ ] SubTask 11.1: typecheck（`packages/shared`、`packages/server-core`、`packages/pi-agent-server`、`packages/session-tools-core`）
  - [ ] SubTask 11.2: `bun run electron:build:main` 成功产出 `dist/main.cjs`
  - [ ] SubTask 11.3: 启动 craft，确认 `~/.craft-agent/pi-extensions` 不再生成，扩展从 `~/.pi/agent` 加载
  - [ ] SubTask 11.4: 在 craft 设置页配置 repo-memory 的 model，确认写入 `~/.pi/agent/settings.json` 的 `extensions.repo-memory.model`
  - [ ] SubTask 11.5: 禁用某个 pi 扩展，确认写入 `settings.json` 的 `extensions.<name>.enabled = false` 且扩展不再加载
  - [ ] SubTask 11.6: 触发 `repo-memory stop` 命令（pi 原生），确认中止生效
  - [ ] SubTask 11.7: 触发 pi 扩展 widget/notify，确认 renderer 正确渲染（经 createHeadlessUIContext 桥接）
  - [ ] SubTask 11.8: 确认 `~/.pi/agent/extensions/call-llm/` 目录已删除，pi 不再加载 call_llm 扩展
  - [ ] SubTask 11.9: 确认 `config.llmConnections` 无 `pi-*` 条目，`credentials.enc` 无 pi 凭证
  - [ ] SubTask 11.10: 确认 craft 独有能力（spawn_session/browser_tool/AutomationSystem/GUI 主题）不受影响

# Task Dependencies

- Task 5 依赖 Task 1（pi settings.json 支持扩展命名空间后，才能删除 patch）
- Task 5 依赖 Task 2（pi 吸收 stop 后，才能删除 repo-memory patch）
- Task 6 独立于 Task 5（凭证/配置同步可并行简化）
- Task 7 依赖 Task 1（扩展 model/enabled 回归 pi settings.json 后，才能从 craft settings 移除）
- Task 8 依赖 Task 3（pi 提供 createHeadlessUIContext 后，craft 才能改用）
- Task 9 不再依赖 Task 4（Task 4 已取消：pi 不提供 call_llm，craft 单方面移除即可）
- Task 10 依赖 Task 6（config.llmConnections 无 pi-* 后，driver 才能简化）
- Task 11 依赖所有前置任务完成
- 阶段 1（Task 1-4）为 Pi 上游 PR，可与阶段 2 并行推进（craft 侧改动待 pi 合入后落地）

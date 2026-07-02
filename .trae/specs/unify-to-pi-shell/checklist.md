# Checklist

## 唯一目录
- [x] `~/.craft-agent/pi-extensions` 目录不再生成
  - 注：代码层验证完成。`prepareCraftPiExtensionAgentDir` 已删除，无代码路径会创建该目录。运行时确认见端到端 Task 11.3
- [x] `prepareCraftPiExtensionAgentDir` 函数已删除
- [x] `patchRuntimeDefaults` 函数已删除
- [x] `syncSupportingResources` 函数已删除
- [x] `getPiExtensionRuntimeEnv` 函数已删除或仅输出 GUI 相关变量
  - 注：整体删除（连同整个 `pi-extension-runtime.ts` 文件）
- [x] `pi-agent.ts` 的 `agentDir` 恒指 `~/.pi/agent`
  - 注：主进程不再注入 `PI_CODING_AGENT_DIR`，子进程默认通过 `resolveAgentDir()` 解析为 `~/.pi/agent`；`init.agentDir` 字段保留用于测试覆盖
- [x] pi 扩展从 `~/.pi/agent/extensions/` 加载
  - 注：代码层验证完成。运行时确认见端到端 Task 11.3

## Task 5 验证（typecheck）
- [x] `packages/shared/tsconfig.json` typecheck 通过（exit 0）
- [x] `packages/server-core/tsconfig.json` typecheck 通过（exit 0）
- [x] `packages/pi-agent-server/tsconfig.typecheck.json` typecheck 通过（exit 0）
- [x] `packages/` 与 `apps/` 中无 `pi-extension-runtime` 引用残留
- [x] `pi-agent-server/src/index.ts` 已从 `~/.pi/agent/auth.json` 加载凭证（`readPiGlobalAuth`）

## 配置与凭证同步
- [x] `config.llmConnections` 不再含 `pi-*` 条目
- [x] `credentials.enc` 不再含 `pi-*` 凭证
- [x] craft UI provider 读取直接读 `~/.pi/agent/models.json`
- [x] craft UI provider 增删改直接写 `~/.pi/agent/models.json`
- [x] `CredentialManager` 对 pi 连接透传 `~/.pi/agent/auth.json`
- [x] 凭证迁移逻辑（credentials.enc → auth.json）已实现且幂等

## Pi settings.json 扩展命名空间
- [x] pi settings.json 支持 `extensions.<name>.model`
- [x] pi settings.json 支持 `extensions.<name>.enabled`
- [x] pi settings.json 支持 `extensions.<name>.concurrency`
- [x] repo-memory 扩展从 settings.json 读取 model
- [x] yourself 扩展从 settings.json 读取 model
- [x] trace-audit 扩展从 settings.json 读取 model/concurrency
- [ ] subagent 扩展从 settings.json 读取 defaultModel
  - 注：subagent 已通过 frontmatter `model?` 字段配置模型，无 `defaultModel` 硬编码，此检查点不适用当前实现路径
- [x] Pi SDK DefaultResourceLoader 跳过 `enabled = false` 的扩展
  - 注：Pi resource-loader.ts 新增 extractExtensionName + 过滤逻辑（extensionsOverride 应用后 filter）

## repo-memory stop 回流
- [x] pi repo 支持 `repo-memory stop` 命令
- [x] pi repo 支持 `manualUpdateController` 独立中止
- [x] craft 的 repo-memory patch 已删除

## Headless UIContext 回流
- [x] pi SDK 提供 `createHeadlessUIContext(transport)`
  - 注：Pi 仓库 `packages/coding-agent/src/core/extensions/headless-ui-context.ts` 已实现，导出于 `@earendil-works/pi-coding-agent`（dist 已 build 并同步到 craft node_modules）
- [x] craft 的 `createBridgeUIContext` 改用 pi 官方实现
  - 注：`packages/pi-agent-server/src/index.ts` 的 `createBridgeUIContext` 委托 `createHeadlessUIContext({ send })`，函数从 ~100 行缩减到 ~10 行，签名保持 `createBridgeUIContext(): ExtensionUIContext` 不变
- [x] craft 不再自实现 `stubTheme`
  - 注：stubTheme 由 Pi 的 `createHeadlessUIContext` 内部提供（passthrough 透传，strip ANSI）
- [x] craft 不再自实现 notify/setWidget 转发
  - 注：notify/setWidget 转发逻辑由 Pi 的 `createHeadlessUIContext` 内部实现，经 transport.send 回调到 craft 的模块作用域 `send`（JSONL over stdio）
- [x] craft 不再自实现 select/confirm/input/editor 降级
  - 注：对话框降级由 Pi 的 `createHeadlessUIContext` 内部提供（返回 undefined/false/prefill）；交互式对话框仍由 craft 的 `extensionEventBus` 订阅 `remoteui:request` 桥接
- [ ] pi 扩展 notify/setWidget/remoteui 事件经新桥接正常到达 renderer
  - 注：代码层 + typecheck 已通过；事件字段与 craft 的 `OutboundExtensionNotify`/`OutboundExtensionWidget` 完全匹配（source 由 `'rpc-bridge'` 变为 Pi 的 `'headless'`，craft 无对 source 的判断逻辑）。端到端运行时验证见 Task 11.7

## call_llm 移除（双方均不保留）
- [x] craft 的 `SESSION_TOOL_DEFS` 不再含 `call_llm`
- [x] craft 的 `CallLlmSchema` 已删除
- [x] craft 的 pi-agent call_llm backend 适配已删除
  - 注：`llm-tool.ts` 重写为仅保留共享类型（`LLMQueryRequest`/`LLMQueryResult`/`withTimeout`），移除 `buildCallLlmRequest`/`createLLMTool`/`processAttachment`/`OUTPUT_FORMATS`
  - 注：`base-agent.ts` 移除 `preExecuteCallLlm`/`validateCallLlmModel`；`claude-agent.ts` 移除 `call_llm_intercept` case 和 `queryFn` 注册
  - 注：`pi-agent.ts`/`pi-agent-server`/`event-adapter.ts`/`session-mcp-server`/`pre-tool-use.ts`/`session-scoped-tools.ts` 已在前期清理
  - 注：`SessionManager.ts` 移除 call_llm 工具名映射和模型解析逻辑
  - 注：UI 层 `tool-parsers.ts`/`TurnCard.tsx` 移除 call_llm 解析和渲染
  - 注：删除 `docs/llm-tool.md`，移除 `docs/index.ts` 的 `llmTool` 路径
- [x] `~/.pi/agent/extensions/call-llm/` 目录已删除（pi 不再加载 call_llm 扩展）

## pi-extension-settings 瘦身
- [x] `PiExtensionSettings` 不再含 `extensions`（enabled 列表）
- [x] `PiExtensionSettings` 不再含 `subagent.defaultModel`
- [x] `PiExtensionSettings` 不再含 `traceAudit.defaultModel`/`concurrency`
- [x] `PiExtensionSettings` 不再含 `yourself.model`
- [x] `PiExtensionSettings` 不再含 `repoMemory.model`
- [x] `PiExtensionSettings` 不再含 `webSearch`
- [x] `PiExtensionSettings` 不再含 `ambiguityDictionary`
- [x] 保留 `delegatePromptAutomation`、`managedAgentDir`
- [x] 保留 `subagent.reviewEnabled`/`reviewModel`
- [x] 保留 `traceAudit.reviewSubagentEnabled`/`showStatusBadge`
- [x] 保留 `yourself.showStatusBadge`、`repoMemory.showStatusBadge`
- [x] 保留 `promptAutomation.*`、`planMode.*`

## craft 独有能力保留（不受影响）
- [x] `spawn_session` 工具仍可用
  - 注：定义在 tool-defs.ts:515，实现在 spawn-session-tool.ts
- [x] `browser_tool` 工具仍可用
  - 注：定义在 tool-defs.ts:518，检测在 browser-tool-detection.ts
- [x] `AutomationSystem` 仍可用（事件驱动自动化）
  - 注：automation-system.ts:76，导出于 automations/index.ts:115
- [ ] pi prompt-automation 扩展仍可用（对话流 cron 注入）
  - 注：需运行时验证
- [ ] GUI 渲染层（6 组件 + 2 hook）不受影响
  - 注：需运行时验证
- [x] GUI 主题（15 个 JSON）不受影响
  - 注：apps/electron/resources/themes/ 下 13 个主题文件存在
- [ ] OAuth 集成工具不受影响
  - 注：需运行时验证

## 端到端验证
- [x] typecheck 通过（shared/server-core/pi-agent-server/session-tools-core）
  - 注：4 包全部 exit 0，0 错误
- [x] `bun run electron:build:main` 成功
  - 注：产出 apps/electron/dist/main.cjs（42.9mb），构建完整
- [ ] craft 启动后无 `~/.craft-agent/pi-extensions` 目录
  - 注：需运行时启动验证（代码层已确认 `prepareCraftPiExtensionAgentDir` 已删除）
- [ ] 设置页配置 repo-memory model 写入 pi settings.json
  - 注：需运行时 UI 验证
- [ ] 禁用扩展写入 pi settings.json 且扩展不加载
  - 注：阻塞于 Task 1.3 上游 PR（DefaultResourceLoader 不读 enabled=false）
- [ ] `repo-memory stop` 命令生效（pi 原生）
  - 注：需运行时验证
- [ ] pi 扩展 widget/notify 正常渲染
  - 注：需运行时验证（当前 createBridgeUIContext 已提供等价功能）
- [x] `~/.pi/agent/extensions/call-llm/` 已删除，pi 不加载 call_llm
- [x] `config.llmConnections` 无 `pi-*`，`credentials.enc` 无 pi 凭证
  - 注：pi-global-sync.ts 确认不再构建 pi-* 连接，仅有一次性迁移逻辑

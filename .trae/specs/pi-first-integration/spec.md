# Pi 扩展接管 Craft 重叠能力 Spec

## Why

当前 craft-agent 在 `pi-agent-server` 中通过把 `agentDir` 重定向到 session 临时目录（`pi-agent-server/src/index.ts:584-589`），**故意隔离了 `~/.pi/agent/extensions/` 下的全局 pi 扩展**。这导致用户已安装的 pi 扩展（plan-mode、prompt-automation、repo-memory、yourself、subagent、ask_user）与 craft-agent 自身的重叠能力形成两套并行实现：

- Spec/Plan：craft 有 ModeManager + SubmitPlan；pi 有 plan-mode 扩展
- Automations：craft 有 AutomationSystem；pi 有 prompt-automation
- Memory：craft 没有分层 memory；pi 有 repo-memory + yourself
- Subagent：craft 部分依赖 SDK Task/Agent；pi 有 subagent 扩展
- AskUserQuestion：craft **主动屏蔽** SDK 版本且无替代；pi 有 ask_user 扩展

用户明确要求"以 pi 为主，按照 pi 的实现覆盖 craft 的"。本 spec 解除隔离、建立桥接、让 craft 的重叠能力退化为薄包装或移除，由 pi 扩展接管运行时行为。

## What Changes

### 解除隔离 + 桥接
- **解除 pi 扩展隔离**：`pi-agent-server` 的 `agentDir` 默认指向 `~/.pi/agent`，让全局 pi 扩展在 craft 子进程中加载
- **新增 ExtensionAPI → Craft 事件桥接**：捕获 pi 扩展的 `ui.notify`、`ui.setWidget`、`registerCommand`、`registerTool` 调用，通过 JSONL 转发到 craft 主进程
- **Craft UI 渲染 pi 扩展输出**：renderer 增加 widget 渲染区、通知通道、命令面板入口，显示 pi 扩展的 widget/notify/command

### 让位与移除
- **Spec/Plan 让位**：保留 craft 的 `ModeManager`（权限层仍需），但 plan 工作流（`/plan`、`/discuss`、架构收缩审查）由 pi plan-mode 扩展接管；craft 的 `SubmitPlan` 工具移除
- **Automations 共存**：craft 的 `AutomationSystem` 保留为 workspace 级 UI/RPC 层（有成熟 UI），但 prompt 触发执行路径可选委托 pi prompt-automation；pi prompt-automation 在 craft 环境下作为"轻量触发器"可用
- **Memory 启用**：craft 不再补齐自己的分层 memory，直接启用 pi repo-memory + yourself 扩展（craft 原本就没有）
- **Task/Subagent 适配**：保留 craft 的 `spawn_session`（独立并行会话，非子代理），但 SDK 的 `Task`/`Agent` 工具不再屏蔽，子代理 spawn 路径改走 pi subagent 扩展
- **AskUserQuestion 启用**：解除 craft 对 SDK `AskUserQuestion` 的屏蔽，改用 pi ask_user 扩展的 UI 协议（单选布局 + 远程 UI）

### 配置与回滚
- 新增配置项 `piExtensions.enabled`（默认 `true`）控制是否加载全局 pi 扩展，支持回滚到隔离模式
- 保留 `agentDir` 覆盖能力（init 仍可传 `agentDir` 指向隔离目录用于测试）

## Impact

- **Affected specs**: 无既有 spec（首次为该主题建 spec）
- **Affected code**:
  - `packages/pi-agent-server/src/index.ts`（`ensureSession` 的 agentDir 逻辑、扩展事件捕获）
  - `packages/server-core/src/`（新增 pi-extension-bridge handler，转发扩展事件到 renderer）
  - `apps/electron/src/main/`（IPC 通道注册）
  - `apps/electron/src/renderer/`（widget 渲染、通知、命令面板）
  - `packages/shared/src/agent/claude-agent.ts:874-876`（解除 `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 屏蔽）
  - `packages/shared/src/agent/mode-manager.ts`（保留权限层，移除 plan 工作流逻辑）
  - `packages/session-tools-core/src/tool-defs.ts`（移除 `SubmitPlan`）
  - `packages/shared/src/automations/`（保留，prompt 执行路径增加 pi 委托选项）
- **Affected pi 扩展**：plan-mode、prompt-automation、repo-memory、yourself、subagent、ask_user（均无需改动，只需 craft 适配它们的 ExtensionAPI 契约）

## ADDED Requirements

### Requirement: Pi 扩展加载与隔离解除

系统 SHALL 在 `pi-agent-server` 启动时，将 `agentDir` 默认指向 `~/.pi/agent`（或 init 消息传入的 `agentDir`），使 Pi SDK 加载用户已安装的全局 pi 扩展。

#### Scenario: 默认加载全局扩展
- **WHEN** craft-agent 启动新会话且未显式指定 `agentDir`
- **THEN** `pi-agent-server` 的 `sessionOptions.agentDir` 指向 `~/.pi/agent`
- **AND** Pi SDK 加载 `~/.pi/agent/extensions/` 下所有有效扩展
- **AND** 扩展的 `session_ready`、`before_agent_start` 等钩子被正常触发

#### Scenario: 显式隔离用于测试
- **WHEN** init 消息传入 `agentDir` 指向临时目录
- **THEN** 系统使用该目录作为 agentDir，不加载全局扩展
- **AND** 该模式用于隔离测试或回滚场景

### Requirement: ExtensionAPI 事件桥接

系统 SHALL 捕获 pi 扩展通过 `ExtensionAPI` 发起的 UI 调用（`ui.notify`、`ui.setWidget`、`registerCommand`、`registerTool`），并通过 JSONL 协议转发到 craft 主进程。

#### Scenario: notify 转发
- **WHEN** pi 扩展调用 `ctx.ui.notify(message, level)`
- **THEN** `pi-agent-server` 发送 `{ type: 'extension_notify', message, level }` 到主进程
- **AND** 主进程转发到 renderer，显示为 craft 通知

#### Scenario: widget 转发
- **WHEN** pi 扩展调用 `ctx.ui.setWidget(key, lines, { placement })`
- **THEN** `pi-agent-server` 发送 `{ type: 'extension_widget', key, lines, placement }` 到主进程
- **AND** renderer 在编辑器下方或指定位置渲染 widget 内容

#### Scenario: command 注册
- **WHEN** pi 扩展调用 `pi.registerCommand(name, { description, handler })`
- **THEN** `pi-agent-server` 发送 `{ type: 'extension_command_registered', name, description }` 到主进程
- **AND** renderer 将命令加入命令面板，用户可通过 `/name` 触发
- **AND** 触发时主进程向子进程发送 `{ type: 'extension_command_invoke', name, args }`

### Requirement: Craft UI 渲染 pi 扩展输出

renderer SHALL 提供 widget 渲染区、通知通道、命令面板入口，用于显示 pi 扩展的 UI 输出。widget 渲染 SHALL 同时支持两种 pi 扩展传参形式：纯文本行数组（`string[]`）和渲染函数（`(width, theme) => string[]`）。

#### Scenario: widget 渲染（纯文本）
- **WHEN** renderer 收到 `extension_widget` 事件且 `lines` 为 `string[]`
- **THEN** 在 ChatPage 编辑器下方（`placement: 'belowEditor'`）或其他指定位置渲染 widget
- **AND** widget 内容为扩展提供的文本行数组
- **AND** widget 随扩展清空（`lines: undefined`）而移除

#### Scenario: widget 渲染（渲染函数）
- **WHEN** pi 扩展调用 `ctx.ui.setWidget(key, renderFn, { placement })` 且 `renderFn` 为函数
- **THEN** `pi-agent-server` 桥接层在转发前调用 `renderFn(width, theme)` 取得 `string[]`
- **AND** 提供 craft 等价 theme 对象（`fg(role, text)`、`bold(text)` 等降级为纯文本或映射到 craft theme 颜色）
- **AND** renderer 收到的是已解析的 `string[]`，渲染方式与纯文本一致

#### Scenario: 命令面板集成
- **WHEN** renderer 收到 `extension_command_registered` 事件
- **THEN** 命令出现在 `/` 命令面板
- **AND** 用户选择命令时，通过 RPC 触发子进程执行

### Requirement: Pi 扩展专用 UI 组件补齐

craft SHALL 补齐 pi 扩展在 TUI 环境下依赖但 craft GUI 当前缺失的 UI 组件，确保 pi 扩展的交互能力在 craft 中完整可用。

#### Scenario: RemoteUI modal 对话框（select）
- **WHEN** pi 扩展（plan-mode 或 ask_user）通过 `pi.events.emit("remoteui:request", { kind: "select", title, options, ... })` 发起选择请求
- **THEN** craft renderer 弹出 modal 对话框，显示 `title` 和 `options`（每项含 `title` + 可选 `description`）
- **AND** 支持 `allowMultiple`（多选）、`allowFreeform`（自由输入）、`allowComment`（附加评论）
- **AND** 用户确认后通过 `pi.events.emit("remoteui:response", { requestId, payload: { selections, freeformText?, comment? } })` 回传
- **AND** 用户取消时 `payload` 为 `null` 且 `reason` 为 `"cancelled"`

#### Scenario: RemoteUI modal 对话框（editor）
- **WHEN** pi 扩展通过 `remoteui:request` 发起 `{ kind: "editor", title, prefill }` 请求
- **THEN** craft renderer 弹出文本编辑 modal，预填 `prefill` 内容
- **AND** 用户确认后回传 `{ text }` 结果

#### Scenario: plan-mode split view
- **WHEN** pi plan-mode 扩展完成主计划并触发架构收缩审查
- **THEN** craft ChatPage 提供 split 面板布局，左侧显示主计划，右侧显示架构收缩审查结果
- **AND** 宽度足够时并排显示，宽度不足时上下堆叠
- **AND** split view 内容通过扩展的 widget 或 remote-ui 事件驱动更新

#### Scenario: plan-mode 执行进度 widget
- **WHEN** plan-mode 扩展在执行阶段更新 `[DONE:n]` 标记
- **THEN** craft widget 渲染区显示执行清单进度（已完成/总数 + 进度条）
- **AND** widget 数据通过 `extension_widget` 事件传入

#### Scenario: prompt-automation cron 任务表格
- **WHEN** prompt-automation 扩展注册了定时任务
- **THEN** craft 在编辑器下方渲染任务表格 widget（状态图标、名称、计划、下次运行、上次运行、运行次数、模型徽章）
- **AND** 表格每 30 秒自动刷新相对时间
- **AND** 用户可通过命令（`/prompt-automation list`、`/schedule-prompt`）管理任务

#### Scenario: prompt-automation 任务管理视图
- **WHEN** 用户执行 `/prompt-automation list` 或 `/schedule-prompt`
- **THEN** craft renderer 渲染任务列表视图（jobs-view）和添加任务向导（add-flow）
- **AND** 视图通过 remote-ui 协议或 widget 事件与扩展交互

#### Scenario: yourself / repo-memory 状态指示
- **WHEN** yourself 或 repo-memory 扩展在后台整理记忆
- **THEN** craft 显示状态 spinner/widget（"repo-memory: updating xxx"）
- **AND** 完成后显示通知（通过 `extension_notify`）
- **AND** 用户可通过 `/yourself status`、`/repo-memory` 命令查看详情

#### Scenario: subagent 活动会话状态
- **WHEN** pi subagent 扩展运行后台子代理任务
- **THEN** craft 显示活动会话列表（来自 `~/.pi/agent/extensions/subagent/supervisor/active-sessions.json`）
- **AND** 显示每个子代理的名称、状态、工作目录
- **AND** 用户可查看子代理进度或取消任务

### Requirement: 配置开关与回滚

系统 SHALL 提供配置项 `piExtensions.enabled`（默认 `true`），控制是否加载全局 pi 扩展。

#### Scenario: 禁用回滚
- **WHEN** 用户设置 `piExtensions.enabled = false`
- **THEN** `pi-agent-server` 回退到隔离模式（agentDir 指向 session 临时目录）
- **AND** craft 的原有重叠能力（SubmitPlan、屏蔽 AskUserQuestion）恢复生效

## MODIFIED Requirements

### Requirement: ModeManager 权限层保留，plan 工作流让位

`ModeManager` 保留为权限层（`shouldAllowToolInMode`、safe/ask/allow-all 模式），但 plan 工作流（结构化规划、架构收缩审查、`/discuss`、`/plan-finalize`）由 pi plan-mode 扩展接管。

#### Scenario: plan 模式触发
- **WHEN** 用户输入 `/plan`
- **THEN** 命令由 pi plan-mode 扩展处理（craft 不再拦截）
- **AND** 扩展的只读工具白名单生效（通过扩展的 `before_agent_start` 钩子）
- **AND** ModeManager 仍负责权限模式切换（safe → allow-all 等）

### Requirement: AutomationSystem 保留 UI 层，prompt 执行可选委托

`AutomationSystem` 保留为 workspace 级 UI/RPC 层（配置、历史、测试），prompt 触发执行路径增加 pi prompt-automation 委托选项。

#### Scenario: 默认执行路径
- **WHEN** automation 的 prompt action 触发
- **THEN** 默认仍由 craft 的 `PromptHandler` 创建会话
- **AND** 若配置 `piExtensions.delegatePromptAutomation = true`，则委托 pi prompt-automation 扩展处理

### Requirement: Subagent spawn 路径适配

craft 的 `spawn_session`（独立并行会话）保留不变；SDK 的 `Task`/`Agent` 工具不再屏蔽，子代理 spawn 路径由 pi subagent 扩展提供。

#### Scenario: Task 工具启用
- **WHEN** 模型调用 `Task` 或 `Agent` 工具
- **THEN** craft 不再屏蔽（移除 `disallowedTools` 中的 `Task`、`Agent`）
- **AND** 子代理 spawn 通过 pi subagent 扩展的 `runSubagentProcess` 执行

## REMOVED Requirements

### Requirement: SubmitPlan 工具
**Reason**: plan 工作流由 pi plan-mode 扩展接管，craft 不再需要自有的 `SubmitPlan` 工具及对应的 UI 卡片。
**Migration**: 
- 从 `packages/session-tools-core/src/tool-defs.ts` 的 `SESSION_TOOL_DEFS` 中移除 `SubmitPlan`
- `FreeFormInput.tsx` 的 `handleApprovePlan` 改为调用 pi plan-mode 的 `/plan-finalize` 命令
- 用户已有的 plan 数据（如有）保留在会话历史中，不影响新会话

### Requirement: AskUserQuestion 屏蔽
**Reason**: craft 原本屏蔽 SDK 的 `AskUserQuestion` 且无替代，导致模型无法向用户提问。改用 pi ask_user 扩展提供单选布局 UI。
**Migration**:
- 从 `packages/shared/src/agent/claude-agent.ts:874-876` 的 `disallowedTools` 中移除 `AskUserQuestion`
- ask_user 扩展的 `remote-ui.ts` 协议由 craft renderer 适配（单选布局渲染）
- 旧的 `shouldPromptInAskMode`（权限提示）路径保留，与 ask_user 工具共存

### Requirement: EnterPlanMode / ExitPlanMode 屏蔽
**Reason**: plan 模式由 pi plan-mode 扩展通过命令和工具白名单管理，craft 不再需要屏蔽 SDK 的 plan 切换工具。
**Migration**:
- 从 `disallowedTools` 中移除 `EnterPlanMode`、`ExitPlanMode`
- 这些工具若被模型调用，由 pi plan-mode 扩展的钩子处理（扩展已注册 `plan:toggle` 事件）

# Tasks

## 阶段 1：解除隔离与桥接基础

- [ ] Task 1: 解除 pi-agent-server 对全局 pi 扩展的隔离
  - [ ] SubTask 1.1: 修改 `packages/pi-agent-server/src/index.ts` 的 `ensureSession`，当未显式传入 `agentDir` 时默认指向 `~/.pi/agent`（用 `homedir()` 拼接）
  - [ ] SubTask 1.2: 新增 `piExtensions.enabled` 配置读取（从 init 消息或环境变量），为 `false` 时回退到原隔离逻辑（session 临时目录）
  - [ ] SubTask 1.3: 在 craft 主进程构造 `InitMessage` 时，把 `~/.pi/agent` 作为默认 `agentDir` 传入，并支持 `piExtensions.enabled=false` 覆盖
  - [ ] SubTask 1.4: 验证启动后 `session_ready`、`before_agent_start` 钩子被 pi 扩展触发（通过 stderr 日志确认扩展加载）

- [ ] Task 2: 实现 ExtensionAPI → Craft 事件桥接层
  - [ ] SubTask 2.1: 在 `pi-agent-server` 中扩展 Pi SDK 的 `ExtensionAPI`，包装 `ui.notify`、`ui.setWidget`、`registerCommand`、`registerTool`，使调用通过 JSONL `extension_*` 消息转发到主进程
  - [ ] SubTask 2.2: 定义出站消息类型（`extension_notify`、`extension_widget`、`extension_command_registered`、`extension_command_invoke`、`remoteui_request`）加入 `OutboundMessage` 联合类型
  - [ ] SubTask 2.3: 定义入站消息类型（`extension_command_invoke`、`extension_tool_execute_response`、`remoteui_response`）加入 `InboundMessage` 联合类型
  - [ ] SubTask 2.4: 在 `packages/server-core/src/handlers/` 新增 `pi-extension-bridge.ts`，接收子进程的 `extension_*` / `remoteui_*` 事件并转发到 renderer IPC

## 阶段 2：Craft UI 适配与组件补齐

- [ ] Task 3: renderer 渲染 pi 扩展 widget 与通知
  - [ ] SubTask 3.1: 在 ChatPage 编辑器下方新增 widget 渲染区，订阅 `extension_widget` IPC 事件，按 `placement` 渲染文本行数组
  - [ ] SubTask 3.2: 桥接层处理 pi 扩展传入的渲染函数 `(width, theme) => string[]`，提供 craft 等价 theme 对象（`fg`、`bold` 等降级映射），调用后转发解析出的 `string[]`
  - [ ] SubTask 3.3: 复用 craft 现有通知组件渲染 `extension_notify` 事件（info/warning/error 三级）
  - [ ] SubTask 3.4: 命令面板（`/` 触发）订阅 `extension_command_registered` 事件，列出 pi 扩展命令；用户选择时通过 RPC 触发 `extension_command_invoke`

- [ ] Task 4: RemoteUI modal 对话框组件（select + editor）
  - [ ] SubTask 4.1: 在 renderer 新增 `RemoteUIModal` 组件，处理 `remoteui:request` 事件的 `kind: "select"`：显示 `title` + `options`（title/description），支持 `allowMultiple`/`allowFreeform`/`allowComment`
  - [ ] SubTask 4.2: `RemoteUIModal` 处理 `kind: "editor"`：弹出文本编辑 modal，预填 `prefill`
  - [ ] SubTask 4.3: 桥接 `remoteui:request` 事件到 renderer，用户确认/取消后通过 `remoteui:response` 回传到子进程（payload 为结果或 null + reason）
  - [ ] SubTask 4.4: 验证 ask_user 扩展的单选布局能通过该 modal 正常工作

- [ ] Task 5: plan-mode 专用 UI 组件
  - [ ] SubTask 5.1: 在 ChatPage 新增 split 面板布局组件，左侧主计划、右侧架构收缩审查，宽度不足时上下堆叠
  - [ ] SubTask 5.2: 实现 plan-mode 执行进度 widget（已完成/总数 + 进度条），通过 `extension_widget` 事件驱动更新

- [ ] Task 6: prompt-automation 专用 UI 组件
  - [ ] SubTask 6.1: 实现 cron 任务表格 widget（状态图标、名称、计划、下次运行、上次运行、运行次数、模型徽章），每 30 秒刷新相对时间
  - [ ] SubTask 6.2: 实现任务列表视图（jobs-view），通过 `/prompt-automation list` 触发
  - [ ] SubTask 6.3: 实现添加任务向导（add-flow），通过 `/schedule-prompt` 触发，复用 RemoteUIModal 组件

- [ ] Task 7: yourself / repo-memory / subagent 状态 UI
  - [ ] SubTask 7.1: yourself / repo-memory 状态通过通用 widget 渲染区显示 spinner（"repo-memory: updating xxx"），完成后通过通知显示
  - [ ] SubTask 7.2: 新增 subagent 活动会话面板，读取 `~/.pi/agent/extensions/subagent/supervisor/active-sessions.json`，显示子代理名称、状态、工作目录
  - [ ] SubTask 7.3: 用户可在 subagent 面板查看进度或取消任务（通过命令触发）

## 阶段 3：让位与移除

- [ ] Task 8: Spec/Plan 让位给 pi plan-mode 扩展
  - [ ] SubTask 8.1: 从 `packages/session-tools-core/src/tool-defs.ts` 的 `SESSION_TOOL_DEFS` 移除 `SubmitPlan`
  - [ ] SubTask 8.2: 修改 `FreeFormInput.tsx` 的 `handleApprovePlan`，改为调用 pi plan-mode 的 `/plan-finalize` 命令（通过 `extension_command_invoke`）
  - [ ] SubTask 8.3: 保留 `ModeManager` 的权限层逻辑，移除其中 plan 工作流相关代码（如有）
  - [ ] SubTask 8.4: 从 `packages/shared/src/agent/claude-agent.ts:874-876` 的 `disallowedTools` 移除 `EnterPlanMode`、`ExitPlanMode`

- [ ] Task 9: 解除 AskUserQuestion 屏蔽
  - [ ] SubTask 9.1: 从 `packages/shared/src/agent/claude-agent.ts` 的 `disallowedTools` 移除 `AskUserQuestion`
  - [ ] SubTask 9.2: 验证 ask_user 扩展能接管 `AskUserQuestion` 工具调用（通过扩展的 `registerTool` 或 UI 协议）

- [ ] Task 10: Task/Subagent 适配
  - [ ] SubTask 10.1: 从 `disallowedTools` 移除 `Task`、`Agent`（若存在屏蔽）
  - [ ] SubTask 10.2: 验证 pi subagent 扩展的 `runSubagentProcess` 能在 craft 子进程环境下执行（路径、model、noTools 等参数）
  - [ ] SubTask 10.3: 保留 craft 的 `spawn_session` 工具不变（独立并行会话，非子代理）

- [ ] Task 11: Automations 共存策略
  - [ ] SubTask 11.1: 保留 craft `AutomationSystem` 的 UI/RPC/配置层不变
  - [ ] SubTask 11.2: 新增配置 `piExtensions.delegatePromptAutomation`（默认 `false`），为 `true` 时 `PromptHandler` 委托 pi prompt-automation 扩展执行
  - [ ] SubTask 11.3: 文档更新 `apps/electron/resources/docs/automations.md`，说明 pi 委托选项

## 阶段 4：Memory 与验证

- [ ] Task 12: 启用 pi repo-memory + yourself 扩展
  - [ ] SubTask 12.1: 验证 repo-memory 扩展在 craft 环境下能加载（无文件系统权限问题）
  - [ ] SubTask 12.2: 验证 yourself 扩展的 `session_start` 钩子能扫描 craft 会话（会话路径格式兼容性检查）
  - [ ] SubTask 12.3: craft 不补齐自有 memory，确认 `~/.pi/agent/YOURSELF/memory/repos/` 与 `~/.craft-agent/` 无冲突

- [ ] Task 13: 配置开关与回滚验证
  - [ ] SubTask 13.1: 实现 `piExtensions.enabled` 配置项的读取（从 `~/.craft-agent/config.json` 或 settings）
  - [ ] SubTask 13.2: 验证 `enabled=false` 时回退到隔离模式，craft 原有 SubmitPlan、屏蔽 AskUserQuestion 恢复
  - [ ] SubTask 13.3: 在 AI Settings 页新增 "Pi Extensions" 开关（复用现有 settings-registry）

- [ ] Task 14: 端到端验证
  - [ ] SubTask 14.1: typecheck（`packages/shared`、`packages/server-core`、`packages/pi-agent-server`）
  - [ ] SubTask 14.2: `bun run electron:build:main` 成功产出 `dist/main.cjs`
  - [ ] SubTask 14.3: 启动 craft，确认 pi 扩展命令（`/plan`、`/discuss`、`/yourself status`、`/repo-memory`）在命令面板可用
  - [ ] SubTask 14.4: 触发一次 pi 扩展 widget（如 plan-mode 的进度条），确认 renderer 正确渲染
  - [ ] SubTask 14.5: 触发一次 RemoteUI modal（如 ask_user 的 select），确认对话框正常弹出并回传结果

# Task Dependencies

- Task 2 依赖 Task 1（需先解除隔离，扩展才会调用 ExtensionAPI）
- Task 3、Task 4、Task 5、Task 6、Task 7 均依赖 Task 2（需桥接层转发事件）
- Task 5 依赖 Task 4（plan-mode split view 复用 RemoteUIModal 组件）
- Task 6 依赖 Task 4（add-flow 复用 RemoteUIModal 组件）
- Task 8、Task 9、Task 10 可并行（均为 `disallowedTools` 移除，互不依赖）
- Task 11 独立（Automations 共存，不阻塞其他任务）
- Task 12 依赖 Task 1（需扩展加载）
- Task 13 依赖 Task 1（配置开关影响隔离逻辑）
- Task 14 依赖所有前置任务完成

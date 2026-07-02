# Checklist

## 阶段 1：解除隔离与桥接基础

- [ ] `pi-agent-server` 的 `ensureSession` 默认将 `agentDir` 指向 `~/.pi/agent`（未显式传入时）
- [ ] `piExtensions.enabled = false` 时回退到原隔离逻辑（session 临时目录）
- [ ] craft 主进程构造 `InitMessage` 时传入 `~/.pi/agent` 作为默认 `agentDir`
- [ ] pi 扩展的 `session_ready`、`before_agent_start` 钩子在启动后被触发（日志确认）
- [ ] ExtensionAPI 的 `ui.notify`、`ui.setWidget`、`registerCommand`、`registerTool` 调用通过 JSONL 转发到主进程
- [ ] `extension_*` / `remoteui_request` 出站消息类型加入 `OutboundMessage` 联合类型
- [ ] `extension_command_invoke` / `remoteui_response` 等入站消息类型加入 `InboundMessage` 联合类型
- [ ] `packages/server-core/src/handlers/pi-extension-bridge.ts` 能接收并转发子进程扩展事件到 renderer IPC

## 阶段 2：Craft UI 适配与组件补齐

- [ ] ChatPage 编辑器下方有 widget 渲染区，能渲染 `extension_widget` 事件的文本行数组
- [ ] 桥接层能处理 pi 扩展传入的渲染函数 `(width, theme) => string[]`，提供 craft 等价 theme 对象
- [ ] widget 随扩展清空（`lines: undefined`）而移除
- [ ] craft 通知组件能渲染 `extension_notify` 事件（info/warning/error 三级）
- [ ] 命令面板（`/` 触发）列出 pi 扩展注册的命令（如 `/plan`、`/discuss`、`/yourself status`）
- [ ] 用户选择命令时通过 RPC 触发 `extension_command_invoke` 到子进程
- [ ] `RemoteUIModal` 组件能处理 `remoteui:request` 的 `kind: "select"`（title/options/allowMultiple/allowFreeform/allowComment）
- [ ] `RemoteUIModal` 组件能处理 `remoteui:request` 的 `kind: "editor"`（prefill 预填）
- [ ] 用户确认/取消后通过 `remoteui:response` 回传到子进程（payload 为结果或 null + reason）
- [ ] ask_user 扩展的单选布局能通过 `RemoteUIModal` 正常工作
- [ ] ChatPage 有 split 面板布局，左侧主计划、右侧架构收缩审查，宽度不足时上下堆叠
- [ ] plan-mode 执行进度 widget 能显示已完成/总数 + 进度条
- [ ] prompt-automation cron 任务表格 widget 能渲染（状态图标、名称、计划、下次运行、上次运行、运行次数、模型徽章）
- [ ] cron 表格每 30 秒自动刷新相对时间
- [ ] `/prompt-automation list` 能触发任务列表视图（jobs-view）
- [ ] `/schedule-prompt` 能触发添加任务向导（add-flow），复用 RemoteUIModal
- [ ] yourself / repo-memory 状态通过 widget 显示 spinner（"repo-memory: updating xxx"）
- [ ] yourself / repo-memory 完成后通过通知显示
- [ ] subagent 活动会话面板能读取 `active-sessions.json` 并显示子代理名称、状态、工作目录
- [ ] 用户可在 subagent 面板查看进度或取消任务

## 阶段 3：让位与移除

- [ ] `SubmitPlan` 从 `SESSION_TOOL_DEFS` 移除
- [ ] `FreeFormInput.tsx` 的 `handleApprovePlan` 改为调用 pi plan-mode 的 `/plan-finalize`
- [ ] `ModeManager` 保留权限层，plan 工作流逻辑移除
- [ ] `disallowedTools` 中移除 `EnterPlanMode`、`ExitPlanMode`
- [ ] `disallowedTools` 中移除 `AskUserQuestion`
- [ ] ask_user 扩展能接管 `AskUserQuestion` 工具调用
- [ ] `disallowedTools` 中移除 `Task`、`Agent`（若存在屏蔽）
- [ ] pi subagent 扩展的 `runSubagentProcess` 在 craft 子进程环境下可执行
- [ ] craft 的 `spawn_session` 工具保持不变
- [ ] craft `AutomationSystem` 的 UI/RPC/配置层保留不变
- [ ] `piExtensions.delegatePromptAutomation` 配置项可读写
- [ ] `automations.md` 文档更新 pi 委托选项说明

## 阶段 4：Memory 与验证

- [ ] repo-memory 扩展在 craft 环境下加载无文件系统权限错误
- [ ] yourself 扩展的 `session_start` 钩子能扫描 craft 会话（路径格式兼容）
- [ ] `~/.pi/agent/YOURSELF/memory/repos/` 与 `~/.craft-agent/` 无目录冲突
- [ ] `piExtensions.enabled` 配置项从 `~/.craft-agent/config.json` 可读
- [ ] `enabled=false` 时回退到隔离模式，SubmitPlan、屏蔽 AskUserQuestion 恢复
- [ ] AI Settings 页有 "Pi Extensions" 开关
- [ ] `packages/shared`、`packages/server-core`、`packages/pi-agent-server` typecheck 通过
- [ ] `bun run electron:build:main` 成功产出 `dist/main.cjs`
- [ ] 启动 craft 后 pi 扩展命令（`/plan`、`/discuss`、`/yourself status`、`/repo-memory`）在命令面板可用
- [ ] 触发一次 pi 扩展 widget（如 plan-mode 进度条）在 renderer 正确渲染
- [ ] 触发一次 RemoteUI modal（如 ask_user 的 select）确认对话框正常弹出并回传结果

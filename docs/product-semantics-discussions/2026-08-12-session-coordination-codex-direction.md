# 会话协调能力向分层协议与宿主编排重构

状态：本阶段已结束

开始时间：2026-08-12 19:18 CST (UTC+08:00)

结束时间：2026-08-12 19:50 CST (UTC+08:00)

## 背景

Mortise 当前已经提供会话列表、会话信息、跨会话消息和子任务控制，但能力分散在会话工具定义、上下文回调、`SessionManager` 与不同运行时适配中。用户认为现状功能不完善，应整体重构，并以 Codex 的会话协议和桌面宿主编排方向作为参照。

## 过程记录

### 2026-08-12 19:18 CST

- 观点：Mortise 不应继续围绕现有 `list_sessions`、`send_agent_message` 和 `spawn_session` 处理器逐项补功能，而应整体转向稳定会话协议、宿主路由和工具适配分层。
- 依据：Codex 将持久化会话事实、`thread/list`、`thread/read`、`turn/start`、`turn/steer` 等协议与桌面宿主的跨项目、跨主机、等待和工具封装分开；Mortise 当前的跨会话能力仍直接依赖 `SessionManager` 回调和工具专用实现。
- 冲突：与现有产品语义不冲突，但必须保持 Pi 对 Session、Attempt、Turn 和 Agent Loop 的唯一运行时权威，不能照搬一套由 Mortise 宿主维护的竞争状态机。

### 2026-08-12 19:18 CST

- 观点：Codex 应作为分层方式和能力完整性的参考，不应成为类型、名称、存储结构或产品语义的逐字复制目标。
- 依据：Mortise 的 Workspace、多位置、Extension、Automations 与 Pi 内嵌运行时边界不同于 Codex；现有已接受语义要求 Mortise 负责 Workspace 与产品路由，Pi 负责 Session 及以下状态。
- 冲突：如果把普通 Session 和父 Session 私有子任务直接合并为同一种可见会话，会与“核心子任务不进入普通 Session 列表”的现有语义冲突。

### 2026-08-12 19:25 CST

- 观点：模型通过跨会话工具发送内容，应与普通用户发送消息同构，没有必要另设工具专用消息机制。
- 依据：两者都表达“向目标 Session 投递一条用户消息”的产品意图。若按调用方类别拆分消息类型、排队、持久化或执行入口，会制造重复状态机，使工具投递与 UI、CLI、Extension、Automation 的行为逐渐漂移。
- 澄清：同构不表示取消命令意图区分。普通发送统一使用 follow-up/下一次 Turn 的投递语义；只有调用方显式要求改变当前 Turn 时才使用 `steer`。`steer` 与普通发送的差别来自命令意图，不来自“模型工具”或“真人用户”身份。
- 共识：界面、CLI、模型工具、Extension、Automation 和其他产品入口复用同一消息合同、Session 路由、Pi 命令入口、排队、持久化、事件投影和失败恢复；调用方类别只保留为来源与审计 metadata，不形成另一条消息通道。

### 2026-08-12 19:25 CST

- 观点：读取其他 Session 时必须先形成适合调用方的受限投影，不能把完整上下文直接注入当前模型，否则长会话、推理和工具输出会无界占用上下文。
- Codex 依据：开源 app-server 的 `thread/read` 默认只返回 metadata，只有 `includeTurns: true` 才加载完整 Turn；较新的 `thread/turns/list` 默认从最近 Turn 开始分页，默认每页 25、最大 100，并提供 `notLoaded`、`summary`、`full` 三种条目视图。`summary` 是确定性投影，每个 Turn 只保留第一条用户消息和最后一条 Agent 消息。Codex 桌面宿主的 `read_thread` 工具进一步暴露 `turnLimit`、旧 Turn 游标、`includeOutputs` 和 `maxOutputCharsPerItem`，说明模型工具读取不是完整历史直通。
- 共识：Mortise 普通会话读取默认返回当前状态与最近 Turn 的有界语义投影，通过游标读取更早内容；完整 transcript、原始推理、工具过程和命令输出不得默认进入调用模型上下文。完整规范历史仍由 Pi 持有，指定 Turn、条目范围或显式详情级别可以按需展开，并对大型内容单独限长和标明截断。
- 待决定：Mortise 的默认 Turn 数量、摘要是否同样固定为“第一条用户消息 + 最后一条 Agent 消息”、是否需要独立的模型生成会话摘要，以及完整详情能力对模型工具开放到什么范围。

### 2026-08-12 19:25 CST

- 观点：Pi 的 Session 底层是树结构，普通读取应默认读取当前树分支，不能把整棵树按时间顺序拼成线性会话。
- Pi 依据：Session storage 持久化当前 `leafId`；`Session.getBranch()` 未指定节点时读取该 `leafId` 并调用 `getPathToRoot()`，`buildContext()` 也基于这条分支构造模型上下文。当前分支因此是 Pi 的持久化事实，不应由 Mortise 根据最后更新时间重新推断。
- 共识：Mortise 普通读取默认从 Pi 当前叶节点沿 `parentId` 回溯，只对当前分支生成有界、可分页投影。其他分支仍属于同一 Session 的规范历史，但不混入默认读取；调用方必须显式指定目标分支节点才能读取，并能识别其不是当前分支。

### 2026-08-12 19:48 CST

- 观点：普通会话协调工具需要提供创建 Session 的能力；现有 `spawn_session` 表达的是创建和控制父 Session 私有子智能体，不属于本次普通 Session 工具重构。
- 依据：Mortise 已有 Draft/Publication 语义和 `createAndSendFirstTurn` 首轮事务，普通 Session 创建应复用该边界；核心子任务已有独立的父级作用域、私有列表和生命周期合同，把两者合并会模糊产品集合并扩大本次改动范围。
- 共识：本次重构的普通会话模型工具目标集合为 `list_sessions`、`create_session`、`read_session`、`send_message_to_session`，后续再按已确认语义加入等待和中断能力。`create_session` 必须携带首条消息并在首条规范 UserMessage durable 后发布；`spawn_session` 及其 `list/inspect/message/resume/interrupt` 子任务动作保持原范围，不纳入本次重构。

### 2026-08-12 19:50 CST

- 决定：用户同意按当前产品语义开始实现。
- 本阶段范围：实现普通 Session 的列表、创建、当前分支有界读取和统一消息投递；模型工具目标为 `list_sessions`、`create_session`、`read_session`、`send_message_to_session`。
- 明确不在范围：`spawn_session` 及其子任务控制保持不变；`wait`、普通 Session 中断工具、读取摘要的最终参数和额外模型摘要留待后续专题决定。
- 兼容处理：旧工具只可作为迁移适配，不得继续拥有独立消息包装、回调状态机或不同于普通 Session 入口的产品语义。

## 最终共识

已确认的工程方向：会话查询、读取、投递、等待和控制应采用“稳定领域协议 + 宿主编排 + 模型工具适配”的整体架构，逐步替代散落的工具处理器和 `SessionManager` 回调耦合，并保持 Pi 是 Session 及以下唯一状态机。

已确认的消息投递语义：跨会话模型工具与普通用户发送消息同构。所有调用方复用同一消息合同和 Session 命令通道；普通发送按统一 follow-up/下一次 Turn 语义处理，改变当前 Turn 必须显式选择 `steer`。工具身份本身不改变排队、持久化、投影和结算语义。

已确认的读取语义：普通读取默认跟随 Pi 持久化的当前叶节点，只对 Session tree 当前分支提供当前状态与最近 Turn 的有界、可分页语义投影，不混合其他分支，也不把完整 transcript、原始推理、工具过程和命令输出直接注入调用模型上下文；完整规范树由 Pi 保持权威，并通过指定分支节点、范围或详情级别按需展开。

已确认的创建与范围语义：普通会话协调提供独立的 `create_session`，携带首条消息并复用首轮 publication 事务；`spawn_session` 属于父 Session 私有子智能体能力，不在本次普通会话工具重构范围内。

以下产品语义仍待后续决定，不属于本阶段实现：

1. `wait` 面向的是一次 Attempt/Turn、一个长期操作收据，还是两者的统一观察接口；完成、需要输入、断线和状态未知如何区分。
2. 第一阶段是否只统一后端协议和 CLI，还是同步替换模型可见工具名与前端会话控制入口。
3. 普通读取的默认 Turn 数量、摘要投影字段、是否维护额外会话摘要，以及模型工具可请求的最大详情范围。

## 语义文档落点

- `AGENTS.md` 的 `Harness`：记录已经明确的长期工程原则，即会话能力采用领域协议与宿主编排分层，并禁止宿主复制 Pi 状态机。
- `docs/product-semantics.md` 的“Session 与消息”：记录调用方无关的统一用户消息投递语义，以及普通发送与显式 `steer` 的边界。
- `docs/product-semantics.md` 的“Session 与消息”：记录普通读取的有界投影、分页、按需详情和大型输出限长语义。
- `docs/product-semantics.md` 的“Draft 不是 Session”：记录普通 Session 创建必须携带首条消息并与 `spawn_session` 子任务委派保持分离。
- `wait` 观察对象、第一阶段迁移范围和读取投影具体参数仍未形成共识，暂不写入规范语义。

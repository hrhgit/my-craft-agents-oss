# 语义文档与代码差距梳理及结构优化

状态：已达成共识

开始时间：2026-08-13 10:00 CST (UTC+08:00)

结束时间：2026-08-13 11:50 CST (UTC+08:00)

## 背景

用户要求检查语义文档与代码之间的差距并完善语义文档，同时对文档结构做优化，把底层设计原则和可复用框架的位置更加提前。

## 过程记录

### 2026-08-13 10:00 CST

- 观点：`docs/product-semantics.md` 已覆盖大部分近期共识（模型标签、读图代理、Draft/Publication、Attempt 与中断续接、Extension 能力组合、subagent、构建内容寻址），但与代码和模块档案相比仍存在可补的语义空白。
- 依据：逐项对照 `.agents/modules/*.md`、`AGENTS.md` 与代码实现。
- 冲突：无。

### 2026-08-13 10:20 CST

- 观点：权限审批能力属于已实现但语义文档完全缺失的领域。`apps/electron/resources/pi-extensions/mortise-permissions` 提供 `ask`/`allow-all` 两种模式，AGENTS.md `## Harness` 明确规定“权限审批能力由 Extension 提供，Mortise 核心只保留中立的扩展执行接口；产品权限模式只提供‘询问’和‘始终批准’”。
- 依据：`mortise-permissions/src/toolbar.ts`、`approval.ts`；`extension-runtime.md` 与 `pi-coding-runtime.md` 的不变量条目。
- 冲突：无。

### 2026-08-13 10:35 CST

- 观点：Messaging（Telegram/WhatsApp/Feishu）是产品级能力，但语义文档只在“分层”段落中顺带提及。模块档案已明确“入站消息映射到稳定的 workspace/session 上下文；通道确认不得先于 durable 接受”，需要升格为独立章节。
- 依据：`.agents/modules/messaging.md` 的 invariants 与 capabilities；`packages/messaging-gateway/src/adapters/{telegram,whatsapp,lark}`。
- 冲突：无。

### 2026-08-13 10:45 CST

- 观点：会话命名、未读状态、跨 Workspace 的 unread/processing 汇总和通知徽标是用户可见行为，代码已实现（`SessionManager` 的 `hasUnread` 状态机、`getUnreadSummary`、`name_changed` 事件），语义文档未覆盖。
- 依据：`packages/server-core/src/sessions/SessionManager.ts`；`apps/electron/src/renderer/App.tsx`；`apps/electron/src/main/notifications.ts`。
- 冲突：无。

### 2026-08-13 11:00 CST

- 观点：文档结构上，“分层与权威边界”（Workspace/Session/Attempt/Turn）和“数据、兼容与权威边界”属于底层设计原则，但分别位于正文中部和末尾；应把这些底层原则与可复用框架（分层模型、单一状态机、调用方无关合同、规范数据边界、故障隔离、权限由 Extension 提供）前置，放在核心概念图之前，作为阅读的优先路径。
- 依据：用户明确要求“把一些底层设计原则，可复用的框架位置更加提前”。
- 冲突：与现有正文顺序不冲突，属于结构重组；正文原有条目保留并迁移位置，不改变已接受语义。

### 2026-08-13 11:40 CST

- 观点：补齐两处与 AGENTS.md `## Harness` 对齐的扩展 UI 原则：扩展 UI 响应式布局以核心聊天转录和输入框为最高优先级；扩展接入规范以代码表达力、可组合性和工程清晰度为优先，不以无代码门槛为目标。
- 依据：AGENTS.md `## Harness` 已确立的规则；`extension-ui-v2.md` 与 `pi-extension-gui.md` 的布局与验收合同。
- 冲突：无。

- 观点：`docs/product-semantics.md` 的“已接受的详细参考”补充 `extension-ui-v2.md`，与既有 `pi-extension-gui.md`、`extension-capability-composition.md` 并列。
- 依据：Extension UI V2 是已实现的浏览器风格前端合同，语义文档的 Extension 章节依赖该专题文档。
- 冲突：无。

## 最终共识

1. `docs/product-semantics.md` 新增 `## 底层设计原则` 章节，置于 `## 产品定位与边界` 之后、`## 核心概念图` 之前，聚合：分层与权威边界、单一状态机与调用方无关合同、规范数据与兼容边界、故障隔离与降级、权限审批由 Extension 提供。
2. 新增 `## Messaging 语义` 章节：Messaging 网关是 Mortise host 的产品能力，入站消息映射到稳定 Workspace/Session 上下文，通道确认不得先于 durable 接受，回复走同一 Session 合同，不创建第二条消息通道。
3. 在 `## Draft、Session 与 Agent 运行` 下新增“会话命名、未读与通知”小节：命名是 host 侧 metadata；`hasUnread` 是 NEW 徽标的唯一事实源；未读与 processing 跨 Workspace 汇总并驱动通知与徽标。
4. 原“Workspace 与 Session 分层”小节迁移至“底层设计原则 · 分层与权威边界”；原“数据、兼容与权威边界”章节迁移至“底层设计原则 · 规范数据与兼容边界”，不再在正文末尾重复。
5. 更新日期与“已接受的详细参考”同步维护。
6. “单一状态机与调用方无关合同”补充长任务语义：先持久化操作收据并返回 `operationId`，通信超时或断线只表示结果待核实，不自动判定业务失败或取消；取消只来自用户显式取消或明确的资源回收逻辑。
7. “Extension 语义”补充扩展 UI 布局与接入原则：响应式布局以核心聊天转录和输入框为最高优先级；接入规范以代码表达力、可组合性和工程清晰度为优先。“已接受的详细参考”补充 `extension-ui-v2.md`。

## 语义文档落点

- `docs/product-semantics.md`：新增“底层设计原则”“Messaging 语义”章节；“会话命名、未读与通知”小节；迁移“分层与权威边界”与“规范数据与兼容边界”；更新更新日期。
- 本纪要记录推导过程，不替代上述规范文档。

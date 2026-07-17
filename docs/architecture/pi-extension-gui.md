# Pi Extension GUI Architecture

## 1. 结论

- Recommendation: `reuse-first`，复用成熟插件系统的边界和生命周期模式，Craft 自行实现轻量宿主。
- Recommended candidate: VS Code Workbench Extension API 模式。
- One-line reason: 扩展宿主隔离、声明式 contribution points 与受控 Webview 的组合最贴近 Craft 对稳定性和自由度的双重要求。

Craft GUI 必须跟随 Pi 扩展分发，而不是由 Craft 按扩展名称硬编码。扩展通过 `ctx.ui.upsertContribution()` 发布可序列化 UI，Craft 校验后将它放入宿主拥有的 surface。主对话面板开放最多表面；侧栏和窗口热点使用容量受控槽位。任意 DOM 使用同一协议中的沙箱 UI App，而不是让扩展脚本进入 Craft renderer。

## 2. 候选对比

| Candidate | Score | Gate | EvidenceLevel | Key Risk | Links |
|---|---:|---|---|---|---|
| VS Code Workbench Extension API | 99.75 | pass | L2 | Webview 自由度高，必须保持进程与权限隔离 | [GitHub](https://github.com/microsoft/vscode), [Contribution Points](https://code.visualstudio.com/api/references/contribution-points), [Webview](https://code.visualstudio.com/api/extension-guides/webview), [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) |
| Backstage Frontend System | 97.25 | pass | L2 | 设计偏构建时组合，不适合直接承担会话级动态 UI | [GitHub](https://github.com/backstage/backstage), [Architecture](https://backstage.io/docs/frontend-system/architecture/extensions/) |
| Eclipse Theia Platform | 96.75 | pass | L2 | 平台规模远大于 Craft 所需，直接引入成本过高 | [GitHub](https://github.com/eclipse-theia/theia), [Plugin Authoring](https://theia-ide.org/docs/authoring_plugins/) |

## 3. 关键证据

- VS Code 将静态声明、隔离 Extension Host 和受限 Webview 分开，证明“默认宿主渲染，必要时沙箱自由 UI”可以共存。
- Backstage 的 typed attachment 和 override 语义适合作为 contribution 合并与唯一替换的参考。
- Theia 明确区分 browser、Electron 和 backend，符合 Craft WebUI/Electron 共用 renderer、平台能力走 adapter 的现状。
- 三个候选均通过 18 个月维护、许可证和官方来源硬门槛；确定性评分脚本结果依次为 99.75、97.25、96.75。

第二阶段针对沙箱宿主重新按相同规则评分：VS Code Webview / Extension Host 99.90，Backstage Frontend Extensions 97.35，Eclipse Theia Plugin Host 96.90。结论仍是复用 VS Code 的隔离边界和生命周期模式，但 Craft 使用浏览器原生 `iframe sandbox + CSP + MessageChannel` 自行实现轻量宿主，以保持 WebUI/Electron 同构。

## 4. 风险与回滚

- 风险：扩展争抢输入框、卡片操作区和窗口四角，导致重叠或布局跳动。
- 风险：扩展失联后残留 UI，或重连时旧 revision 覆盖新状态。
- 风险：声明式 primitive 不够自由，扩展转而依赖私有 Craft DOM。
- 回滚触发：贡献协议导致会话不可用、主输入区不可操作或 renderer 崩溃。
- 回滚动作：关闭统一 `legacyExtensionGui`/native contribution feature gate，清空对应 runtime registry；Craft 核心对话和通用 RemoteUI 不依赖扩展贡献，始终保留。

## 5. 当前实现与后续约束

以下基础能力已经完成：Pi `ExtensionUIContext` 的 contribution API 和 revision 生命周期、Craft registry/layout manager/host primitives、主对话/输入框/侧栏 surface，以及 background badges、prompt automation、subagent 和 plan mode 的迁移。

后续修改必须保持以下约束：

1. 扩展 GUI 继续通过版本化 contribution 协议发布；不得重新引入按扩展 ID、widget key 或业务功能分支的 Craft renderer。
2. 扩展重载、断连、会话替换和进程失败必须清理对应 runtime 的 contribution 与 validation registry，不能让旧 revision 重新覆盖新状态。
3. 新 GUI 必须同时覆盖 host-rendered 和 sandbox 两种边界：默认使用受控 primitive；只有需要独立应用 UI 时才使用 iframe sandbox。
4. 新的 source-development UI 验证能力必须保持在开发构建内，不得进入生产包或成为扩展加载的前置条件。

## Runtime Contract

### Ownership

- Pi owns extension identity and per-runtime monotonically increasing `revision`.
- Craft owns `sessionId` and trusts only the RPC runtime route, never identity fields supplied inside content.
- Registry key is `(sessionId, runtimeId, extensionId, contributionId)`.
- `upsert` and `remove` are idempotent. Events with a revision not greater than the last accepted revision for an extension runtime are ignored.
- `reset` removes every contribution for one extension runtime. Runtime close, reload, reconnect, session replacement and process failure must emit or synthesize a reset.

### Rendering Levels

Level 1 is host-rendered and is the default. It supports text, markdown, stack, row, badge, icon, divider, button and command actions. It inherits Craft theme, accessibility and responsive behavior.

Level 2 is a sandbox UI App. Each self-contained app receives an opaque-origin iframe document, CSP, a private `MessageChannel`, bounded session/runtime-scoped storage and explicitly declared permissions. Multiple apps may be visible in one Craft UI, but each occupies a layout slot assigned by Craft. They cannot access the parent DOM, global CSS, credentials, Electron IPC, workers, raw network APIs or arbitrary filesystem APIs. Omitted permissions mean no host bridge access.

### Surfaces

High-freedom conversation surfaces:

- `conversation.timeline.before`, `conversation.timeline.after`
- `conversation.turn.before`, `conversation.turn.after`, `conversation.turn.replace`
- `conversation.message.before`, `conversation.message.after`, `conversation.message.replace`
- `conversation.tool.before`, `conversation.tool.after`, `conversation.tool.replace`
- `conversation.inline`, `conversation.overlay`
- `composer.above`, `composer.below`, `composer.toolbar`, `composer.status`, `composer.replace`

High-freedom workspace content surface:

- `workspace.content` contributes an ordinary content tab to the workspace's universal dock. Craft owns tab placement, selection, sizing, focus, permissions, saved layout and recovery; the extension owns the isolated tab body. Version 1 `workspaceContent` metadata declares a host-rendered title/icon, session/workspace/global scope, singleton/multiple instance policy and an initial `active`/`adjacent` group preference. It never declares a persistent direction or width.

Built-in content tools use the same frame contract. Session files provide text preview, unified diff and conflict-checked editing through the workspace file boundary; binary files retain the full preview flow. Electron can temporarily reparent an existing browser instance's page and agent-control overlay into a content tab, preserving the same cookies, history and automation identity. WebUI reports the native-browser capability as unavailable instead of substituting an unreliable cross-origin iframe.

Constrained shell surfaces:

- `sidebar.header`, `sidebar.section`, `sidebar.footer`
- `navigation.item`, `session.badge`
- `window.topLeft`, `window.topRight`

Replace surfaces require explicit host permission and at most one winner. If the winner is invalid or disappears, Craft immediately restores the built-in UI.

## Layout And Conflict Resolution

Extensions describe intent; they never set host coordinates, global z-index or absolute positioning.

Each contribution may declare `priority`, `order`, `group`, `collapse`, `overflow`, and `exclusive`. The `SurfaceLayoutManager` applies these rules deterministically:

1. Reject contributions incompatible with the requested surface.
2. Partition by surface and optional target entity.
3. Sort by host policy, then extension priority, order, extension ID and contribution ID.
4. Enforce surface capacity. Keep visible items, collapse the remainder into one host-owned overflow control.
5. Resolve exclusive/replace requests to one winner; expose losers through diagnostics, never by overlap.
6. On narrow viewports, reduce capacity and move toolbar/corner actions into overflow before shrinking core controls.

Default capacities:

| Surface class | Visible capacity | Overflow behavior |
|---|---:|---|
| Timeline / inline panels | unbounded with host virtualization | vertical flow |
| Composer above/below | 3 | collapsible stack |
| Composer toolbar/status | 4 | action menu |
| Card/message/tool action areas | 3 | action menu |
| Window top-left/top-right | 2 per corner | action menu |
| Sidebar sections | 5 sections | collapsed section list |
| Workspace content sandbox apps | 4 admitted tabs per renderer | excess sandbox contributions stay unmounted |
| Replace surfaces | 1 | deterministic winner |

The host reserves space before rendering and uses stable dimensions for controls, so late extension updates cannot cover the composer, message content, navigation, or window controls.

Compact hotspots accept only shallow rows of text, icons, badges, and buttons. They reject Markdown, stacks, dividers, deep trees, and long text; the renderer clamps height and width before overflow allocation. A contribution's `collapse: never` is a preference, not permission to displace core Craft controls.

## Security And Validation

- Contribution payloads are bounded, versioned and discriminated. HTML, script, React components, event handlers, CSS and arbitrary URLs are rejected in Level 1.
- Buttons invoke commands already registered by the same extension. Craft verifies ownership before using `invoke_extension_command`.
- Unknown primitives, surfaces or action kinds fail closed and appear only in diagnostics.
- A failing contribution is isolated; it cannot suppress core Craft UI or other extensions.

### AI-Operable UI Validation

GUI extensions can publish a development-only validation contract through `ctx.ui.validation`. The Test Host uses this contract to compose deterministic scenarios, wait for readiness, invoke extension-owned actions, and collect evidence without exposing the Craft DOM, CDP, Electron internals, or arbitrary renderer mutation to either the extension or the test agent.

- Validation is capability-gated. `ctx.ui.validation.available` is false in production, TUI, headless, unsupported, and older-host environments; extensions must continue their normal behavior in all of them.
- Definitions carry stable IDs, readiness signals, command-backed actions, bounded scenarios, and semantic snapshots. Pi owns monotonically increasing validation revisions; Craft replaces untrusted route identity with its trusted session/runtime/extension route before rendering.
- Scenario setup may only compose production-valid extension state. It must not mutate renderer internals, evaluate arbitrary code, inspect private DOM, or write user data. Any persistent setup needs an idempotent teardown command.
- Sandbox apps receive the same semantic contract only through the nonce-bound private bridge and only when they request the `validation` permission. The bridge has no DOM, filesystem, network, Electron IPC, or code-evaluation access.

Craft WebUI and Electron share the renderer registry and sandbox protocol. Verification evidence is graded: scenario validation proves declared production-state transitions, renderer validation proves real rendered interaction, and native validation proves operating-system interaction where a native adapter exists. A platform without that adapter reports `UNSUPPORTED`; it must not be represented as native verification.

## Legacy Isolation And Migration

The extension-specific legacy GUI gate and Craft ID switches have been removed. Generic RemoteUI dialogs, notifications, title/editor bridges and the widget-to-contribution adapter remain protocol compatibility features.

Completed migration inventory:

1. background agent badges
2. prompt automation widget
3. subagent panel
4. plan composer: phase controls and artifact actions are declared by `plan-mode`
5. plan artifact transcript: extension-authored content is rendered by the generic projection Markdown path

Each migration remains complete only while its extension package owns contribution declarations and command handlers, Craft contains no extension-ID, widget-key, or extension-specific transcript renderer branch, and focused tests cover the generic upsert/remove/reset and overflow behavior. A source guard prevents the removed Plan and `ask_user` host branches from returning.

Extension settings are declared statically in `pi.extensions[].ui.settings`, validated by Pi at the manifest boundary, and stored under `extensionConfig.<id>`. Craft renders the schema generically and validates every patch before writing it. No active chat session and no extension-ID switch are required.

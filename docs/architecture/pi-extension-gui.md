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

## 5. 下一步执行

1. 完成 Pi `ExtensionUIContext` 的 upsert/remove/reset API 和 RPC revision 生命周期。
2. 完成 Craft registry、layout manager、host primitives 与 command action dispatch。
3. 挂载主对话/输入框/侧栏 surface，默认关闭硬编码扩展 GUI。
4. 用示例扩展验证声明、更新、移除、重连清理和多个扩展冲突分配。
5. 再迁移 background badges、prompt automation、subagent、plan mode 等旧 GUI。

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
| Replace surfaces | 1 | deterministic winner |

The host reserves space before rendering and uses stable dimensions for controls, so late extension updates cannot cover the composer, message content, navigation, or window controls.

Compact hotspots accept only shallow rows of text, icons, badges, and buttons. They reject Markdown, stacks, dividers, deep trees, and long text; the renderer clamps height and width before overflow allocation. A contribution's `collapse: never` is a preference, not permission to displace core Craft controls.

## Security And Validation

- Contribution payloads are bounded, versioned and discriminated. HTML, script, React components, event handlers, CSS and arbitrary URLs are rejected in Level 1.
- Buttons invoke commands already registered by the same extension. Craft verifies ownership before using `invoke_extension_command`.
- Unknown primitives, surfaces or action kinds fail closed and appear only in diagnostics.
- A failing contribution is isolated; it cannot suppress core Craft UI or other extensions.

## Legacy Isolation And Migration

The extension-specific legacy GUI gate and Craft ID switches have been removed. Generic RemoteUI dialogs, notifications, title/editor bridges and the widget-to-contribution adapter remain protocol compatibility features.

Migration order:

1. background agent badges
2. prompt automation widget
3. subagent panel
4. plan composer
5. plan artifact transcript renderer

Each migration is complete only when its extension package owns the contribution declaration and command handlers, Craft contains no extension-ID or widget-key branch for it, and focused tests cover upsert/remove/reset plus overflow behavior.

Extension settings are declared statically in `pi.extensions[].ui.settings`, validated by Pi at the manifest boundary, and stored under `extensionConfig.<id>`. Craft renders the schema generically and validates every patch before writing it. No active chat session and no extension-ID switch are required.

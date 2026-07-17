# Craft GUI Extension Style And Placement V2 Proposal

Status: design proposal. The `workspace.content` portion describes the current contribution API; the remaining V2 presentation types are future design shapes.

Snapshot date: 2026-07-17.

## 1. 结论

- Recommendation: `reuse-first`，复用当前主流 Agent 桌面端的产品模式；Craft 自行维护版本化 extension presentation 与 style contract。
- Recommended candidate: OpenAI Codex App。
- One-line reason: Codex 的 workspace/session 导航、连续 transcript、渐进式 task/tool 状态、review 辅助面和稳定 composer，与 Craft 的 workspace-centric agent 桌面端目标最接近。

主参考顺序是 OpenAI Codex App、Claude Desktop / Claude Code Desktop，再用 assistant-ui 验证 message-part 组合模型的实现可行性。IDE 不适合作为 Craft GUI 扩展的主要 UX 参考；它只补充“完整工具如何成为可移动 workspace content”这一小段。消息旁 UI、工具调用、追问、计划状态、composer、review finding 和 Artifact 预览都应先按 Agent 桌面端设计。

这里的 `reuse-first` 是复用产品模式和交互语法，不是引入 Codex 或 Claude 的闭源 runtime。Craft 的 extension ownership、序列化协议、sandbox 隔离、冲突处理和 universal dock 仍然自建。

当前 Craft GUI 扩展的安全和生命周期基础已经较好：贡献协议可序列化、host-rendered 与 sandbox 分层、宿主拥有冲突处理、扩展 UI 有开发态验证契约。当前真正缺少的是一套 conversation-first 的作者模型：

1. 现有文档按 surface 名称罗列能力，没有先回答“这块 UI 属于哪次对话事件”。
2. `before/after/overlay/topRight` 容易诱导作者从坐标出发，而不是从消息 part、工具状态和用户任务出发。
3. 运行中的 tool、完成后的 result、HITL question 和 Artifact preview 没有统一的对话组件语法。
4. 原 `workbench.right` 已从公共协议移除；完整扩展工具使用 `workspace.content`，不再暴露固定方向或宽度。
5. host-rendered UI 只有少量 `tone`/`gap`；sandbox 只拿到少数颜色 token，无法稳定跟随 Craft 的排版、密度、focus、motion 和容器尺寸。
6. 协议接受 badge tone，但当前 renderer 没有按 tone 渲染 badge；文本状态色也没有完整使用 Craft 语义 token。

V2 的第一原则：

> 扩展 UI 默认属于产生它的 message/tool/turn。只有当内容需要脱离对话长期操作时，才逐级升级为 task status 或 workspace content。

三层职责：

1. Conversation event UI：tool、HITL、review finding、Artifact preview 和 trace 绑定产生它的 message/tool/turn，在 transcript 中原位恢复和解决。
2. Host task/environment status：Craft 聚合跨消息或跨会话仍需关注的 working、needs-input、completed、scheduled、unread 和环境摘要；扩展只贡献结构化状态。
3. Workspace content：完整 Artifact、Review、Browser、调试器和扩展工具作为 universal dock 的普通 content tab，可移动、分组和 detach。

升级阶梯：

```text
message part -> turn/thread contribution -> task status popover -> workspace content
     默认              会话上下文              后台摘要              完整工具
```

推荐空间模型：

```text
┌──────────────────────────── Craft window ────────────────────────────┐
│ workspace / session navigation                         task status   │
├──────────────────┬──────────────────────────┬────────────────────────┤
│ workspace sidebar│ conversation             │ optional dock group    │
│                  │                          │                        │
│ Workspace        │ user message             │ Artifact / Browser     │
│   Recent session │ assistant text           │ Extension full tool    │
│   Recent session │ tool card + live status  │ movable + detachable   │
│                  │ HITL question card       │                        │
│ modules (bottom) │ artifact preview         │                        │
│                  │ composer                 │                        │
└──────────────────┴──────────────────────────┴────────────────────────┘
```

右侧只是某次布局结果，不是扩展 API。用户提供的 Codex 实机截图中，右侧“环境信息”是由顶栏动作打开的临时检查 popover；官网中的完整 changed-files/review 则进入辅助面。Craft 同样应让紧凑状态停留在宿主 popover，让完整工具成为 workspace-owned content tab，可进入任意 dock group 或独立窗口；对话中的 UI 仍留在产生它的消息位置。

## 2. 候选对比

本轮采用 commercial-first 候选集。产品更新、文档和采用度证据来自 2026-07-17 的官方页面；assistant-ui 的维护、许可证、release 和采用度来自同日 GitHub/官方文档快照。分数由 `prebuild-solution-research/scripts/score_candidates.py` 确定性计算。

| Candidate | Score | Gate | EvidenceLevel | Key Risk | Links |
|---|---:|---|---|---|---|
| OpenAI Codex App | 98.75 | pass | L2 | 闭源产品，只能复用 UX 模式，不能依赖内部协议 | [Product](https://openai.com/codex/), [Terms](https://openai.com/policies/terms-of-use/) |
| Claude Desktop and Claude Code Desktop | 98.50 | pass | L2 | 产品壳层不是扩展 contribution contract，部分能力可能随版本变化 | [Desktop navigation](https://claude.com/resources/tutorials/navigating-the-claude-desktop-app), [Desktop redesign](https://claude.com/blog/claude-code-desktop-redesign), [Agent view](https://claude.com/blog/agent-view-in-claude-code), [Artifacts](https://claude.com/blog/artifacts-in-claude-code) |
| assistant-ui Conversation Primitives | 96.50 | pass | L2 | 是组件/runtime 库，不提供 Craft 所需的跨进程隔离和多扩展冲突策略 | [GitHub](https://github.com/assistant-ui/assistant-ui), [Thread](https://www.assistant-ui.com/docs/primitives/thread), [Message](https://www.assistant-ui.com/docs/primitives/message), [Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui) |

复用结论：

- 从 Codex 复用产品主结构：workspace/session 导航、连续 transcript、紧凑进度事件、宿主状态聚合，以及 changed-files/review 从摘要升级到完整辅助面的路径。
- 从 Claude Desktop / Claude Code Desktop 交叉验证并行 session、`Needs input / Working / Completed` 状态筛选、side chat、可调整 pane、Artifact 持续视图和 Summary/Normal/Verbose 透明度。
- 从 assistant-ui 复用 thread/message/composer/parts 的组合模型：tool UI 是 message part，不是任意浮层。
- CopilotKit 仅作为 controlled tool UI、HITL、declarative UI 与 sandbox app 分层的二级实现参考；LibreChat 仅作为完整对话产品的补充观察对象。
- Craft 不直接引入这些 runtime。现有 Pi RPC revision、extension ownership、sandbox bridge、WebUI/Electron capability contract 和 universal dock 仍由 Craft 自己实现。
- VS Code/JupyterLab 只作为 universal dock、overflow 和用户可移动布局的二级参考，不再决定对话 surface。

Open WebUI 适合做产品观察，但当前许可证包含品牌保留限制，因此不作为可复用实现候选：[License](https://github.com/open-webui/open-webui/blob/main/LICENSE)。

## 3. 关键证据

### 3.1 先确定对话归属，再确定位置

作者必须先回答：

1. 哪个事件产生了这块 UI：message、tool call、turn、session task、workspace tool 还是 app setting？
2. 用户完成操作后，agent 是否需要拿到结果继续当前 run？
3. 内容是一次性反馈、可折叠历史，还是需要长期并行操作？
4. 用户离开当前消息后，是否仍需要随时看到它？

推荐映射：

| 任务语义 | 默认位置 | 升级条件 | 不应使用 |
|---|---|---|---|
| Tool running / arguments / result | 对应 tool call 的 inline tool card | 结果成为可持续编辑对象时打开 workspace content | window corner、全局 overlay |
| Agent 追问、审批、选择、确认 | 对应 tool/turn 的 inline HITL card | 跨会话等待时同时加入 task status 摘要 | composer 上方的无归属表单、modal 默认路径 |
| 对消息的引用、校验、来源、解释 | message part / annotation | 需要完整检查器时打开 workspace content | sidebar、window action |
| Reasoning / trace / debug detail | 消息内折叠 section | 需要全局诊断时打开独立 tool | 默认常开大卡片 |
| Artifact、文件、网页结果 | inline preview + Open action | 阅读、编辑、对比或持续操作时打开 workspace content | 把完整编辑器塞进消息流 |
| Review finding / changed files | finding 绑定对应 message、文件和 range；changed-files 使用紧凑摘要 | 多文件 diff、筛选、批量处理时打开 workspace content | 在 transcript 内嵌完整 diff viewer |
| 当前会话的短状态 | thread tail 或 composer status | 离开当前会话仍需跟踪时加入 task status | permanent sidebar module |
| 后台任务、子会话、计划总览 | host-owned task status popover | 用户显式打开检查器时进入 workspace content | right workbench 常驻摘要 |
| 影响下一次发送的模式/附件/命令 | composer toolbar / above | 形成独立工作流时进入 inline HITL 或 content | message annotation |
| 完整扩展模块 | navigation command -> workspace content | N/A | 完整 sandbox app 直接占 sidebar |
| workspace 内短列表 | workspace sidebar section | 内容超过短列表或需要复杂操作时进入 content | 自建第二层全局 sidebar |
| 设置、模型默认值、凭据 | extension settings | N/A | session contribution |
| 与 agent run 无关的一次性系统确认 | `ctx.ui.confirm/input/select` | N/A | 持久 contribution |

关键修正是 HITL：如果问题由 agent 的当前 run 产生，它应作为对话中的一等消息 part，回答后在原位显示 resolved state，agent 再继续。只有不属于对话因果链的系统交互才优先使用 modal。

### 3.2 V2 presentation contract

V2 应使用受约束的 discriminated union，避免任意组合出不合理位置。下面是设计形状，不是当前可调用 API：

```ts
type ExtensionPresentationV2 =
  | {
      kind: "message-part";
      target: { kind: "message" | "tool" | "turn"; id: string };
      part: "tool" | "result" | "question" | "annotation" | "review-finding" | "artifact-preview" | "trace";
      lifecycle: "streaming" | "waiting" | "resolved" | "failed";
    }
  | {
      kind: "thread";
      slot: "before-first" | "after-last";
      role: "context" | "summary";
    }
  | {
      kind: "composer";
      slot: "toolbar" | "above" | "status";
      role: "next-message-action" | "next-message-state";
    }
  | {
      kind: "task-status";
      scope: "session" | "workspace" | "global";
      state: "working" | "needs-input" | "completed" | "failed" | "scheduled";
      unread?: boolean;
      summary: string;
      open?: ExtensionCommand;
    }
  | {
      kind: "workspace-content";
      title: string;
      icon: ExtensionIcon;
      stateScope: "session" | "workspace" | "global";
      instancePolicy: "singleton" | "multiple";
      preferredGroup?: "active" | "adjacent";
    }
  | {
      kind: "navigation";
      scope: "workspace" | "global";
      action: ExtensionCommand;
    };
```

`task-status` 是结构化数据贡献，不是让扩展渲染任意浮层。Craft 统一把所有来源聚合为 `Needs input / Working / Completed / Scheduled / Unread`，负责排序、去重、attention、已读状态和 overflow；扩展只提供状态、摘要和打开详情的动作。

渲染自由度再单独分层：

| Level | 适用场景 | Craft 边界 |
|---|---|---|
| Host primitive | status、question、tool summary、button、progress、key-value | Craft 渲染、主题化和验证，默认选择 |
| Declarative catalog | 已注册的复杂图表、表格、表单组合 | 扩展提供 schema/data，Craft 从批准组件 catalog 组合 |
| Sandbox app | 独立应用、未知 MCP UI、完整自定义交互 | iframe 隔离、显式权限、host frame、semantic bridge |

placement 与 renderer level 正交：sandbox app 可以是 message part 或 workspace content，但不能因为使用 sandbox 就自行选择绝对坐标。

V1/V2 关系：

- `conversation.message/tool/turn.*` -> `message-part`，保留 before/after 仅用于旧 payload 排序。
- `conversation.inline` -> `thread.after-last`。
- `composer.*` -> `composer`。
- `workspace.content` -> `workspace-content`，`workspaceContent.preferredGroup` 只表达首次打开到当前组或相邻组。`workbench.right` 被明确拒绝，不提供 alias 或 adapter。
- `sidebar.*` / `navigation.item` -> `navigation` 或 workspace short section。
- `window.topLeft/topRight` -> host-owned app action/status overflow；新扩展不依赖具体角落。

### 3.3 Conversation-first visual language

整体方向是安静、连续、可扫描。对话是主画布，不把每个 extension contribution 都变成独立 card。

Conversation：

- 扩展贡献继承 Craft 当前 message/tool 容器，不得给既有对话内容额外再包一层外卡片；这条规则不要求重做 Craft 现有用户或 assistant 消息样式。
- annotation/source/status 使用低强调行或折叠 section；只有需要边界和交互的 tool/HITL/Artifact preview 才使用 card。
- tool card header 固定一行：icon、tool label、状态、duration、展开控制。运行时展开关键进度，完成后默认收起明细并保留结果摘要。
- 多个连续的轻量 tool call 由宿主分组，避免形成长串重复卡片。
- HITL question card 原位展示 pending/resolved/expired；提交按钮统一使用 Lucide `ArrowUp`，选择项使用 radio/checkbox/segmented control 等匹配语义的控件。
- Artifact preview 只显示类型、标题、摘要/缩略内容和 Open action；完整 viewer/editor 打开 workspace content。
- reasoning/trace 视觉低于最终回答，不默认抢占阅读焦点。

Composer：

- 只接纳会改变下一条消息的 UI：模式、附件、作用域、发送前检查和相关 action。
- extension action 进入现有 toolbar/overflow，不再创建第二套 composer chrome 或第二个发送按钮。
- status 不改变 composer 的稳定尺寸；长内容升级为 popover 或 inline message part。

Transparency / detail level：

- Craft 拥有 `Summary / Normal / Verbose` 选择，扩展提供结构化 `summary`、`detail` 和可选 `trace`，不能各自发明密度开关。
- Summary 只保留结果、等待用户的动作、失败和 changed-files 等关键摘要；已完成的普通 tool 默认折叠。
- Normal 展示运行步骤、重要参数和结果，作为默认模式。
- Verbose 展示可安全公开的完整 tool 输入、输出和 trace，但仍遵守权限、secret redaction 和内容上限。
- detail level 只改变信息展开程度，不改变 contribution 的因果归属、placement 或生命周期。

Workspace content：

- Craft 拥有 tab、标题、icon、拖拽、detach、close、权限和错误恢复；扩展只渲染 body/内部 toolbar。
- 扩展不重复 app title bar，不假设自己在右侧，不使用全局 fixed positioning。
- 即使 `stateScope` 是 global，渲染出来的 tab/window 仍属于当前 workspace layout，绝不混入其他 workspace 内容。

Host-rendered style contract：

- 扩展只声明 `tone`、`emphasis`、`density` 和语义组件，不传 CSS、颜色、圆角、阴影或字体。
- `tone`: neutral / info / success / warning / danger。
- `emphasis`: quiet / normal / strong；一个 contribution 最多一个 strong action。
- `density`: compact / regular；宿主可按 presentation 和 viewport 覆盖。
- 熟悉命令使用 Lucide icon；不熟悉 icon 必须有 accessible name 和 tooltip。
- Button、badge、progress、empty/error state 和 focus ring 由 Craft primitive 渲染。

Sandbox style context：

```css
/* color */
--craft-canvas; --craft-surface; --craft-surface-subtle;
--craft-text; --craft-text-muted; --craft-border; --craft-focus;
--craft-accent; --craft-info; --craft-success; --craft-warning; --craft-danger;

/* typography */
--craft-font-sans; --craft-font-mono;
--craft-font-xs: 12px; --craft-font-sm: 13px; --craft-font-md: 14px;

/* geometry */
--craft-space-1: 4px; --craft-space-2: 8px; --craft-space-3: 12px;
--craft-space-4: 16px; --craft-space-6: 24px;
--craft-radius-sm: 4px; --craft-radius-md: 6px; --craft-radius-lg: 8px;
--craft-control-compact: 28px; --craft-control-regular: 32px;

/* motion */
--craft-motion-fast: 120ms; --craft-motion-normal: 180ms;
```

Surface metrics：

| Presentation | Typography | Spacing/frame | Action limit |
|---|---|---|---|
| Inline annotation | 12-13px | 4-8px, no card | 1 secondary action |
| Tool/HITL card | 13px | 8-12px, radius <= 8px | 1 primary, 2 secondary |
| Composer affordance | 12-13px | 28-32px controls | 1 visible, rest overflow |
| Task status popover | 12-13px | 320-420px wide, max 60vh | grouped by task/session |
| Sidebar short section | 12-13px | 28-32px rows | row menu for secondary actions |
| Workspace content | 13-14px | host header; body 12-16px | tool toolbar with overflow |

Shared visual rules：

1. 不嵌套 card；只有重复实体或独立交互单元使用 card，圆角不超过 8px。
2. 不使用装饰性渐变、发光 orb、大面积品牌色背景或营销式 hero。
3. 状态不能只靠颜色；始终配合 icon、label 或可访问描述。
4. 文本必须截断或换行，动态内容不能改变 toolbar/control 的稳定尺寸。
5. 每个交互 UI 实现 streaming/loading、waiting、resolved、empty、error、disconnected、unsupported 和 permission-denied 中适用的状态。
6. 支持键盘导航、可见 focus、200% zoom、reduced motion、light/dark/high-contrast。
7. sandbox 可在数据内容区表达自己的视觉风格，但 shell、message rhythm、tab 和共享动作继续使用 Craft 语言。

### 3.4 Host frame and live context

Sandbox 初始化和更新消息应至少提供：

```ts
type CraftPresentationContextV2 = {
  schemaVersion: 2;
  presentation: ExtensionPresentationV2;
  frame: "inline" | "card" | "popover" | "content";
  density: "compact" | "regular";
  detailLevel: "summary" | "normal" | "verbose";
  colorScheme: "light" | "dark" | "high-contrast";
  viewport: { width: number; height: number };
  tokens: Record<string, string>;
  capabilities: { resize: boolean; openContent: boolean; detach: boolean; validation: boolean };
};
```

宿主在 theme、density、detail level、container size、reduced motion 或 capability 变化时发送同一 schema 的更新。扩展不得通过窗口宽度推断自己位于右侧、WebUI 或 Electron。

冲突顺序：

1. 对话因果归属和 target identity。
2. 用户已经做出的 move/pin/collapse 选择。
3. Craft 核心控件和安全提示的保留空间。
4. 当前 run 与 workspace 的上下文相关性。
5. `needs-user` / failure 等语义 attention。
6. 稳定 extension ID + contribution ID。

扩展数字 priority 不能越过前五层，也不能自动抢焦点。

### 3.5 验收不变量

- Tool/HITL/Artifact preview 与产生它的 message/tool target 一起恢复、滚动、归档和清理。
- 回答 HITL 后卡片原位进入 resolved state，同一 agent run 继续，不生成失去上下文的浮动表单。
- 任意 extension contribution 都不能遮挡发送、停止、workspace 切换、窗口控制或权限确认。
- narrow viewport 先折叠 tool detail 和 overflow 扩展 action，再收缩核心控件。
- 同一 workspace 的 content tab 可移动、分组和 detach；一个窗口绝不混入另一 workspace 的内容。
- theme 切换后 host-rendered 与 sandbox 在一帧更新周期内进入一致主题，不闪白、不保留旧 token。
- extension reload/runtime reset 后没有残留 message part、status、tab、validation identity 或旧 revision。
- semantic snapshot 能识别 extension、target、presentation、lifecycle、状态和 action，无需暴露原始 DOM。
- Electron 与 WebUI 按各自 capability contract 验证；WebUI 不伪造 native browser/window 能力。

关键外部证据：

- [Codex 官方产品页](https://openai.com/codex/)把 workspace/task 列表、任务 transcript、进度事件和稳定 composer 放在同一个 Agent 桌面壳层；完整 Review 是相邻 panel group 中的普通 `Review` tab，`All files` 文件树是该 workbench 的内部 navigator，而不是全局右栏。并行智能体、skills 与 scheduled automation 同样由宿主提供统一入口。
- 2026-07-17 的 Codex 实机截图进一步确认：左栏按 workspace 直接列出 recent sessions；命令与已查看图像在 transcript 中使用低强调、可折叠事件；文件变更以单条摘要靠近 composer；右侧“环境信息”由顶栏动作打开为临时 popover，而不是扩展固定右栏。
- [Claude Desktop navigation](https://claude.com/resources/tutorials/navigating-the-claude-desktop-app)、[Claude Code Desktop redesign](https://claude.com/blog/claude-code-desktop-redesign)、[Agent view](https://claude.com/blog/agent-view-in-claude-code)和[Artifacts](https://claude.com/blog/artifacts-in-claude-code)共同验证并行 session、状态聚合、可调整辅助面、detail level 和持续 Artifact 的产品模式。
- assistant-ui 的 `MessagePrimitive.Parts` 把 text、image、tool call 等建模为 message parts，tool UI 由 part pipeline 解析；`ThreadPrimitive` 同时处理 scroll、stream、composer footer 和 thread switch。
- CopilotKit 把 tool call、live status、result 和 HITL 放在 chat 因果链中，并区分 controlled component、declarative schema 与 sandbox UI，可作为渲染层级的二级实现证据。
- IDE 类参考只证明持久工具可移动和 overflow 有价值，不能决定对话因果 UI 的默认位置。

## 4. 风险与回滚

- Risk 1: Codex 与 Claude 是持续演进的闭源产品，逐像素模仿会让 Craft 被某个版本绑住。
- Mitigation: 只提炼稳定的任务语义、信息层级和升级路径；Craft visual tokens、协议与布局所有权保持独立。
- Risk 2: message-part 模型让扩展误以为所有 UI 都必须塞进 transcript。
- Mitigation: 文档明确升级阶梯；需要持续操作、编辑或并行查看时直接打开 workspace content。
- Risk 3: 旧 `before/after` contribution 无法可靠推断 part 类型。
- Mitigation: V1 保持原样渲染；只有显式 V2 payload 才进入 message-part renderer，迁移 adapter 只做无损映射。
- Risk 4: HITL inline 化与当前 `ctx.ui.select/confirm/input` 生命周期不同。
- Mitigation: 保留现有 modal API；新增 conversation-bound question contribution，不修改旧调用语义。
- Risk 5: declarative catalog 扩大宿主组件维护面。
- Mitigation: V2 首期只定义边界，不立刻实现 catalog；先用 host primitive 和 sandbox 覆盖真实需求，再从重复模式中提炼。
- Risk 6: sandbox token 集膨胀成第二套 design system。
- Mitigation: 只暴露语义 token 和稳定 metrics，不暴露 Tailwind/Radix 私有类。
- Risk 7: 扩展把 `preferredGroup: "adjacent"` 当成永久右侧位置并依赖其坐标。
- Mitigation: 协议和作者文档明确它只影响首次打开；用户移动、分组、detach 和保存布局后，扩展不得重新抢占位置。
- Rollback trigger: V2 导致消息 target 错配、agent run 无法恢复、核心操作被遮挡、workspace 内容混合或 sandbox 更新循环。
- Rollback action: 按 schemaVersion 关闭 V2 presentation resolver，继续使用 V1 explicit surfaces；不回退 runtime revision、安全 bridge 和 cleanup 边界。

## 5. 下一步执行

1. 先做 doc-only 收敛：作者指南从 surface 清单改为 message/tool/HITL/Artifact/composer/task/workspace 的选择表，并明确升级阶梯。
2. 补齐 V1 低风险一致性：badge tone 实际渲染、文本色改用语义 token、sandbox theme/context update 和基础 style recipe。
3. 为 `message-part` 增加显式 part/lifecycle/target contract，先覆盖 tool rendering、HITL question、review finding 和 Artifact preview 四个高价值场景。
4. 增加 host-owned task status popover，统一 `Needs input / Working / Completed / Scheduled / Unread`，承接 background task、plan、TODO、automation 和 child-session summary；详情仍由用户打开 content tool。
5. 继续用 `workspace.content` 的真实扩展示例验证 active/adjacent 初始放置、用户移动、分组、detach、恢复和 workspace isolation；不恢复方向型 surface。
6. 用 source-only `craft-ui` 验证 streaming -> waiting -> resolved、tool grouping、Summary/Normal/Verbose、thread switch/reload、theme switch、compact overflow、content move/detach 和 workspace isolation。
7. 三类真实扩展示例通过验收后，再决定是否从重复 UI 中提炼 declarative component catalog。

相关本地文档：

- [Pi Extension GUI Architecture](./pi-extension-gui.md)
- [Craft GUI Extensions Author Guide](../../apps/electron/resources/docs/pi-extensions.md)

# 模块档案与前端文档语义核对

状态：已达成共识（前端文档修订项已明确；个别代码命名对齐项待代码侧执行）

开始时间：2026-08-13 12:00 CST (UTC+08:00)

结束时间：2026-08-13 14:30 CST (UTC+08:00)

## 背景

用户要求对照各模块档案（`.agents/modules/*.md`）检查 `docs/product-semantics.md` 与代码之间是否存在重要语义遗漏或语义偏差，并要求不遗漏前端文档（`apps/electron/resources/docs/*.md`）的缺失与偏移。采用 8 个并行只读核对子任务完成（5 组模块档案 + 3 组前端文档），未修改文件、未运行测试。

## 过程记录

### 2026-08-13 12:00 CST（模块档案核对，5 组并行）

- 观点：逐档案对照“模块档案 → 语义文档 → 代码”三方取证，只报告实质问题。
- 依据：25 个模块档案 frontmatter（entrypoints/不变量/验证）与 `docs/product-semantics.md` 全文（462 行）、`docs/architecture/*.md` 专题文档、抽查实现代码。
- 冲突：无。

### 组1：session-lifecycle / workspace-state / conversation-ui / session-tooling / pi-agent-engine

- 观点：
  - `session-tooling` 档案归属偏差：档案声称拥有 child-session controls，但实际实现位于 `packages/shared/src/agent/pi-agent.ts:2120-2260` 与 `packages/server-core/src/sessions/SessionManager.ts:4855-4924`，`subagent` handler 为 null、经 HTTP callback 执行（`packages/session-mcp-server/src/index.ts:239-253`）；档案 entrypoints 未覆盖这些实现位置，按档案定位代码会漏。
  - `conversation-ui` 斜杠命令可见性规则未沉淀：档案不变量“slash commands remain visible only for capabilities without a Mortise GUI control”在语义文档与架构专题均无对应；代码确认为有意设计（`FreeFormInput.tsx:862-864` 内置 `activeCommands = []`，扩展命令动态加入）。
  - 空白 Workspace Draft 细节未沉淀：语义文档只写“进入 Workspace 级空 Draft”，未明确“完整 composer、无欢迎语/预设提示”（代码 `NewConversationPage.tsx:402-439` 确认）。
  - 低优先：hidden internal sessions“保留不可见持久化语义直到单独迁移”（session-lifecycle 档案）；Session 存储归属 Mortise Agent root、与 `<workspace>/.mortise` 分离（workspace-state 档案）。
- 依据：上述代码与档案行号。
- 冲突：无。

### 组2：extension-runtime / extension-ui / pi-coding-runtime / provider-model-runtime / browser-runtime

- 观点：
  - 【高】读图代理配置字段名不一致：语义文档与讨论纪要均写 `visionProxyModelId`，代码实际为 `visionProxy`（`{ provider, model }` 对象，`packages/shared/src/config/pi-provider-models.ts:23`），运行时（`pi/packages/coding-agent/src/core/vision-proxy.ts`、`model-registry.ts`）均用 `visionProxy`。实现结构能唯一锁定 provider 下模型，语义更精确；文档/纪要需与代码对齐。
  - 【中】“应用启动时不得扫描或执行未打开 Workspace 的项目 Extension”安全边界未写入语义文档（档案 `extension-runtime.md:59`；代码 `SessionManager.ts:2410` initialize 只 openGlobal）。
  - 【中低】pi 生产 headless 图禁止 import TUI/terminal 组件、不得残留 interactive/standalone CLI/launcher/updater/terminal asset 或 fallback entrypoints（fail-closed guard）未进入构建章节（档案 `pi-coding-runtime.md:44-52`）。
  - 低：并发 warmup 单飞行（`backend-extension-runtime.ts:88-107`）、provider 事件归一化（`pi/packages/ai` stream 接口）、native pane occlusion follows dock geometry（`browser-pane-manager.ts`）属档案已承载的内部合同，语义文档可不覆盖。
  - 低：协议层 `allowOther`（`extension-interactions.ts:51,74`）与 renderer 无条件渲染自由填写输入框不一致，实现行为符合产品语义，属协议字段冗余待清理。
- 依据：上述代码与档案行号。
- 冲突：无。

### 组3：automations / messaging / shared-contracts / headless-server-cli / file-workbench

- 观点：
  - 【中】Messaging 绑定粒度未沉淀：Telegram 论坛超级群组话题（`message_thread_id`）参与 binding 键 `(platform, channelId, threadId)`（`messaging-gateway/src/router.ts:84-86`、`binding-store.ts:34-46`、`adapters/telegram/index.ts:244-245,277-281`），语义文档只写“稳定的 Workspace/Session 上下文”。
  - 【低】`packages/messaging-gateway/src/index.ts:4-5` 包注释只写 Telegram & WhatsApp，未反映 Feishu/Lark；包入口未导出 `LarkAdapter`，但 registry 实际接线三种平台（`registry.ts:31-33`、`types.ts:12`）。
  - automations、shared-contracts、headless-server-cli、file-workbench：无实质遗漏/偏差，核心语义均已覆盖，专题规范由 `automations-protocol.md` 承载。
- 依据：上述代码行号。
- 冲突：无。

### 组4：native-desktop / web-viewer-clients / universal-layout / shared-ui-i18n / app-settings-security

- 观点：
  - 【高】凭据安全语义未沉淀：provider definitions 永不携带凭据、API keys 只经显式凭据参数进入规范 auth store、secrets 永不通过普通 DTO 暴露（档案 `app-settings-security.md:56`；代码 `provider-metadata.ts`、`credentials/manager.ts:132-139`、`onboarding.ts:37-38` 掩码）。
  - 【中-高】`state.sqlite` 唯一权威与退役 JSON 合同未沉淀：退役 JSON 忽略且不改动（`state-contract.ts:3`、`storage.ts:781-797`）。
  - 【中】一次性根迁移边界：跨进程串行、只导入特定项，sessions/providers/credentials/defaults 与无关设置绝不导入（档案 `app-settings-security.md:56`）。
  - 【中】onboarding 首次引导产品语义未沉淀（`onboarding.ts`、`components/onboarding/`）。
  - 【中低】viewer 作为第三种只读客户端未列入“客户端与平台能力”（`apps/viewer/src/App.tsx:8-15`，支持上传 session JSON 与 `/s/{id}` 共享查看）。
  - 【中低】开发自动登录 localhost 安全边界未沉淀（`scripts/start-webui.ps1:160,168-169` 绑定 `127.0.0.1`、`MORTISE_WEBUI_AUTO_LOGIN` 控制）。
  - 【低-中】本地化/翻译 parity（`scripts/check-i18n-parity.ts:44-79` 强制 locale 键一致）与主题语义（`~/.mortise/theme.json`、`packages/shared/src/config/theme.ts`）未沉淀。
  - 【低】自动更新语义（`MORTISE_UPDATE_URL` 显式配置、不默认启用，`auto-update.ts:66`）。
  - 偏差说明：档案“state.sqlite 唯一权威”与代码仍在读写 `preferences.json`/`theme.json` 并存不矛盾——前者是全局 AI 配置/草稿，后者是独立 UI 偏好/主题。
- 依据：上述代码行号。
- 冲突：无。

### 组5：build-release-observability / ui-validation-developer-kit / sources-skills-mcp / product-semantics（档案）/ project-modules

- 观点：
  - 【高】`apps/electron/resources/docs/skills.md:16` 声称 “Skills can pre-approve specific tools to run without prompting”，但无任何实现（skill 元数据只有 name/description/globs/icon，Pi 只解析 name/description/disable-model-invocation/icon），与产品权限语义（权限只提供“询问”/“始终批准”，由 Extension 提供）直接冲突。
  - 【中】`skills.md:15` 声称 “Skills can be automatically triggered by file patterns (globs)”，但运行时无 globs 自动触发逻辑，globs 只在元数据中保留。
  - 【中】Skill 激活机制未沉淀：用户 `/skill:name args` 斜杠命令展开（`agent-session.ts:1799-1812`）、模型经系统提示自动发现并读取（`system-prompt.ts:85-88`）、`disable-model-invocation` 控制模型可见性（`skills.ts:316,332-336`）。
  - 【低-中】Skill 导入/导出无语义（`resources.ts:1-23` 打包 skills 与 automations 资源 bundle、`SkillImportDialog.tsx`）。
  - build-release-observability、ui-validation-developer-kit、product-semantics 档案、project-modules：无实质遗漏/偏差。
- 依据：上述代码行号。
- 冲突：无。

### 2026-08-13 13:00 CST（前端文档核对，3 组并行）

- 观点：前端帮助文档是用户可见产品说明，必须与实现一致；重点查“文档声明但代码没有实现（虚报）”“代码有但文档缺失/过时”“文档与产品语义冲突”。
- 依据：13 份 `apps/electron/resources/docs/*.md` 全文与实现代码、`docs/product-semantics.md`。
- 冲突：无。

### 前端组A：skills / themes / automations / mortise-cli / tool-icons

- 观点：
  - 【最高】`mortise-cli.md` 大量虚构命令面：`mortise label *`（24-62 行）、`mortise skill *`（70-112 行）、`mortise theme *`（156-209 行）、`--discover`（14 行）均无实现；`--json` 是输出 flag 而非结构化输入（`index.ts:90-91`）；JSON 信封/退出码 0/1/2/`USAGE_ERROR` 输出合同虚构（实际 `out()` 纯文本、错误 `Error:` + `exit(1)`，`index.ts:226-231`）；二进制名为 `mortise-cli` 而非 `mortise`。Automation 一节与实现一致。
  - 【高】`skills.md` 预授权工具、globs 自动触发虚报；斜杠命令形式错误（实际为 `/skill:` 前缀 + `skill:{name}` 命令，`agent-session.ts:1799,3118`）；“CLI-first”推荐指向不存在的 `mortise skill`。
  - 【中】`themes.md` “Decoupling Protocol” 章节描述的 `ctx.ui.setWidget(key, string[], {placement})` / `renderFn(width, theme)` 扩展 API 在代码中不存在，实际 API 为 `ui.upsertContribution/removeContribution`（`extensions/types.ts:382-386`）。
  - 【中】`automations.md` 示例 ID 一律含下划线（`automation_daily_summary_01` 等），会被 V3 schema `OPAQUE_ID` 拒绝（`v3-schemas.ts:4-6`）；“never literal passwords or tokens”对 `headers` 字段不成立（`automation-webhook-executor.ts:31-42` 原样发送非 `${mortise-secret:id}` 值）。
  - 【低】`tool-icons.md` 显示尺寸 20x20px 与实际 12x12px（`TurnCard.tsx:169` `w-3 h-3`）不符；“重启或新开聊天生效”过时（`cli-icon-resolver.ts:339-344` 每次事件重读）。
- 依据：`apps/cli/src/index.ts`、skills/theme 相关实现行号。
- 冲突：无。

### 前端组B：html-preview / markdown-preview / mermaid / pdf-preview / image-preview / data-tables

- 观点：
  - 【高】`data-tables.md` filter/search 虚报（`MarkdownDatatableBlock.tsx` 只有排序与分组，无搜索/过滤）；spreadsheet 排序虚报（`MarkdownSpreadsheetBlock.tsx` 无排序）；date 列类型不会格式化为 “Jan 15, 2025”（`formatCell` 无 `case 'date'`）。
  - 【高】`pdf-preview.md` fullscreen 分页按钮/页计数器不存在（`PDFPreviewOverlay.tsx:151-159` 一次性渲染全部页）；“remaining pages load on-demand”不成立。
  - 【中】`image-preview.md` 内联高度 400px 实为 320px（`MarkdownImageBlock.tsx:227`）；多图是滑动卡片堆叠而非 tab 懒加载（`MarkdownImageBlock.tsx:132-192,241-249`）；header item navigator 只存在于全屏 overlay。
  - 【中低】`html-preview.md` 链接导航并非 Blocked：实际 `<base target="_top">` + `allow-top-navigation-by-user-activation`，Electron `will-navigate` 拦截后系统浏览器打开；外链字体/CSS 受 CSP 限制（`font-src 'self' data: https://fonts.gstatic.com`），非“no external stylesheet restrictions”。
  - 【低】`markdown-preview.md` file:// 并非被阻止：`link-target.ts:38-61` 规范化文件路径并走 `onFileClick` 应用内打开。
  - mermaid.md 无实质问题；缺失项（datatable 全屏导出、spreadsheet formula 类型、mermaid 失败回退普通代码块等）为补充类。
- 依据：packages/ui 相关组件行号。
- 冲突：无。

### 前端组C：pi-extensions / browser-tools

- 观点：
  - 【高】`pi-extensions.md:1003-1008` “Widget Convenience API” 整节宣传已删除的 `ctx.ui.setWidget(key, string[], {placement})`：当前 `ExtensionUIContext` 只有 `upsertContribution/removeContribution/clearContributions/publishFrontendState/interact/select/confirm/input/notify`（`extensions/types.ts:377-406`）；git 历史确认 `setWidget` 在提交 `27193034a` 被移除。`themes.md:43` 同源过时。
  - 【中】`browser-tools.md:219` “Browser tools are allowed in Explore/Safe mode by default” 引用不存在的模式概念：当前权限只有 `ask`/`allow-all`（`mortise-permissions/index.js:4,26-28`），无 Explore/Safe 模式。
  - 【低-中】`docs/product-semantics.md:362` 与 V2 渲染器模型存在语义张力：362 行说“Extension GUI 不是 Extension 代码进入 Mortise renderer”，但 `:384` 与 `extension-ui-v2.md` 说 UI 模块在 renderer 加载——需修订 362 行口径。
  - 【低】`pi-extensions.md` manifest 字段表缺 `subagents`（合法且严格校验，`extension-manifest.ts:373-398`）；`interact` 方法、`activation` 取值（`startup|beforeFirstRequest|lazy`）未列。
- 依据：上述代码行号与 git 历史。
- 冲突：无。

## 最终共识

1. 语义文档需补充的遗漏（并入 `docs/product-semantics.md`）：
   - “设置与模型选择”或“规范数据与兼容边界”补凭据安全语义（provider 定义不携带凭据、显式凭据入口、secrets 不通过普通 DTO 暴露）。
   - “规范数据与兼容边界”补 `state.sqlite` 唯一权威与退役 JSON 忽略不改动合同、一次性根迁移边界。
   - “Messaging 语义”补 binding 粒度 `(platform, channelId, threadId)`（Telegram 论坛话题）。
   - “Extension 语义”补启动时不扫描/执行未打开 Workspace 项目扩展的安全边界。
   - “Skills 与管理界面”补激活机制（`/skill:` 斜杠命令、模型自动发现、`disable-model-invocation`）与导入导出语义。
   - “构建与发布”补 pi 生产 headless 图禁止 TUI/终端资产与交互入口的构建不变量。
   - “客户端与平台能力”补 viewer 只读客户端、开发自动登录 localhost 边界、本地化/翻译 parity、主题语义（低优先）。
   - “设置与模型选择”补 onboarding 首次引导语义（低优先）。
   - “Draft、Session 与 Agent 运行”补斜杠命令可见性规则、空白 Workspace Draft 的完整 composer 无欢迎语细节（低优先）。
2. 读图代理配置字段以代码为准统一为 `visionProxy`（`{ provider, model }`），语义文档与 `2026-08-12-vision-proxy-dual-layer.md` 纪要同步修订；代码侧无需改动。
3. 前端文档修订原则：删除/修正所有“文档声明但代码无实现”的虚报项，行为描述按当前代码对齐。涉及 `mortise-cli.md`、`skills.md`、`themes.md`、`automations.md`、`tool-icons.md`、`data-tables.md`、`pdf-preview.md`、`image-preview.md`、`html-preview.md`、`markdown-preview.md`、`pi-extensions.md`、`browser-tools.md`（mermaid.md 仅补充类可选）。
4. 模块档案修订：`session-tooling.md` 的 entrypoints/归属补 child-session controls 实际实现位置（`pi-agent.ts`、`SessionManager.ts`、`session-mcp-server` HTTP callback）；`messaging-gateway/src/index.ts` 包注释补 Feishu/Lark（代码注释，随下次代码变更处理，本次不改源码）。
5. 待决定/低优先（本次不写进语义正文，避免噪音）：并发 warmup 单飞行、provider 事件归一化、native pane occlusion、`allowOther` 协议冗余清理、hidden internal sessions 迁移细节、自动更新策略。`replace` 类高自由 surface 长期边界维持既有“待决定”标记。

## 语义文档落点

- `docs/product-semantics.md`：按共识 1、2 修订（本次执行）。
- 前端文档（`apps/electron/resources/docs/*.md`）：按共识 3 修订（本次执行）。
- `.agents/modules/session-tooling.md`：按共识 4 修订 entrypoints 与归属表述（本次执行）。
- 前端组C 记录的 `docs/product-semantics.md` Extension GUI 口径张力（原 362 行）已修订：区分 V1 host-rendered 贡献与 V2 renderer 前端模块两种形态，消除与“UI 模块在 renderer 加载”的矛盾。
- 本纪要记录推导过程，不替代上述规范文档。

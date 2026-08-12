# 读图代理模型：双层方案（自动转录兜底 + 按需读图工具）

状态：已达成共识（实施中）

开始时间：2026-08-12 20:10 CST (UTC+08:00)

## 背景

上一轮纪要（`2026-08-12-model-settings-tags-and-tagged-only-mode.md`）将"给没有读图能力的模型指定另一个模型作为读图代理"标记为待决定，并完成对 codex-rs / DeepSeek-Reasonix / grok-build / oh-my-pi 的源码调研。本轮基于调研结论确定实现形态。

## 过程记录

### 调研结论（先行证据，research-vision-model-patterns 会话产出）

- codex-rs：`view_image` 工具 + `input_modalities` 硬门控，模型无视觉时工具直接报错、历史图片替换为占位文本；无代理模型设计。
- DeepSeek-Reasonix：`vision` / `vision_models` 配置做能力门控，无视觉模型只拿占位符，建议使用外部 OCR/vision 工具但无内建。
- grok-build：`image_description_model` 配置（CLI > ENV > config > 默认值），用户消息含图时由 vision 模型自动描述并以 `<image><description>` 文本块注入回合（回合级自动转录）；图片落盘 `<session_dir>/assets/` 供 `read_file` 再读；`ImageDescribeCache` 以（图片字节 hash + prompt 指纹）做会话级缓存去重。
- oh-my-pi：与本产品设想最直接对应的先例，双轨并存——`inspect_image` 工具（无视觉模型发起，把 path+question 交给按 `@vision → @default → 活动模型 → 首个图片模型` 优先级解析出的 vision 模型代答，`mode: auto` 只在活动模型无视觉时暴露）与 `describeForTextModels`（回合注入时自动调 vision 模型描述并替换图片，默认开启）；硬性校验 `model.input.includes("image")`。

### 2026-08-12 20:10 CST

- 观点：对比两种实现形式的优劣。
  - 工具调用形式（A）：按需触发、成本可控、可带具体问题（针对性强）、实现轻（复用工具架构）；致命缺陷是**依赖模型自觉**——无视觉模型"看不见"用户贴的图，可能根本不知道图存在而不调用；且无法多轮追问、每次多一次模型往返。
  - 回合级自动转录形式（B）：**不依赖模型自觉、零遗漏**（贴图必有结果）、行为确定可预期；代价是每次有图都消耗一次 vision 调用与上下文 token、描述无问题引导、实现侵入回合管线。
  - 核心权衡：A 的致命缺陷（不知道图存在）恰是 B 的主打能力；B 的成本问题恰是 A 的主打优势。二者解决不同层的问题（上下文可见性 vs 按需深度分析）。
- 依据：调研证据；grok-build 与 oh-my-pi 的默认行为均为自动转录兜底（`describeForTextModels` 默认开启）。
- 冲突：无。

### 2026-08-12 20:15 CST

- 观点：采用双层方案——自动转录（B）兜底保证"图不丢、模型知道图存在"，同时暴露按需读图工具（A）让模型能带具体问题深挖（OCR、细节问答）。
- 观点（防重复）：双轨共用的重复风险由**共享缓存**消解——B 写缓存（key = 图片内容 hash + 归一化问题指纹），A 执行时先查缓存：命中且无新问题 → 直接返回缓存描述（零外部调用）；命中且有新问题 → 把缓存描述作为上下文 + 问题一起发给代理模型（增量调用而非重复调用）；未命中 → 正常调用并写缓存。缓存为会话级（同图跨回合、跨引用路径命中），带 LRU 上限。
- 观点（降级策略）：无代理模型可解析时**不静默丢弃**——图片落盘 + 注入说明文本（提示可用读图工具或配置读图代理模型），与 grok-build "never silently drop the images" 一致。
- 依据：上一轮纪要"调研结论"；grok-build `ImageDescribeCache` 先例（会话级、字节 hash + prompt 指纹）；oh-my-pi `NO_VISION_MODEL_NOTE` 降级文案先例。
- 冲突：无。
- 用户表态：按此双层方案实施。

## 最终共识

1. **读图代理模型为模型级配置**（`PiGlobalModel.visionProxyModelId`，指向另一已配置模型），持久化于 models.json，随全局模型配置透传给 Pi 运行时。
2. **仅在活动模型无图片输入能力（`input` 不含 `image`）时启用**；代理模型自身必须支持图片输入。
3. **双层机制**：
   - B 自动转录：用户消息含图且活动模型无视觉时，回合注入前调用代理模型逐张描述，以结构化文本块替换图片注入回合；图片落盘（会话目录 assets/）供工具引用。
   - A 按需读图工具：无视觉模型可主动调用（参数：图片路径 + 可选问题），由代理模型针对性回答。
4. **共享缓存防重复**：B 写、A 读；命中无新问题零外部调用；带新问题为带上下文的增量调用。
5. **无代理模型可解析时不静默丢弃**：图片落盘 + 注入说明文本，提示配置读图代理模型。
6. 图片描述为内部机制：不改变会话持久化内容（原始图片消息照常持久化），转录只作用于发给 provider 的上下文；中断续接（continueFromHistory）重新走同一转录路径，缓存命中则零成本。

## 语义文档落点

- `docs/product-semantics.md` `## 模型选择与标签` 章节：读图代理模型条目从"待决定"改为正式语义（见下）。
- 本纪要：`docs/product-semantics-discussions/2026-08-12-vision-proxy-dual-layer.md`

## 实现落点（记录，供实施阶段引用）

- Mortise 配置层：`packages/shared/src/config/pi-provider-models.ts`（类型+helper）、`apps/electron/src/renderer/pages/settings/ModelEditDialog.tsx`（读图代理模型下拉）。
- Pi 运行时：`pi/packages/ai/src/types.ts`（`Model.visionProxy`）、`pi/packages/coding-agent/src/core/model-registry.ts`（schema+parseModels 透传）、新增 `pi/packages/coding-agent/src/core/vision-proxy.ts`（解析/描述/缓存）、`transformContext` 接入（`pi/packages/agent/src/agent-loop.ts` 的注入点）、新增读图工具（`pi/packages/coding-agent/src/core/tools/`）。

## 实现阶段补充决定（2026-08-12 实施时）

1. **代理模型引用用 `{ provider, model }` 对象**而非裸 modelId：模型 id 仅在同 provider 内唯一，跨 provider 可能重名；对象形式无歧义。
2. **无代理配置时不做自动猜测**：解析优先级仅限显式配置（`visionProxy` → 校验存在且 `input` 含 `image`）；未配置或配置失效时注入说明文本并提示配置，不自动选“首个支持图片的模型”（避免意外费用与隐私问题）。
3. **inspect_image 注册为 base tool**（`createAllToolDefinitions`，经 `ToolsOptions.visionProxy` 可选注入），而非 SDK custom tool：custom tool 始终注册并立即激活、绕过 `noTools` 控制；base tool 受 `noTools`/白名单/排除名单控制，且按模型能力过滤可见性——当前模型支持图片输入时不激活（与 `web_search` 按模式过滤同一模式）。
4. **自动转录挂载在 agent 的 `transformContext`**（extension `emitContext` 之前）：每次 provider 请求前执行，首次、工具循环内、续接（`continueFromHistory`）路径一致；缓存命中时重新转录零外部调用。`blockImages` 开启时跳过转录（隐私设置优先）。
5. **图片落盘** `<sessionDir>/assets/image-<n>-<hash8>.<ext>`，注入块含绝对路径供 inspect_image 引用；落盘失败不影响描述注入（best-effort）。
6. **共享缓存键**：图片 base64 内容 sha256；转录用固定描述 prompt（同图同需求只调一次），inspect 带新问题时把缓存描述作为上下文增量调用。

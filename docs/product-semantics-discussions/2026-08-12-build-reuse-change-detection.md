# 构建复用语义：默认按当前源码内容寻址，源码变动必须重建

状态：已达成共识

开始时间：2026-08-12 19:30 CST (UTC+08:00)

结束时间：2026-08-12 20:30 CST (UTC+08:00)

## 背景

用户在安装版中发现 pwsh 工具调用打开后 ANSI 转义码（`[32;1m` 之类）裸奔。排查链路：

1. 会话投影数据中的 pwsh 工具结果包含真实 ESC 字符与标准 SGR 序列，`parseAnsi` 正则可完整解析（用真实数据验证过）。
2. 安装版（`E:\Program Files\Mortise`，packaged 0.1.0）中 `TerminalOutput` 与 ANSI 解析器与源码一致。
3. 根因：安装版的 `extractOverlayData` 没有 `pwsh` 分支（只有 `bash/grep/glob`），pwsh 结果落入 generic 纯文本分支，ESC 码原样显示。
4. 进一步根因：源码 `tool-parsers.ts` 在 2026-08-12 18:55:56（提交 `69e8861cb`）已加入 pwsh 分支，但安装版 provenance 显示 `createdAt: 2026-08-11T13:19:37Z`、`buildId: c09934e0`——是 8/11 的旧构建。8/12 18:58 执行的打包（`output/electron-package-cache/builds/bfecad02`）复用了该旧构建。

## 过程记录

### 2026-08-12 19:30 CST

- 观点（用户）：打包应该检测构建是否变动，有变动还复用旧构建是不对的。
- 依据：
  - 实际踩坑：18:55 提交 pwsh 分支，18:58 打包仍产出 8/11 的旧构建并安装。
  - 事实核查：`package-electron.ts` 默认路径调用 `resolveReusableElectronBuildId`，只按 manifest 完整性 + createdAt 取最新构建，**不捕获当前源码、不比较 sourceId**；只有 `--fresh-source` 才执行源码捕获与冷构建判断。
  - 事实核查：`build-developer-kit.ts` 默认路径同样调用 `resolveReusableDeveloperKitBuild`（按 createdAt 取最新）。
  - 事实核查：快速桌面端测试（`ui-validation` / `ui-flows` → `scripts/mortise-ui/controller.ts`）默认直接运行已打包的 Developer Host，只读取宿主 provenance 的 buildId/sourceId 做记录，不检测与当前源码的差异；仅在显式传 `--expected-build-id` 时强校验。
- 冲突：与 AGENTS.md `## Harness` 既有规则冲突："打包默认复用最近一次已验证且身份完整的不可变构建；调用方无需传递构建编号才能获得复用，只有显式要求刷新源码身份时才执行源码捕获和冷构建判断。"该规则无讨论纪要或产品语义文档支撑，属工程侧权衡，未经过产品语义确认。

### 2026-08-12 19:45 CST

- 观点（用户）：记得构建有分块机制，应该只构建有变动的部分，而不是全部重新构建；没变动就直接复用。
- 依据：
  - 事实核查：`build-block-cache.ts`（`runBuildBlock`）已实现块级内容寻址：`inputId = f(块输入文件哈希)`、`blockId = f(inputId + 依赖块 blockId)`，块未变则 `restoreBlockOutputs` 直接恢复缓存产物（`reused: true`）。
  - 事实核查：`runElectronBuild` 将 Electron 冷构建拆为 pi-workspace、pi-binary、electron-main、electron-preload、electron-renderer、electron-resources、electron-packaging-inputs、electron-capsule-assembly 共 8 块，依赖感知。
  - 事实核查：块级缓存只在冷构建内部生效；默认打包路径在包级就复用了整个 capsule，块缓存完全不参与。
  - 事实核查：其他构建入口无块级缓存：`build-server.ts`、`build-session-mcp-server.ts`、`build-wa-worker.ts` 为全量构建；`session-mcp-dev-build.ts` 用 `needsDevBuild`（mtime）做检测。
  - 附带发现：`package.json` 的 `"build": "bun run scripts/build.ts"` 引用的文件在 git 与磁盘上均不存在，为悬空引用。

### 2026-08-12 20:00 CST

- 观点（Agent）：系统已具备内容寻址能力（`captureBuildSource` 用 `git write-tree` 计算 sourceId，`acquireElectronBuild` 的 `buildId = f(sourceId)`），把默认路径改为"先捕获源码身份 → 内容寻址命中才复用"的成本很低：sourceId 计算秒级，materialize 大目录拷贝只在真正需要构建时发生；源码未变动时零构建成本。
- 依据：`electron-start.ts` 已走该路径（`acquireElectronBuild` 默认捕获源码），行为正确；块级缓存保证源码变动时只重建变动的块。
- 冲突：无。

### 2026-08-12 20:15 CST

- 观点（用户）：把打包、Developer Kit 构建、快速桌面端测试三个入口统一纳入该语义修正。
- 依据：三个入口同属"默认复用最近一次产物、源码变动不察觉"的问题模式；只修打包会导致测试仍在跑旧宿主。
- 冲突：无。

### 2026-08-12 20:35 CST

- 观点（用户）：源码冷构建的依赖准备也应纳入复用，普通源码变化不应重新安装完整根依赖和 Pi 依赖。
- 依据：
  - 事实核查：构建块缓存能够复用 Pi、Electron main/preload/renderer/resources 等编译产物，但依赖安装发生在对应块缓存检查之前，因此命中构建块仍可能先等待完整依赖安装。
  - 事实核查：一次遗留隔离快照中的 `node_modules` 约 1.41 GB、106212 个文件，根依赖安装单阶段硬超时为 600000 ms；耗时主要来自重新物化依赖视图，而不是 CLI 本身。
  - 设计结论：依赖身份与普通源码身份分离；根 Bun 依赖和 Pi npm 依赖分别由锁文件、工作区清单、安装配置、工具链和平台寻址，首次安装后原子发布不可变依赖视图，后续隔离快照复用其第三方文件并重建当前快照的工作区链接。
- 冲突：无；这是对既有内容寻址与构建块复用语义的补全。

## 最终共识

1. **构建与打包默认按当前源码内容寻址**：每次构建入口先捕获当前源码身份（sourceId），与既有不可变构建比对；源码未变动才复用既有构建，源码变动则重建。重建时块级缓存只构建变动的块，未变动的块直接复用。
2. **显式指定构建编号可绕过默认语义**：`--expected-build-id`（Electron 打包）、`--source-id`（Developer Kit 外部源码身份）按编号固定复用或校验，不执行默认的内容寻址选择。
3. **快速桌面端测试默认记录宿主构建身份**；宿主 sourceId 与当前源码不一致时输出警告；设置 `MORTISE_UI_REQUIRE_FRESH=1`（或 `--require-fresh`）时提升为启动失败。
4. 原 AGENTS.md 规则"打包默认复用最近一次已验证且身份完整的不可变构建；只有显式要求刷新源码身份时才执行源码捕获和冷构建判断"被本共识取代。`--fresh-source` 参数保留为兼容 no-op（默认行为已等价）。
5. 顺手修复 `package.json` 的 `"build"` 悬空引用（`scripts/build.ts` 不存在）。
6. **隔离依赖按独立身份复用**：根 Bun 依赖和 Pi npm 依赖分别以锁文件、工作区清单、安装配置、工具链与平台建立依赖身份；普通源码变化不得重复安装依赖，只有依赖身份变化时才安装并原子发布新的不可变依赖视图。复用时必须重建当前源码快照的工作区链接，不得携带旧快照路径或共享可变输出。

## 语义文档落点

- `AGENTS.md` `## Harness` 构建复用规则更新为内容寻址语义。
- `docs/product-semantics.md` 新增"构建与发布"章节。
- 本纪要记录推导过程，不替代上述规范文档。

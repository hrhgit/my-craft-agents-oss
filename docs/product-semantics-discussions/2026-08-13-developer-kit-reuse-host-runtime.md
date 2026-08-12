# Developer Kit 分发语义：dev-host 复用本体运行时，取消独立分发与离线开发

状态：已达成共识

开始时间：2026-08-13 03:30 CST (UTC+08:00)

结束时间：2026-08-13 03:55 CST (UTC+08:00)

## 背景

用户反馈 Electron 打包（`electron:dist`）耗时长。经分析，耗时大头之一是 NSIS 压缩（约 1.7 GB 输入、zlib 单线程约 1–2 分钟，实测 23.6 MB/s）。进一步定位到安装包体积本身存在可观的重复：主安装包中的 Developer Kit `dev-host` 携带了一份与 Mortise 本体字节级完全相同的运行时（628 个文件，433.2 MB），另有 201 MB 的 `Mortise Developer Host.exe` 与本体 `Mortise.exe` 结构性重复。重复根因是 Developer Kit 被设计为"独立版本、可单独安装"的完整工具集，dev-host 是独立身份的完整 Electron 应用（`io.github.hrhgit.mortise.devhost`），运行时文件通过继承 `electron-builder.yml` 的 `extraResources` 全部自带。

## 过程记录

### 2026-08-13 03:30 CST

- 观点（用户）：不需要单独安装 Developer Kit，dev-host 应该复用本体；复用不得影响正在使用的本体，而是作为独立测试实例，只复用本体的代码。
- 依据：
  - 事实核查：dev-host 与本体字节级相同的文件为 628 个、433.2 MB（`pi.exe`、`bun.exe`、`uv.exe`、Electron dll/pak/locales 等）；`Mortise Developer Host.exe`（201 MB）与 `Mortise.exe` appId 不同、内容不同，属于结构性重复。
  - 事实核查：dev-host 的验证控制面是构建期编译进 `main.cjs` 的（`__MORTISE_DEV_HOST_BUILD__`），本体生产构建不含该代码；dev-host 的 `main.cjs`（44.7 MB）大于本体（40.1 MB），差异是必要代码，不能删除。
  - 事实核查：dev-host 启动时使用隔离的 `MORTISE_UI_ELECTRON_USER_DATA_DIR`（`app.setPath('userData', …)`），单实例锁按 userData 分离——本体运行中启动 dev-host 测试互不干扰的机制已存在。
- 冲突：与既有语义冲突——`developer-kit/README.md` 及 `docs/architecture/build-release-observability.md` 中 Developer Kit 被描述为"optional, separately versioned / separately installable"的独立工具集；本次讨论决定取消该独立分发语义。

### 2026-08-13 03:45 CST

- 观点（用户）：确认两点——不单独维护 dev-host 版本；不保留离线开发（无本体时也能运行 dev-host）。
- 依据：dev-host 验证控制面跟随主安装包分发与重建；dev-host 运行前置条件为已安装且版本匹配的 Mortise 本体。
- 冲突：无。

### 2026-08-13 03:55 CST

- 观点（Agent）：实现路径分两段——（1）主安装包 stage 时剔除 dev-host 中与本体字节级相同的文件，安装后以同卷硬链接/junction 指向本体同路径文件，安装包直接省约 433 MB、压缩时间线性减少约 26%；（2）`Mortise Developer Host.exe` 与验证控制面代码仍保留在 dev-host 目录，不参与去重。
- 依据：Electron 的 exe 加载 dll/pak/locales 依赖相对 exe 路径，dev-host 目录结构必须保留；同卷硬链接/junction 是只读复用，不影响本体运行。
- 冲突：无。

## 最终共识

1. **Developer Kit 取消独立分发与离线开发语义**：不再单独发布可独立安装的 Developer Kit；dev-host 只随 Mortise 主安装包分发，运行验证以已安装且版本匹配的 Mortise 本体为前提。
2. **dev-host 复用本体运行时**：dev-host 中与本体字节级相同的运行时文件（Electron 运行时、pi、bun、uv 等）在主安装包中不再重复携带，安装后通过同卷链接指向本体同路径文件；dev-host 的 `Mortise Developer Host.exe` 和带验证控制面的 `main.cjs` 仍保留在 dev-host 目录。
3. **版本不单独维护**：dev-host 验证控制面随主安装包版本一起构建、分发和重建，不维护独立版本线。
4. **互不干扰约束**：dev-host 作为独立测试实例运行，使用隔离 userData 与进程，不得影响正在运行的 Mortise 本体。

## 语义文档落点

- `docs/product-semantics.md` "构建与发布"章节新增 Developer Kit 分发语义条目。
- 本纪要记录推导过程，不替代上述规范文档。


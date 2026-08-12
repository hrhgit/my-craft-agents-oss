# Extension 能力组合框架

状态：本阶段已结束

开始时间：2026-08-12 CST (UTC+08:00)

结束时间：2026-08-13 CST (UTC+08:00)

## 背景

Mortise 已支持 Extension 包依赖、Extension UI V2 模块复用和受控 override，但后端 Extension 之间没有稳定的服务发布与消费合同。讨论目标是让一个 Extension 能从多个 Extension 取得公开能力并组合使用，同时保持组合优于继承、独立升级和故障隔离。

## 过程记录

### 2026-08-12

- 观点：Extension 之间的复用不应采用继承或复制内部对象，而应采用具名能力发布与消费。
- 依据：现有 `dependencies` 只检查包存在、版本和加载顺序；UI `modules` 已经体现按模块组合，但后端缺少对应机制。
- 共识：Extension 是安装、升级、卸载和故障隔离单位，能力是组合单位。

### 2026-08-12

- 观点：正式支持公开接口、硬依赖、软依赖和兼容 Extension；源码 Fork 属于平台外的派生开发方式，不需要成为 Mortise 运行时能力。
- 共识：不支持读取其他 Extension 私有对象、源码路径注入、任意 Hook 或 Mixin。兼容 Extension 通过双方公开能力实现联动。

### 2026-08-12

- 观点：UI 模块与后端服务有共同的能力身份，但不能合并为同一种运行时对象。
- 依据：UI 模块在 renderer 中加载 JavaScript，后端服务在 Pi/Workspace runtime 中通过结构化调用执行；两者的进程、生命周期和故障边界不同。
- 共识：统一能力 ID、版本、提供者解析、依赖和诊断；UI 继续使用模块加载，后端服务使用结构化调用。

### 2026-08-13

- 决定：继续扩展 Manifest V1，新增 `provides` 和 `uses`，并迁移旧 Extension 到同一校验器；没有组合声明的旧 V1 Extension 不需要增加空字段。
- 决定：默认自动解析唯一匹配提供者，也允许消费方固定 `provider`；多个匹配提供者属于歧义，不静默按加载顺序选择。
- 决定：首版完成后端服务、统一能力清单和 UI 侧面；多提供者聚合与运行中自动切换不在范围内。
- 决定：服务操作使用 JSON Schema 输入输出合同，运行时在调用边界校验。
- 决定：`mortise-ui` 必须支持能力发现、描述和受限调用。所有公开服务操作默认进入该实机模拟控制面，不另设测试专用实现或验收暴露标记。

## 最终共识

Mortise Extension 通过版本化公开能力组合。提供者决定稳定公开边界，消费方决定选择和组合哪些能力，兼容 Extension 负责连接两个独立 Extension。Mortise/Pi 负责发现、版本协商、作用域、生命周期、调用转发、校验和故障隔离，不理解具体业务组合。

一个能力可以包含后端服务、UI 模块和前端入口侧面。各侧面共享能力身份和提供者绑定，但保持独立运行机制。现有宿主能力 `ctx.capabilities` 与 Extension 间服务必须分离。

必需能力缺失、版本不匹配、歧义或硬依赖循环只阻止消费 Extension 激活；可选能力进入明确降级。单个 Extension 或单次服务调用失败不得阻断其他 Extension 或应用启动。

实机模拟 CLI 使用生产 Extension runtime 和同一服务协议完成发现与调用，支持同时挂载多个开发目录 Extension，并保留 runtime identity、结构校验、取消、超时和证据链。

## 语义文档落点

- `docs/product-semantics.md` 的“Extension 语义”：记录能力作为组合单位、公开接口/软依赖/兼容 Extension、统一身份但分离运行机制，以及故障隔离与提供者解析原则。
- `docs/architecture/extension-capability-composition.md`：记录 Manifest V1、服务 API、作用域、协议、UI 侧面和 `mortise-ui` 验收合同。


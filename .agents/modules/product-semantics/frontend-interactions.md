# 产品语义对应的界面交互

## 范围

本文件记录跨模块且会改变用户理解的交互含义，详细控件和场景仍由业务模块自己的交互文档负责。

| 交互 ID | 产品含义 | 责任模块 |
| --- | --- | --- |
| `product.management.fixed-surface` | 持续、高频的管理留在应用外壳固定内容区 | `universal-layout`、对应业务模块 |
| `product.skills.resolve` | 全局与 Workspace 技能自动发现，Workspace 同名覆盖全局 | `sources-skills-mcp` |
| `product.workspace.empty` | 无 Workspace 时仍显示正常外壳和创建入口 | `workspace-state` |
| `product.workspace.edit-modal` | Workspace 创建与编辑是有边界的短任务，使用同类模态界面 | `workspace-state` |
| `product.layout.toggle` | 右上布局按钮按分组数量执行打开或聚焦/恢复 | `universal-layout` |

当实现与本文含义冲突时，先修正语义或明确产品决定，不能用已有界面偶然行为替代。

当前批量 flow：`product.fixed-management-surface`。

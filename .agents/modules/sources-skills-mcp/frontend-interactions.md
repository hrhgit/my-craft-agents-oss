# 技能界面交互

## 范围

覆盖全局与当前 Workspace 技能的发现、选择、导入、新建和编辑。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `skills.list.resolve` | 打开技能列表 | 无 Workspace 时显示全局技能；有 Workspace 时显示有效合并结果 | `skills.scope-resolution` |
| `skills.create` | 打开固定编辑区并保存 | 默认创建全局技能，可明确切换 Workspace 范围 | `skills.create` |
| `skills.edit` | 从详情进入固定编辑区并保存 | 更新原作用域的 `SKILL.md`，返回对应详情 | `skills.edit` |
| `skills.import` | 选择候选并确认导入 | 仅导入选中项，结果在当前 Workspace 列表中可见 | `skills.import` |

同一 `slug` 冲突时 Workspace 技能覆盖全局技能。编辑草稿按作用域和目标持久化，不使用弹窗保存长期编辑状态。

固定编辑区按自身可用宽度排版：窄面板中作用域选项可换行，名称与标识符改为单列，保存操作保持可见，页面不得产生横向滚动。

当前批量 flow：`skills.fixed-editor`。

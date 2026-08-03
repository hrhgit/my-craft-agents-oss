# Workspace 界面交互

## 范围

覆盖空状态、创建、选择、切换、位置连接和 Workspace 作用域状态。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `workspace.empty` | 没有已登记 Workspace 时打开应用 | 正常外壳和明确创建入口可见 | `workspace.empty` |
| `workspace.create` | 选择主位置及附加位置并创建 | 创建真实 Workspace，不合成默认项 | `workspace.create` |
| `workspace.switch` | 选择另一个 Workspace 或其 Session | 活动布局、导航和作用域数据一致切换 | `workspace.switch` |
| `workspace.location.manage` | 添加、解除或切换位置 | 权限和运行中任务按产品合同处理 | `workspace.locations` |

创建属于有边界的短任务，可以使用模态界面；长期 Workspace 管理使用固定设置页。

当前批量 flow：`workspace.creation-entry`。

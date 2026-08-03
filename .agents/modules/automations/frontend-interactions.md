# 自动化界面交互

## 范围

覆盖自动化列表、固定编辑区、启停、测试、复制、删除和运行历史。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `automations.create` | 从头部或空状态进入固定编辑区并保存 | 新定义写入当前 Workspace 并打开详情 | `automations.create` |
| `automations.edit` | 从详情进入编辑区并保存 | 保留未在表单展示的额外触发器、动作和字段 | `automations.edit` |
| `automations.toggle` | 启用或暂停自动化 | 列表和详情状态同步更新 | `automations.toggle` |
| `automations.test` | 测试自动化 | 展示运行中及最终结果，历史刷新 | `automations.test` |
| `automations.delete` | 确认删除 | 定义从列表移除，取消不产生写入 | `automations.delete` |

新建草稿按 Workspace 持久化。脚本通过 V3 定义和语义动作验证，不冻结编辑器 DOM。

固定编辑区按自身可用宽度排版：窄面板中的成对字段自动改为单列，保存操作保持可见，页面不得产生横向滚动。

当前批量 flow：`automations.fixed-editor`。

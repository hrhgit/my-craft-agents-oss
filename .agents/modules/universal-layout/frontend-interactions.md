# 通用布局交互

## 范围

覆盖 Workspace 侧栏、内容标签、分组、聚焦、拆分和恢复。普通管理页面留在应用外壳中，不替换整个界面。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `layout.tab.select` | 选择内容标签 | 目标标签成为活动内容，其他分组不丢失 | `layout.tab-selection` |
| `layout.conversation.navigate` | 普通新建或选择 Session | 当前 Conversation 标签保留身份并切换路由，不因保护状态新增标签 | `layout.session-replace` |
| `layout.conversation.open-new` | Ctrl/Cmd 点击、鼠标中键或明确在新面板打开 | 新增并聚焦 Conversation 标签 | `layout.session-open-new` |
| `layout.group.open` | 单组时触发右上布局按钮 | 右侧创建新分组 | `layout.group-toggle` |
| `layout.panel.focus` | 多组时触发布局按钮两次 | 先聚焦当前对话，再恢复原布局 | `layout.group-toggle` |
| `layout.tab.detach` | 将标签拖出布局画布并释放 | Electron 创建辅助窗口；WebUI 不宣称支持 | `layout.detach` |

布局脚本验证稳定的分组、标签和焦点状态，不固定像素坐标。

当前批量 flow：`layout.shell-navigation`。

# 对话界面交互

## 范围

覆盖会话选择、草稿、附件、模型与权限选择、发送、停止、审批和转录浏览。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `conversation.draft.edit` | 编辑输入和附件 | 草稿按会话恢复，未发布 Session 不被提前创建 | `conversation.draft` |
| `conversation.message.send` | 发送有效输入 | 首轮按发布合同创建 Session，发送按钮进入运行状态 | `conversation.send` |
| `conversation.run.stop` | 停止当前运行 | 当前 Attempt 中断，历史内容保留 | `conversation.stop` |
| `conversation.permission.respond` | 接受或拒绝权限请求 | 请求从队列移除并写入对应结果 | `conversation.permission` |

模型和权限选择器属于草稿上下文，选择后不应改变布局尺寸。

当前批量 flow：`conversation.new-session-entry`。

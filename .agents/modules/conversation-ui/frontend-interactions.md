# 对话界面交互

## 范围

覆盖会话选择、草稿、附件、模型选择、发送、停止和转录浏览；Extension 可通过通用界面挂载合同加入自己的控制与审批交互。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `conversation.draft.edit` | 编辑输入和附件 | 草稿按会话恢复，未发布 Session 不被提前创建 | `conversation.draft` |
| `conversation.composer.degrade` | 输入区子能力发生渲染异常 | 故障限制在对应控件；核心编辑器异常时切换为可提交的基础文本输入 | `composer.error-isolation` |
| `conversation.message.send` | 发送有效输入 | 首轮在 Mortise 接管后立即进入调用方可见的待发布 Session，发送按钮进入运行状态；Pi 用户消息落盘后转正式 Session | `conversation.send` |
| `conversation.message.queue-actions` | 引导、删除或编辑等待处理的排队消息 | 排队项紧贴输入框上方且不显示状态文案；引导将其转入当前运行，删除仅撤回后台队列，编辑在撤回后把正文与附件恢复到当前草稿；会话转录不出现该排队项 | `conversation.queue-actions` |
| `conversation.run.stop` | 停止当前运行 | 当前 Attempt 中断，历史内容保留 | `conversation.stop` |
| `conversation.extension.interact` | 响应 Extension 挂载的交互 | 响应通过通用 Extension 通道返回对应运行时 | `conversation.extension` |

模型选择器和 Extension 输入区控件属于草稿上下文，交互后不应改变输入区基准尺寸。

当前批量 flow：`conversation.new-session-entry`。

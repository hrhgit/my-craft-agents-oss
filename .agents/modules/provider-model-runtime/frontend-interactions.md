# 提供商与模型界面交互

## 范围

覆盖提供商设置、认证、模型选择、推理级别、上下文用量和连接错误。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `provider.configure` | 保存提供商配置 | 连接和模型列表按规范配置刷新 | `provider.settings` |
| `model.select` | 为草稿选择模型 | 当前草稿显示所选模型，不改变其他会话 | `provider.model-selection` |
| `thinking.select` | 选择推理级别 | 只显示当前模型支持的选项 | `provider.thinking` |
| `provider.error` | 连接或认证失败 | 用户看到明确、可恢复的错误状态 | `provider.errors` |

选择器状态依赖领域合同和稳定模型标识，不依赖下拉菜单的视觉顺序。

当前批量 flow：`provider.settings-entry`。

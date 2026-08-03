# 设置与安全界面交互

## 范围

覆盖设置导航、表单保存、凭据、认证、权限和 Extension 运行时设置。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `settings.navigate` | 选择设置分类 | 固定详情区显示对应页面，外壳保持不变 | `settings.navigation` |
| `settings.value.change` | 修改普通设置 | 控件即时反映规范值，失败时明确提示 | `settings.persistence` |
| `settings.credential.submit` | 提交凭据 | 敏感值不出现在快照或日志中 | `settings.credentials` |
| `settings.extension.reload` | 重载 Extension | 空闲时完成重载；有运行会话时遵守确认边界 | `settings.extensions` |

设置页不使用说明实现细节的小字；阻断式对话框只用于凭据、确认或必须中断当前操作的边界。

当前批量 flow：`settings.fixed-detail`。

# 界面验证交互

## 范围

本模块提供稳定语义动作、类型化场景、快照和证据等级。它不拥有业务交互含义。

| 交互 ID | 行为 | 可观察结果 | 验证 |
| --- | --- | --- | --- |
| `validation.flow.batch` | 在一个宿主中依次运行多个 flow | 场景之间重置，宿主只启动一次 | `validation.flow-runner` |
| `validation.scenario.apply` | 应用注册场景 | 返回场景身份、种子和验证等级 | `validation.runtime-contract` |
| `validation.semantic.action` | 对语义目标执行动作 | 返回稳定回执并观察结算后的界面 | `validation.surface-parity` |
| `validation.evidence.capture` | 捕获验收证据 | 证据绑定源码、运行和验证等级 | `validation.evidence` |
| `validation.host.shutdown` | 停止专用验收宿主 | 验收桥被释放，窗口完成关闭握手且不留下进程 | `validation.host-lifecycle` |

业务模块提供交互 ID 和预期状态；本模块负责执行合同。CLI 保留给探索和未知故障诊断，不作为每一步测试的进程边界。

当前批量 flow：`validation.batch-contract`。

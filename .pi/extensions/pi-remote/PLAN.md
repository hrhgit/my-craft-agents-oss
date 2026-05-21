# pi-remote extension 第一阶段计划

## 目标

第一阶段先做一个项目级 pi extension，让 Android App 可以通过 Tailscale 连接到当前电脑上正在运行的 pi 会话，并以聊天界面远程使用 pi。

本阶段不做独立 daemon，不改 pi core，不做云中转。目标是验证：

- 手机能连接电脑上的 pi
- 手机能发送消息给当前 pi session
- 手机能接收 pi 的流式回复和工具调用状态
- 手机能切换模型、会话和关键开关
- 协议足够稳定，后续 Android App 可以直接接入

## 总体架构

```text
Android App
  ↕ HTTP + WebSocket
Tailscale 私有网络
  ↕
pi-remote extension server
  ↕
当前 pi extension runtime
  ↕
pi session / model / tools / settings
```

电脑端需要先启动 pi，extension 随 pi 加载并启动本地服务。手机 App 通过电脑的 Tailscale IP 和 token 连接。

## 放置位置

第一阶段作为项目级扩展放在：

```text
.pi/extensions/pi-remote/
  PLAN.md
  index.ts
  server.ts
  protocol.ts
  auth.ts
  state.ts
  package.json
```

后续如果稳定，可以迁移为全局扩展或 pi package。

## 非目标

第一阶段暂不做：

- 独立 `pi-remote serve` daemon
- 多用户
- 多电脑管理
- 公网裸露访问
- 云 relay server
- 推送通知
- 文件浏览器
- diff review UI
- 完整工具审批系统
- Android 原生 App 复杂离线缓存

## 网络方案

使用 Tailscale。

默认监听策略：

- 开发默认：`127.0.0.1:8787`
- 远程使用：显式配置监听 `0.0.0.0:8787` 或 Tailscale IP
- 不支持直接公网裸露

建议命令：

```text
/remote start --host 0.0.0.0 --port 8787
/remote stop
/remote status
/remote token
/remote token rotate
```

## 安全要求

即使使用 Tailscale，也必须做 token 鉴权。

第一阶段最低安全要求：

1. HTTP API 和 WebSocket 都需要 token。
2. token 默认生成随机值。
3. token 存储在本机配置文件中，不写入 git。
4. `/remote token rotate` 可以轮换 token。
5. WebSocket 首次连接必须鉴权。
6. `/remote stop` 可以立即关闭远程访问。
7. 默认不监听公网地址。
8. 日志不要打印完整 token。

建议 token 配置文件：

```text
.pi/extensions/pi-remote/.remote.local.json
```

示例：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "tokenHash": "..."
}
```

## 协议设计

### REST API

#### 健康检查

```text
GET /api/health
```

返回：

```json
{
  "ok": true,
  "serverVersion": "0.1.0",
  "requiresAuth": true
}
```

#### 登录验证

```text
POST /api/auth/verify
Authorization: Bearer <token>
```

返回：

```json
{
  "ok": true
}
```

#### 获取当前状态

```text
GET /api/state
Authorization: Bearer <token>
```

返回：

```json
{
  "sessionId": "...",
  "sessionName": "...",
  "cwd": "E:/project",
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "name": "Claude Sonnet 4.5"
  },
  "thinkingLevel": "medium",
  "webSearch": false,
  "planMode": false,
  "isStreaming": false
}
```

#### 获取可用模型

```text
GET /api/models
Authorization: Bearer <token>
```

返回：

```json
{
  "models": [
    {
      "provider": "anthropic",
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5",
      "reasoning": true
    }
  ]
}
```

#### 切换模型

```text
POST /api/model
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```json
{
  "provider": "anthropic",
  "id": "claude-sonnet-4-5"
}
```

返回：

```json
{
  "ok": true
}
```

#### 设置思考强度

```text
POST /api/thinking-level
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```json
{
  "level": "medium"
}
```

合法值：

```text
off, minimal, low, medium, high, xhigh
```

#### 设置远程开关

```text
POST /api/settings
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```json
{
  "webSearch": true,
  "planMode": false
}
```

说明：

- `planMode` 第一阶段由 remote extension 自己维护。
- `webSearch` 第一阶段先作为 remote 状态打通；如果 extension API 不支持直接更新 pi 设置，则后续再补正式集成。

#### 发送消息

```text
POST /api/prompt
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```json
{
  "text": "帮我看一下这个项目",
  "delivery": "followUp"
}
```

`delivery` 可选：

```text
immediate, steer, followUp
```

映射：

- pi idle：直接发送
- pi streaming + `steer`：`pi.sendUserMessage(text, { deliverAs: "steer" })`
- pi streaming + `followUp`：`pi.sendUserMessage(text, { deliverAs: "followUp" })`
- pi streaming + 未指定：返回错误，让 App 决定 steer 还是 followUp

#### 中断当前任务

```text
POST /api/abort
Authorization: Bearer <token>
```

如果 extension API 无法直接 abort 当前 session，第一阶段先记录为待补能力，并在 UI 中隐藏或降级。

#### 会话列表

```text
GET /api/sessions
Authorization: Bearer <token>
```

返回：

```json
{
  "sessions": [
    {
      "file": "...",
      "name": "Refactor auth module",
      "updatedAt": 1779240000000
    }
  ]
}
```

#### 新建会话

```text
POST /api/sessions
Authorization: Bearer <token>
```

返回：

```json
{
  "ok": true,
  "sessionId": "..."
}
```

#### 切换会话

```text
POST /api/sessions/switch
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```json
{
  "file": "..."
}
```

注意：会话切换会触发 `session_shutdown` 和 extension reload/rebind。实现时必须使用 `ctx.switchSession(..., { withSession })`，切换后不能继续使用旧的 `ctx` 或 session-bound 对象。

### WebSocket API

连接：

```text
ws://<tailscale-ip>:8787/ws?token=<token>
```

或首包鉴权：

```json
{
  "type": "auth",
  "token": "..."
}
```

第一阶段优先使用首包鉴权，避免 token 出现在 URL 日志里。

#### 客户端到服务端事件

```ts
type ClientEvent =
  | { type: "auth"; token: string }
  | { type: "prompt"; text: string; delivery?: "steer" | "followUp" }
  | { type: "abort" }
  | { type: "set_model"; provider: string; id: string }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "set_settings"; webSearch?: boolean; planMode?: boolean }
  | { type: "ping" };
```

#### 服务端到客户端事件

```ts
type ServerEvent =
  | { type: "ready"; state: RemoteState }
  | { type: "state"; state: RemoteState }
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; toolName: string; input?: unknown }
  | { type: "tool_update"; toolName: string; text: string }
  | { type: "tool_end"; toolName: string; isError: boolean; output?: string }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "queue_update"; steering: number; followUp: number }
  | { type: "error"; message: string }
  | { type: "pong" };
```

## Extension 事件映射

remote extension 需要订阅 pi 事件，并广播给 WebSocket 客户端。

建议映射：

| pi event | remote event |
| --- | --- |
| `message_update` text delta | `assistant_delta` |
| `message_update` thinking delta | `thinking_delta` |
| `tool_execution_start` | `tool_start` |
| `tool_execution_update` | `tool_update` |
| `tool_execution_end` | `tool_end` |
| `agent_start` | `agent_start` |
| `agent_end` | `agent_end` |
| `queue_update` | `queue_update` |
| `model_select` | `state` |
| `thinking_level_select` | `state` |
| `session_start` | start/rebind server state |
| `session_shutdown` | stop or rebind server |

## Plan mode 第一阶段设计

第一阶段不依赖完整官方 plan-mode extension，先做轻量 plan mode：

- remote extension 维护 `planMode: boolean`
- `planMode` 为 true 时，在 `before_agent_start` 注入额外系统提示
- 提示要求模型先给计划，不直接修改文件，除非用户明确批准

初始提示草案：

```text
Remote plan mode is enabled. Before making file changes or running destructive commands, first present a concise plan and wait for explicit user approval. Prefer investigation and read-only commands until approved.
```

后续可以改为和 `.pi/extensions/plan-mode/` 或官方 plan-mode package 集成。

## Web search 第一阶段设计

目标先把 App 设置和 server 状态打通。

实现优先级：

1. 如果 extension/runtime API 可直接设置 web search，则实现真正开关。
2. 如果暂时没有可用 API，则先保存 `webSearch` 状态并广播给客户端。
3. 后续必要时给 pi extension API 增加正式方法：
   - `pi.getWebSearch()`
   - `pi.setWebSearch(enabled)`

## 会话管理策略

第一阶段采用保守策略：

1. MVP 最先支持当前 active session。
2. 第二步支持 new session。
3. 第三步支持 session list。
4. 最后支持 switch session。

实现 switch 时必须遵守 pi extension lifecycle：

- `ctx.switchSession()` 后旧 session 对象失效。
- 使用 `withSession` 处理切换后的逻辑。
- 不捕获旧 `ctx.sessionManager` 在切换后使用。
- server 应该能在 `session_shutdown` 后重新绑定新 session。

## 文件结构计划

```text
.pi/extensions/pi-remote/
  PLAN.md               # 本计划
  index.ts              # extension 入口，注册命令和事件
  server.ts             # HTTP/WebSocket server
  protocol.ts           # 请求/响应/事件类型
  auth.ts               # token 生成、校验、存储
  state.ts              # RemoteState 和状态同步
  package.json          # 依赖声明
```

职责：

### `index.ts`

- 接收 `ExtensionAPI`
- 创建 `RemoteServer`
- 注册 `/remote` 命令
- 订阅 pi 事件并转发
- 在 `session_shutdown` 清理 server
- 实现 plan mode 的 `before_agent_start` 注入

### `server.ts`

- 启动 HTTP server
- 处理 REST API
- 管理 WebSocket 客户端
- 广播事件
- 调用 adapter 方法

### `protocol.ts`

- 定义 `RemoteState`
- 定义 REST payload 类型
- 定义 WebSocket client/server event 类型
- 定义 `ThinkingLevel`、`DeliveryMode`

### `auth.ts`

- 生成 token
- hash token
- 校验 token
- 读取/写入本地配置

### `state.ts`

- 收集当前 session/model/thinking/settings 状态
- 管理 `planMode`、`webSearch` 这类 remote 状态
- 生成广播用 state snapshot

## Android App 需要的最小接口

Android 第一版只依赖这些接口：

1. `GET /api/health`
2. `POST /api/auth/verify`
3. `GET /api/state`
4. `GET /api/models`
5. `POST /api/model`
6. `POST /api/thinking-level`
7. `POST /api/settings`
8. `POST /api/prompt`
9. `WebSocket /ws`

会话切换可以在第二批接入。

## 开发顺序

### 1. 协议和骨架

- 创建扩展目录
- 写 `protocol.ts`
- 写 `RemoteServer` 空实现
- 注册 `/remote status`

验收：pi 启动后 `/remote status` 可用。

### 2. HTTP server 和 token

- 实现 server start/stop
- 实现 health API
- 实现 token 生成/校验
- 实现 `/remote token`

验收：curl 可以通过 token 访问 `/api/health` 和 `/api/state`。

### 3. WebSocket 广播

- 实现 `/ws`
- 首包鉴权
- 广播 `ready` 和 `state`
- ping/pong

验收：简单 WebSocket 客户端能连接并收到状态。

### 4. 远程 prompt

- 实现 `POST /api/prompt`
- 实现 WebSocket `prompt` 事件
- 调用 `pi.sendUserMessage()`
- 处理 streaming 时的 `steer` / `followUp`

验收：手机或 ws 客户端发消息后，当前 pi session 开始响应。

### 5. 流式事件转发

- 转发 assistant text delta
- 转发 thinking delta
- 转发 tool start/update/end
- 转发 agent start/end

验收：远程客户端能实时显示 pi 回复和工具调用。

### 6. 模型和思考强度

- 实现 `GET /api/models`
- 实现 `POST /api/model`
- 实现 `POST /api/thinking-level`
- 广播 state 更新

验收：远程切换模型和 thinking level 生效。

### 7. remote settings

- 实现 `webSearch` 状态
- 实现 `planMode` 状态
- 实现 plan mode prompt 注入

验收：App 或 curl 修改开关后，状态同步；plan mode 会影响下一轮。

### 8. 会话管理

- 先实现 `GET /api/sessions`
- 再实现 new session
- 最后实现 switch session

验收：可以远程新建/切换 session，且 extension 不因 stale context 崩溃。

### 9. Web 调试页，可选

在 Android App 前，可先做一个极简调试页：

```text
GET /
```

功能：

- 输入 token
- 连接 WebSocket
- 发送 prompt
- 显示流式输出
- 切换模型/thinking/settings

该页面只用于调试，不作为最终产品。

## 验收标准

第一阶段完成的最低标准：

1. pi 启动后 extension 可启动 remote server。
2. 手机通过 Tailscale IP 可以连接。
3. token 鉴权有效。
4. 手机能发送 prompt。
5. 手机能看到流式 assistant 输出。
6. 手机能看到工具调用开始和结束。
7. 手机能切换模型。
8. 手机能切换 thinking level。
9. 手机能切换 plan mode。
10. server 在 `/reload` 或 pi 退出时能释放端口。

## 风险点

### Extension 生命周期

`/reload`、new session、switch session 都可能触发 `session_shutdown`。server 必须避免重复监听端口，也不能持有失效的 session-bound context。

### Abort 能力

如果 extension API 没有直接暴露 abort，需要后续评估是否通过 core API、RPC mode 或新增 extension API 支持。

### Web search 能力

如果 extension API 没有正式 setter，第一阶段可能只能同步 UI 状态，后续需要补 API。

### 多客户端冲突

第一阶段按单用户设计。多个客户端同时连接时，可以都收到事件，但写操作不做复杂冲突处理。

### 安全边界

Tailscale 不是权限系统。必须保留 token。后续做工具审批前，不建议开放给非本人设备。

## 后续阶段预留

第二阶段可以做：

- Kotlin + Jetpack Compose Android App
- 工具调用审批
- diff 展示
- 文件上传
- 图片输入
- 通知
- 生物识别解锁
- 多项目选择
- 独立 `pi-remote serve` daemon
- 开机自启
- Cloudflare Tunnel 支持

## 当前决策

第一阶段采用：

```text
pi project extension + HTTP/WebSocket + token auth + Tailscale
```

先完成远程连接协议和 pi session 控制，再开发 Android App。

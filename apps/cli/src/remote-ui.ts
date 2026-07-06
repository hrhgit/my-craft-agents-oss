/**
 * RemoteUI 终端交互处理
 *
 * 处理 pi 扩展通过 extensions:EVENT 频道转发的 remoteui:request 事件。
 * 支持两种模式:
 *  - non-interactive（默认）：自动返回取消响应（payload=null, reason="non-interactive"）
 *    扩展收到取消响应后自行降级处理。
 *  - interactive（--interactive）：在终端渲染 select/editor 对话框，用户通过 stdin 交互。
 *
 * 响应路径:
 *   respond() → client.invoke('extensions:remoteuiResponse', sessionId, requestId, payload, reason)
 *   → SessionManager.sendRemoteUIResponse → PiAgent.sendRemoteUIResponse
 *   → 子进程 remoteui_response → pi.events.emit("remoteui:response")
 *
 * 协议类型镜像自 apps/electron/src/renderer/components/extensions/RemoteUIModal.tsx
 * 与 packages/server-core/src/handlers/pi-extension-bridge.ts 的 ExtensionBridgeEvent 对齐。
 */

import * as readline from 'readline'

// ---------------------------------------------------------------------------
// 协议类型（与 RemoteUIModal.tsx / ExtensionBridgeEvent 对齐）
// ---------------------------------------------------------------------------

export interface RemoteUIOption {
  title: string
  description?: string
}

export interface RemoteUISelectRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'select'
  title: string
  message?: string
  options: RemoteUIOption[]
  allowMultiple?: boolean
  allowFreeform?: boolean
  allowComment?: boolean
  source: string
  sessionId?: string
}

export interface RemoteUIEditorRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'editor'
  title: string
  prefill?: string
  source: string
  sessionId?: string
}

export type RemoteUIRequest = RemoteUISelectRequest | RemoteUIEditorRequest

export interface RemoteUISelectResult {
  selections: string[]
  freeformText?: string
  comment?: string
}

export interface RemoteUIEditorResult {
  text: string
}

export type RemoteUIResult = RemoteUISelectResult | RemoteUIEditorResult

/** 非交互模式自动取消原因（透传到 pi 扩展，扩展据此降级） */
export const NON_INTERACTIVE_REASON = 'non-interactive'

/** 用户主动取消原因 */
export const CANCELLED_REASON = 'cancelled'

/**
 * 回传响应的回调签名。对应 RPC `extensions:remoteuiResponse` 的参数。
 * payload=null 表示取消，reason 描述取消原因。
 */
export type RemoteUIResponder = (
  sessionId: string,
  requestId: string,
  payload: RemoteUIResult | null,
  reason?: string,
) => Promise<void>

// ---------------------------------------------------------------------------
// ANSI 颜色（与 index.ts 一致：NO_COLOR 或非 TTY 时禁用）
// ---------------------------------------------------------------------------

// Node 中 process.stdout.isTTY 为 true（TTY）或 undefined（非 TTY），永远不会是 false。
// 用 === true 才能正确在管道/重定向时禁用颜色码。
const _useColor = !process.env.NO_COLOR && process.stdout.isTTY === true
const c = {
  dim: (s: string) => (_useColor ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s: string) => (_useColor ? `\x1b[36m${s}\x1b[39m` : s),
  bold: (s: string) => (_useColor ? `\x1b[1m${s}\x1b[22m` : s),
  green: (s: string) => (_useColor ? `\x1b[32m${s}\x1b[39m` : s),
  yellow: (s: string) => (_useColor ? `\x1b[33m${s}\x1b[39m` : s),
}

type LogFn = (msg: string) => void

// ---------------------------------------------------------------------------
// 事件识别
// ---------------------------------------------------------------------------

/**
 * 将 extensions:EVENT 广播的事件规约为 RemoteUIRequest。
 * 仅处理 type === 'remoteui_request' 且 kind 为 select/editor 的事件，其余返回 null。
 */
export function asRemoteUIRequest(event: unknown): RemoteUIRequest | null {
  if (!event || typeof event !== 'object') return null
  const e = event as { type?: string; kind?: string; requestId?: string }
  if (
    e.type !== 'remoteui_request' ||
    !e.requestId ||
    (e.kind !== 'select' && e.kind !== 'editor')
  ) {
    return null
  }
  return event as RemoteUIRequest
}

// ---------------------------------------------------------------------------
// non-interactive 模式（默认）
// ---------------------------------------------------------------------------

/**
 * 非交互模式：立即返回取消响应（payload=null, reason="non-interactive"）。
 * 快速、不阻塞扩展执行；扩展收到取消响应后自行降级。
 */
export async function handleRemoteUINonInteractive(
  request: RemoteUIRequest,
  respond: RemoteUIResponder,
  log?: LogFn,
): Promise<void> {
  const sessionLabel = request.sessionId ? `session=${request.sessionId}` : 'no-session'
  log?.(
    `[RemoteUI] Extension request auto-cancelled (non-interactive mode): ` +
      `request=${request.requestId} kind=${request.kind} source=${request.source} ${sessionLabel}`,
  )
  await respond(request.sessionId ?? '', request.requestId, null, NON_INTERACTIVE_REASON)
}

// ---------------------------------------------------------------------------
// interactive 模式（--interactive）
// ---------------------------------------------------------------------------

/**
 * 交互模式：在终端渲染 select/editor 对话框，等待用户 stdin 输入后回传结果。
 * - Ctrl+C 取消当前请求（回传 null + "cancelled"），不退出进程
 * - stdin 非 TTY 时降级为 non-interactive 取消
 */
export async function handleRemoteUIInteractive(
  request: RemoteUIRequest,
  respond: RemoteUIResponder,
  log?: LogFn,
): Promise<void> {
  // 非 TTY 无法交互，降级为自动取消
  if (!process.stdin.isTTY) {
    log?.(
      `[RemoteUI] stdin is not a TTY — falling back to non-interactive cancel ` +
        `for request=${request.requestId}`,
    )
    await respond(request.sessionId ?? '', request.requestId, null, NON_INTERACTIVE_REASON)
    return
  }

  // 对话框渲染输出走 stderr，避免 `craft-cli run --interactive | jq` 时污染 stdout 管道。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  })

  let cancelled = false
  rl.on('SIGINT', () => {
    cancelled = true
    rl.close()
  })

  // F5: stdin 关闭（SSH 断开等）时 reject 当前 pending 的 ask Promise，
  // 否则 rl.question 回调永不触发，进程永久挂起。
  rl.on('close', () => {
    if (pendingAskReject) {
      pendingAskReject(new Error('stdin closed'))
      pendingAskReject = null
    }
  })

  try {
    let payload: RemoteUIResult | null = null
    if (request.kind === 'select') {
      payload = await promptSelect(rl, request, () => cancelled)
    } else {
      payload = await promptEditor(rl, request, () => cancelled)
    }

    if (cancelled || payload === null) {
      log?.(`[RemoteUI] User cancelled request=${request.requestId}`)
      await respond(request.sessionId ?? '', request.requestId, null, CANCELLED_REASON)
    } else {
      await respond(request.sessionId ?? '', request.requestId, payload, undefined)
    }
  } catch (e) {
    log?.(
      `[RemoteUI] Error handling request=${request.requestId}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    )
    await respond(request.sessionId ?? '', request.requestId, null, CANCELLED_REASON)
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------
// readline 辅助
// ---------------------------------------------------------------------------

// F5: 跟踪当前 pending 的 ask rejecter，使 rl 'close' 事件能 reject 它。
// 作为模块级变量是安全的——index.ts 的 dialogQueue 保证同一时刻只有一个对话框。
let pendingAskReject: ((err: Error) => void) | null = null

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    pendingAskReject = reject
    rl.question(prompt, (answer) => {
      pendingAskReject = null
      resolve(answer)
    })
  })
}

// ---------------------------------------------------------------------------
// select 对话框
// ---------------------------------------------------------------------------

async function promptSelect(
  rl: readline.Interface,
  request: RemoteUISelectRequest,
  isCancelled: () => boolean,
): Promise<RemoteUISelectResult | null> {
  const {
    options = [],
    allowMultiple = false,
    allowFreeform = false,
    allowComment = false,
  } = request

  process.stderr.write(`\n${c.bold(request.title)}\n`)
  if (request.message) process.stderr.write(`${c.dim(request.message)}\n`)
  process.stderr.write('\n')

  if (options.length > 0) {
    options.forEach((opt, i) => {
      const num = c.cyan(`[${i + 1}]`)
      const desc = opt.description ? c.dim(`  — ${opt.description}`) : ''
      process.stderr.write(`${num} ${opt.title}${desc}\n`)
    })
    process.stderr.write('\n')
  }

  const selections: string[] = []
  if (options.length > 0) {
    const promptText = allowMultiple
      ? `Select (comma-separated numbers, Enter to skip): `
      : `Select (number, Enter to skip): `
    const answer = await ask(rl, promptText)
    if (isCancelled()) return null

    const trimmed = answer.trim()
    if (trimmed) {
      const indices = trimmed
        .split(/[,\s]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n) && n >= 1 && n <= options.length)
      for (const idx of indices) {
        const title = options[idx - 1].title
        if (!selections.includes(title)) selections.push(title)
      }
    }
  }

  let freeformText: string | undefined
  if (allowFreeform) {
    const answer = await ask(rl, `Write your own answer (Enter to skip): `)
    if (isCancelled()) return null
    const trimmed = answer.trim()
    if (trimmed) freeformText = trimmed
  }

  let comment: string | undefined
  if (allowComment) {
    const answer = await ask(rl, `Additional comment (Enter to skip): `)
    if (isCancelled()) return null
    const trimmed = answer.trim()
    if (trimmed) comment = trimmed
  }

  // 无选择且无自由输入 → 视为取消
  if (selections.length === 0 && !freeformText) {
    return null
  }

  const result: RemoteUISelectResult = { selections }
  if (freeformText) result.freeformText = freeformText
  if (comment) result.comment = comment
  return result
}

// ---------------------------------------------------------------------------
// editor 对话框
// ---------------------------------------------------------------------------

async function promptEditor(
  rl: readline.Interface,
  request: RemoteUIEditorRequest,
  isCancelled: () => boolean,
): Promise<RemoteUIEditorResult | null> {
  process.stderr.write(`\n${c.bold(request.title)}\n`)
  process.stderr.write(
    c.dim(`Enter your text. Empty line to finish. Ctrl+C to cancel.\n`),
  )
  process.stderr.write('\n')

  // 有 prefill 时询问是否直接采用，避免用户重复输入
  if (request.prefill) {
    const usePrefill = await ask(rl, `Use prefill? (Y/n): `)
    if (isCancelled()) return null
    if (usePrefill.trim().toLowerCase() !== 'n') {
      const text = request.prefill.trim()
      if (!text) return null
      return { text }
    }
  }

  const lines: string[] = []
  while (!isCancelled()) {
    const line = await ask(rl, '> ')
    if (isCancelled()) return null
    if (line === '' && lines.length > 0) break // 空行结束输入
    lines.push(line)
  }

  if (isCancelled()) return null

  const text = lines.join('\n').trim()
  if (!text) return null
  return { text }
}

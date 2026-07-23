/** Terminal renderer for versioned extension interactions. */

import * as readline from 'readline'
import {
  validateExtensionInteractionBridgeCancelV1,
  validateExtensionInteractionBridgeRequestV1,
  validateExtensionInteractionBridgeSettledV1,
  type ExtensionInteractionAnswerV1,
  type ExtensionInteractionBridgeCancelV1,
  type ExtensionInteractionBridgeRequestV1,
  type ExtensionInteractionBridgeSettledV1,
  type ExtensionInteractionFieldV1,
  type ExtensionInteractionResponseV1,
} from '@mortise/shared/protocol'

export type ExtensionInteractionResponder = (
  sessionId: string,
  requestId: string,
  response: ExtensionInteractionResponseV1,
) => Promise<void>

export type ExtensionInteractionTermination =
  | ExtensionInteractionBridgeCancelV1
  | ExtensionInteractionBridgeSettledV1

type LogFn = (msg: string) => void

// ---------------------------------------------------------------------------
// 事件识别
// ---------------------------------------------------------------------------

export function asExtensionInteractionRequest(event: unknown): ExtensionInteractionBridgeRequestV1 | null {
  return validateExtensionInteractionBridgeRequestV1(event) === null
    ? event as ExtensionInteractionBridgeRequestV1
    : null
}

export function asExtensionInteractionTermination(event: unknown): ExtensionInteractionTermination | null {
  if (validateExtensionInteractionBridgeCancelV1(event) === null) {
    return event as ExtensionInteractionBridgeCancelV1
  }
  return validateExtensionInteractionBridgeSettledV1(event) === null
    ? event as ExtensionInteractionBridgeSettledV1
    : null
}

// ---------------------------------------------------------------------------
// non-interactive 模式（默认）
// ---------------------------------------------------------------------------

export async function handleExtensionInteractionNonInteractive(
  event: ExtensionInteractionBridgeRequestV1,
  respond: ExtensionInteractionResponder,
  log?: LogFn,
): Promise<void> {
  log?.(
    `[ExtensionInteraction] Request auto-cancelled (non-interactive mode): ` +
      `request=${event.requestId} extension=${event.extensionId} session=${event.sessionId}`,
  )
  await respond(event.sessionId, event.requestId, {
    schemaVersion: 1,
    status: 'cancelled',
    reason: 'host-disconnected',
  })
}

// ---------------------------------------------------------------------------
// interactive 模式（--interactive）
// ---------------------------------------------------------------------------

/** Render Interaction V1 fields while keeping stdout available for command output. */
export interface InteractionTerminal {
  ask(prompt: string): Promise<string>
  write(text: string): void
}

export async function collectExtensionInteractionAnswers(
  event: ExtensionInteractionBridgeRequestV1,
  terminal: InteractionTerminal,
  isCancelled: () => boolean = () => false,
): Promise<ExtensionInteractionAnswerV1[] | null> {
  const { request } = event
  if (request.title) terminal.write(`\n${request.title}\n`)
  if (request.description) terminal.write(`${request.description}\n`)

  const answers: ExtensionInteractionAnswerV1[] = []
  for (const field of request.fields) {
    if (isCancelled()) return null
    terminal.write(`\n${field.label}${field.required ? ' *' : ''}\n`)
    if (field.description) terminal.write(`${field.description}\n`)
    const answer = await promptInteractionField(field, terminal, isCancelled)
    if (!answer) return null
    answers.push(answer)
  }
  return answers
}

export async function handleExtensionInteractionInteractive(
  event: ExtensionInteractionBridgeRequestV1,
  respond: ExtensionInteractionResponder,
  log?: LogFn,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  if (!process.stdin.isTTY) {
    log?.(`[ExtensionInteraction] stdin is not a TTY; cancelling request=${event.requestId}`)
    await handleExtensionInteractionNonInteractive(event, respond, log)
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  let cancelledByUser = false
  let cancelledByHost = false
  rl.on('SIGINT', () => {
    cancelledByUser = true
    rl.close()
  })
  const onHostCancel = () => {
    cancelledByHost = true
    rl.close()
  }
  signal?.addEventListener('abort', onHostCancel, { once: true })
  if (signal?.aborted) onHostCancel()
  rl.on('close', () => {
    if (pendingAskReject) {
      pendingAskReject(new Error('stdin closed'))
      pendingAskReject = null
    }
  })

  try {
    const answers = await collectExtensionInteractionAnswers(event, {
      ask: prompt => ask(rl, prompt),
      write: text => process.stderr.write(text),
    }, () => cancelledByUser || cancelledByHost)
    if (cancelledByHost) return
    const response: ExtensionInteractionResponseV1 = answers
      ? { schemaVersion: 1, status: 'submitted', answers }
      : { schemaVersion: 1, status: 'cancelled', reason: 'user' }
    await respond(event.sessionId, event.requestId, response)
  } catch (error) {
    if (cancelledByHost) return
    log?.(`[ExtensionInteraction] Error handling request=${event.requestId}: ${error instanceof Error ? error.message : String(error)}`)
    await respond(event.sessionId, event.requestId, {
      schemaVersion: 1,
      status: 'cancelled',
      reason: 'host-disconnected',
    })
  } finally {
    signal?.removeEventListener('abort', onHostCancel)
    rl.close()
  }
}

async function promptInteractionField(
  field: ExtensionInteractionFieldV1,
  terminal: InteractionTerminal,
  isCancelled: () => boolean,
): Promise<ExtensionInteractionAnswerV1 | null> {
  if (field.kind === 'confirm') {
    const defaultValue = field.defaultValue ?? false
    while (!isCancelled()) {
      const raw = (await terminal.ask(defaultValue ? 'Confirm? (Y/n): ' : 'Confirm? (y/N): ')).trim().toLowerCase()
      if (isCancelled()) return null
      if (!raw) return { fieldId: field.id, kind: 'confirm', value: defaultValue }
      if (raw === 'y' || raw === 'yes') return { fieldId: field.id, kind: 'confirm', value: true }
      if (raw === 'n' || raw === 'no') return { fieldId: field.id, kind: 'confirm', value: false }
      terminal.write('Enter y or n.\n')
    }
    return null
  }

  if (field.kind === 'text') {
    while (!isCancelled()) {
      let value: string
      if (field.multiline) {
        terminal.write('Enter text; submit an empty line to finish.\n')
        const lines: string[] = []
        while (!isCancelled()) {
          const line = await terminal.ask('> ')
          if (line === '') break
          lines.push(line)
        }
        value = lines.join('\n')
      } else {
        value = await terminal.ask(field.placeholder ? `${field.placeholder}: ` : '> ')
      }
      if (isCancelled()) return null
      if (!value && field.defaultValue !== undefined) value = field.defaultValue
      const length = value.length
      const minimum = field.minLength ?? (field.required ? 1 : 0)
      const maximum = field.maxLength ?? Number.POSITIVE_INFINITY
      if (length >= minimum && length <= maximum && (!field.required || value.trim().length > 0)) {
        return { fieldId: field.id, kind: 'text', value }
      }
      terminal.write(`Answer must contain between ${minimum} and ${maximum === Number.POSITIVE_INFINITY ? 'any number of' : maximum} characters.\n`)
    }
    return null
  }

  field.options.forEach((option, index) => {
    terminal.write(`[${index + 1}] ${option.label}${option.description ? ` - ${option.description}` : ''}\n`)
  })
  while (!isCancelled()) {
    const raw = await terminal.ask(field.multiple ? 'Select comma-separated numbers: ' : 'Select a number: ')
    if (isCancelled()) return null
    const selectedOptionIds = Array.from(new Set(
      raw.trim()
        ? raw.trim().split(/[,\s]+/).map(value => Number.parseInt(value, 10))
          .filter(index => Number.isInteger(index) && index >= 1 && index <= field.options.length)
          .map(index => field.options[index - 1]!.id)
        : [],
    ))
    if (!field.multiple && selectedOptionIds.length > 1) selectedOptionIds.splice(1)

    const otherText = field.allowOther ? (await terminal.ask(`${field.otherLabel ?? 'Other answer'} (Enter to skip): `)).trim() : ''
    if (isCancelled()) return null
    if (otherText && !field.multiple) selectedOptionIds.splice(0)
    const selectionCount = selectedOptionIds.length + (otherText ? 1 : 0)
    const minimum = field.minSelections ?? (field.required ? 1 : 0)
    const maximum = field.maxSelections ?? (field.multiple ? Number.POSITIVE_INFINITY : 1)
    if (selectionCount < minimum || selectionCount > maximum) {
      terminal.write(`Select between ${minimum} and ${maximum === Number.POSITIVE_INFINITY ? 'any number of' : maximum} answers.\n`)
      continue
    }

    const comment = field.allowComment ? (await terminal.ask(`${field.commentLabel ?? 'Comment'} (Enter to skip): `)).trim() : ''
    if (isCancelled()) return null
    return {
      fieldId: field.id,
      kind: 'choice',
      selectedOptionIds,
      ...(otherText ? { otherText } : {}),
      ...(comment ? { comment } : {}),
    }
  }
  return null
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

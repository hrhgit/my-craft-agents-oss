export interface ExtensionInteractionOptionV1 {
  id: string
  label: string
  description?: string
}

interface ExtensionInteractionFieldBaseV1 {
  id: string
  label: string
  description?: string
  required?: boolean
}

export type ExtensionInteractionFieldV1 =
  | (ExtensionInteractionFieldBaseV1 & {
      kind: 'confirm'
      defaultValue?: boolean
    })
  | (ExtensionInteractionFieldBaseV1 & {
      kind: 'choice'
      options: ExtensionInteractionOptionV1[]
      multiple?: boolean
      minSelections?: number
      maxSelections?: number
      allowOther?: boolean
      otherLabel?: string
      allowComment?: boolean
      commentLabel?: string
    })
  | (ExtensionInteractionFieldBaseV1 & {
      kind: 'text'
      placeholder?: string
      defaultValue?: string
      multiline?: boolean
      sensitive?: boolean
      minLength?: number
      maxLength?: number
    })

export interface ExtensionInteractionRequestV1 {
  schemaVersion: 1
  title?: string
  description?: string
  fields: ExtensionInteractionFieldV1[]
  submitLabel?: string
  cancelLabel?: string
}

export type ExtensionInteractionAnswerV1 =
  | { fieldId: string; kind: 'confirm'; value: boolean }
  | { fieldId: string; kind: 'choice'; selectedOptionIds: string[]; otherText?: string; comment?: string }
  | { fieldId: string; kind: 'text'; value: string }

export type ExtensionInteractionCancelReasonV1 =
  | 'user'
  | 'timeout'
  | 'aborted'
  | 'host-disconnected'
  | 'runtime-disposed'

export type ExtensionInteractionResponseV1 =
  | { schemaVersion: 1; status: 'submitted'; answers: ExtensionInteractionAnswerV1[] }
  | { schemaVersion: 1; status: 'cancelled'; reason?: ExtensionInteractionCancelReasonV1 }

export interface ExtensionInteractionBridgeRequestV1 {
  type: 'extension_interaction_request'
  requestId: string
  extensionId: string
  runtimeId: string
  sessionId: string
  request: ExtensionInteractionRequestV1
  timeout?: number
}

export interface ExtensionInteractionBridgeCancelV1 {
  type: 'extension_interaction_cancel'
  requestId: string
  extensionId: string
  runtimeId: string
  sessionId: string
  schemaVersion: 1
  reason: ExtensionInteractionCancelReasonV1
}

/** Host-authored notification that another client completed an interaction. */
export interface ExtensionInteractionBridgeSettledV1 {
  type: 'extension_interaction_settled'
  requestId: string
  extensionId: string
  runtimeId: string
  sessionId: string
  schemaVersion: 1
  outcome: 'submitted' | 'cancelled'
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const cancelReasons = new Set<string>(['user', 'timeout', 'aborted', 'host-disconnected', 'runtime-disposed'])

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0)
}

function optionalString(value: unknown, max: number): boolean {
  return value === undefined || boundedString(value, max)
}

function stableId(value: unknown): value is string {
  return boundedString(value, 128) && identifierPattern.test(value)
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function optionalBoundedInteger(value: unknown, min: number, max: number): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= min && Number(value) <= max)
}

export function validateExtensionInteractionRequestV1(value: unknown): string | null {
  const request = record(value)
  if (!request) return 'Interaction request must be an object'
  if (!onlyKeys(request, ['schemaVersion', 'title', 'description', 'fields', 'submitLabel', 'cancelLabel'])) return 'Unsupported interaction request field'
  if (request.schemaVersion !== 1) return 'Unsupported interaction schema version'
  if (!optionalString(request.title, 256) || !optionalString(request.description, 4_000)) return 'Interaction text is invalid'
  if (!optionalString(request.submitLabel, 64) || !optionalString(request.cancelLabel, 64)) return 'Interaction action label is invalid'
  if (!Array.isArray(request.fields) || request.fields.length < 1 || request.fields.length > 32) return 'Interaction fields must contain between 1 and 32 items'

  const fieldIds = new Set<string>()
  for (const rawField of request.fields) {
    const field = record(rawField)
    if (!field || !stableId(field.id) || fieldIds.has(field.id)) return 'Interaction field ids must be unique stable identifiers'
    fieldIds.add(field.id)
    if (!boundedString(field.label, 256) || !optionalString(field.description, 2_000) || !optionalBoolean(field.required)) return `Interaction field ${field.id} is invalid`

    if (field.kind === 'confirm') {
      if (!onlyKeys(field, ['id', 'kind', 'label', 'description', 'required', 'defaultValue'])) return `Unsupported confirm field property on ${field.id}`
      if (!optionalBoolean(field.defaultValue)) return `Confirm defaultValue on ${field.id} must be boolean`
      continue
    }

    if (field.kind === 'text') {
      if (!onlyKeys(field, ['id', 'kind', 'label', 'description', 'required', 'placeholder', 'defaultValue', 'multiline', 'sensitive', 'minLength', 'maxLength'])) return `Unsupported text field property on ${field.id}`
      if (!optionalString(field.placeholder, 512) || (field.defaultValue !== undefined && !boundedString(field.defaultValue, 20_000, true))) return `Text value on ${field.id} is invalid`
      if (!optionalBoolean(field.multiline) || !optionalBoolean(field.sensitive)) return `Text flags on ${field.id} must be boolean`
      if (field.multiline === true && field.sensitive === true) return `Text field ${field.id} cannot be both multiline and sensitive`
      if (!optionalBoundedInteger(field.minLength, 0, 20_000) || !optionalBoundedInteger(field.maxLength, 1, 20_000)) return `Text length bounds on ${field.id} are invalid`
      if (typeof field.minLength === 'number' && typeof field.maxLength === 'number' && field.minLength > field.maxLength) return `Text length bounds on ${field.id} are inconsistent`
      continue
    }

    if (field.kind === 'choice') {
      if (!onlyKeys(field, ['id', 'kind', 'label', 'description', 'required', 'options', 'multiple', 'minSelections', 'maxSelections', 'allowOther', 'otherLabel', 'allowComment', 'commentLabel'])) return `Unsupported choice field property on ${field.id}`
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 128) return `Choice field ${field.id} must contain between 1 and 128 options`
      if (!optionalBoolean(field.multiple) || !optionalBoolean(field.allowOther) || !optionalBoolean(field.allowComment)) return `Choice flags on ${field.id} must be boolean`
      if (!optionalString(field.otherLabel, 128) || !optionalString(field.commentLabel, 128)) return `Choice labels on ${field.id} are invalid`
      if (field.otherLabel !== undefined && field.allowOther !== true) return `Choice otherLabel on ${field.id} requires allowOther`
      if (field.commentLabel !== undefined && field.allowComment !== true) return `Choice commentLabel on ${field.id} requires allowComment`
      const selectionCapacity = field.options.length + (field.allowOther === true ? 1 : 0)
      if (!optionalBoundedInteger(field.minSelections, 0, selectionCapacity) || !optionalBoundedInteger(field.maxSelections, 1, selectionCapacity)) return `Choice bounds on ${field.id} are invalid`
      if (typeof field.minSelections === 'number' && typeof field.maxSelections === 'number' && field.minSelections > field.maxSelections) return `Choice bounds on ${field.id} are inconsistent`
      if (field.multiple !== true && (Number(field.maxSelections ?? 1) > 1 || Number(field.minSelections ?? 0) > 1)) return `Single-choice field ${field.id} cannot require multiple selections`
      const optionIds = new Set<string>()
      for (const rawOption of field.options) {
        const option = record(rawOption)
        if (!option || !onlyKeys(option, ['id', 'label', 'description']) || !stableId(option.id) || optionIds.has(option.id)) return `Choice option ids on ${field.id} must be unique stable identifiers`
        if (!boundedString(option.label, 256) || !optionalString(option.description, 2_000)) return `Choice option on ${field.id} is invalid`
        optionIds.add(option.id)
      }
      continue
    }
    return `Unsupported interaction field kind on ${field.id}`
  }
  return null
}

export function validateExtensionInteractionResponseV1(value: unknown): string | null {
  const response = record(value)
  if (!response) return 'Interaction response must be an object'
  if (response.schemaVersion !== 1) return 'Unsupported interaction response schema version'
  if (response.status === 'cancelled') {
    if (!onlyKeys(response, ['schemaVersion', 'status', 'reason'])) return 'Unsupported cancelled interaction response field'
    return response.reason === undefined || cancelReasons.has(String(response.reason)) ? null : 'Unsupported interaction cancellation reason'
  }
  if (response.status !== 'submitted' || !onlyKeys(response, ['schemaVersion', 'status', 'answers']) || !Array.isArray(response.answers) || response.answers.length > 32) return 'Invalid submitted interaction response'
  const fieldIds = new Set<string>()
  for (const rawAnswer of response.answers) {
    const answer = record(rawAnswer)
    if (!answer || !stableId(answer.fieldId) || fieldIds.has(answer.fieldId)) return 'Interaction answer field ids must be unique stable identifiers'
    fieldIds.add(answer.fieldId)
    if (answer.kind === 'confirm') {
      if (!onlyKeys(answer, ['fieldId', 'kind', 'value']) || typeof answer.value !== 'boolean') return `Invalid confirm answer for ${answer.fieldId}`
    } else if (answer.kind === 'text') {
      if (!onlyKeys(answer, ['fieldId', 'kind', 'value']) || !boundedString(answer.value, 20_000, true)) return `Invalid text answer for ${answer.fieldId}`
    } else if (answer.kind === 'choice') {
      if (!onlyKeys(answer, ['fieldId', 'kind', 'selectedOptionIds', 'otherText', 'comment'])) return `Invalid choice answer for ${answer.fieldId}`
      if (!Array.isArray(answer.selectedOptionIds) || answer.selectedOptionIds.length > 128 || new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length || answer.selectedOptionIds.some(id => !stableId(id))) return `Invalid choice selections for ${answer.fieldId}`
      if ((answer.otherText !== undefined && !boundedString(answer.otherText, 20_000, true)) || (answer.comment !== undefined && !boundedString(answer.comment, 20_000, true))) return `Invalid choice text for ${answer.fieldId}`
    } else {
      return `Unsupported interaction answer kind for ${answer.fieldId}`
    }
  }
  return null
}

export function validateExtensionInteractionBridgeRequestV1(value: unknown): string | null {
  const event = record(value)
  if (!event || !onlyKeys(event, ['type', 'requestId', 'extensionId', 'runtimeId', 'sessionId', 'request', 'timeout'])) return 'Invalid interaction bridge event'
  if (event.type !== 'extension_interaction_request') return 'Unsupported interaction bridge event type'
  for (const key of ['requestId', 'extensionId', 'runtimeId', 'sessionId'] as const) if (!boundedString(event[key], 256)) return `${key} must be a non-empty bounded string`
  if (event.timeout !== undefined && (!Number.isSafeInteger(event.timeout) || Number(event.timeout) <= 0 || Number(event.timeout) > 86_400_000)) return 'Interaction timeout is invalid'
  return validateExtensionInteractionRequestV1(event.request)
}

export function validateExtensionInteractionBridgeCancelV1(value: unknown): string | null {
  const event = record(value)
  if (!event || !onlyKeys(event, ['type', 'requestId', 'extensionId', 'runtimeId', 'sessionId', 'schemaVersion', 'reason'])) return 'Invalid interaction cancellation event'
  if (event.type !== 'extension_interaction_cancel' || event.schemaVersion !== 1 || !cancelReasons.has(String(event.reason))) return 'Unsupported interaction cancellation event'
  for (const key of ['requestId', 'extensionId', 'runtimeId', 'sessionId'] as const) if (!boundedString(event[key], 256)) return `${key} must be a non-empty bounded string`
  return null
}

export function validateExtensionInteractionBridgeSettledV1(value: unknown): string | null {
  const event = record(value)
  if (!event || !onlyKeys(event, ['type', 'requestId', 'extensionId', 'runtimeId', 'sessionId', 'schemaVersion', 'outcome'])) return 'Invalid interaction settlement event'
  if (event.type !== 'extension_interaction_settled' || event.schemaVersion !== 1 || (event.outcome !== 'submitted' && event.outcome !== 'cancelled')) return 'Unsupported interaction settlement event'
  for (const key of ['requestId', 'extensionId', 'runtimeId', 'sessionId'] as const) if (!boundedString(event[key], 256)) return `${key} must be a non-empty bounded string`
  return null
}

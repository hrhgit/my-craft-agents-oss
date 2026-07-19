import type {
  Message,
  PlanArtifactV1,
  PlanModeStateV1,
  StoredMessage,
} from '@mortise/core/types';
import {
  PLAN_ARTIFACT_CUSTOM_TYPE,
  PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE,
  PLAN_MODE_STATE_CUSTOM_TYPE,
  parsePlanArtifactMessageDetails,
  parsePlanModeStateMessageDetails,
} from '@mortise/core/types';

export interface PlanCustomMessageInput {
  id: string;
  customType: string;
  content: string;
  details?: unknown;
  timestamp: number;
}

export type PlanCustomMessageProjection =
  | { kind: 'ignored' }
  | { kind: 'state'; state: PlanModeStateV1 }
  | { kind: 'artifact'; artifact: PlanArtifactV1; assistantMessageId?: string; isUpdate: boolean };

export function parsePlanCustomMessage(input: Pick<PlanCustomMessageInput, 'customType' | 'details'>): PlanCustomMessageProjection {
  if (input.customType === PLAN_MODE_STATE_CUSTOM_TYPE) {
    const parsed = parsePlanModeStateMessageDetails(input.details);
    return parsed ? { kind: 'state', state: parsed.state } : { kind: 'ignored' };
  }

  if (input.customType === PLAN_ARTIFACT_CUSTOM_TYPE || input.customType === PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE) {
    const parsed = parsePlanArtifactMessageDetails(input.details);
    if (!parsed) return { kind: 'ignored' };
    return {
      kind: 'artifact',
      artifact: parsed.artifact,
      assistantMessageId: parsed.assistantMessageId,
      isUpdate: input.customType === PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE,
    };
  }

  return { kind: 'ignored' };
}

interface ProjectableMessage {
  id: string;
  content: string;
  timestamp?: number;
  artifact?: PlanArtifactV1;
}

function findTargetIndex<T extends ProjectableMessage>(
  messages: T[],
  input: PlanCustomMessageInput,
  projection: Extract<PlanCustomMessageProjection, { kind: 'artifact' }>,
  isAssistant: (message: T) => boolean,
): number {
  if (projection.assistantMessageId) {
    const exactId = messages.findIndex(message => isAssistant(message) && message.id === projection.assistantMessageId);
    if (exactId >= 0) return exactId;
  }

  const existingArtifact = messages.findIndex(message => message.artifact?.artifactId === projection.artifact.artifactId);
  if (existingArtifact >= 0) return existingArtifact;

  const fullContent = input.content.trim();
  if (fullContent) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && isAssistant(message) && message.content.trim() === fullContent) return index;
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isAssistant(message) && !message.artifact) return index;
  }

  return -1;
}

function applyArtifactProjection<T extends ProjectableMessage>(
  messages: T[],
  input: PlanCustomMessageInput,
  projection: Extract<PlanCustomMessageProjection, { kind: 'artifact' }>,
  isAssistant: (message: T) => boolean,
  createAssistant: () => T,
): T {
  if (!projection.isUpdate) {
    for (const message of messages) {
      if (message.artifact?.artifactId !== projection.artifact.artifactId && message.artifact?.state === 'ready') {
        message.artifact = { ...message.artifact, state: 'superseded' };
      }
    }
  }

  const targetIndex = findTargetIndex(messages, input, projection, isAssistant);
  if (targetIndex >= 0) {
    const target = messages[targetIndex]!;
    target.artifact = projection.artifact;
    return target;
  }

  const created = createAssistant();
  created.artifact = projection.artifact;
  messages.push(created);
  return created;
}

export function applyPlanCustomMessageToRuntime(
  messages: Message[],
  input: PlanCustomMessageInput,
): { projection: PlanCustomMessageProjection; message?: Message } {
  const projection = parsePlanCustomMessage(input);
  if (projection.kind !== 'artifact') return { projection };
  const message = applyArtifactProjection<Message>(
    messages,
    input,
    projection,
    candidate => candidate.role === 'assistant',
    () => ({
      id: `plan-${input.id}`,
      role: 'assistant',
      content: input.content,
      timestamp: input.timestamp,
    }),
  );
  return { projection, message };
}

export function applyPlanCustomMessageToStored(
  messages: StoredMessage[],
  input: PlanCustomMessageInput,
): { projection: PlanCustomMessageProjection; message?: StoredMessage } {
  const projection = parsePlanCustomMessage(input);
  if (projection.kind !== 'artifact') return { projection };
  const message = applyArtifactProjection<StoredMessage>(
    messages,
    input,
    projection,
    candidate => candidate.type === 'assistant' || candidate.type === 'plan',
    () => ({
      id: `plan-${input.id}`,
      type: 'assistant',
      content: input.content,
      timestamp: input.timestamp,
    }),
  );
  if (message.type === 'plan') message.type = 'assistant';
  return { projection, message };
}

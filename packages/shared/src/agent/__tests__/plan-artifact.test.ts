import { describe, expect, it } from 'bun:test';
import type { Message, StoredMessage } from '@mortise/core/types';
import {
  isPlanArtifactV1,
  isPlanModeStateV1,
  parsePlanArtifactMessageDetails,
  storedToMessage,
} from '@mortise/core/types';
import { applyPlanCustomMessageToRuntime } from '../../sessions/plan-artifact-projection.ts';

const artifact = {
  schemaVersion: 1 as const,
  kind: 'plan' as const,
  artifactId: 'plan-1',
  revision: 1,
  state: 'ready' as const,
  review: { status: 'passed' as const, verdict: 'pass' as const, body: 'Looks focused.' },
  checklist: [{ id: 'step-1', title: 'Implement protocol', status: 'pending' as const }],
  models: { planner: 'planner-model', reviewer: 'reviewer-model' },
  createdAt: 100,
  finalizedAt: 110,
};

describe('plan artifact protocol', () => {
  it('accepts a complete versioned plan artifact', () => {
    expect(isPlanArtifactV1(artifact)).toBe(true);
    expect(parsePlanArtifactMessageDetails({ schemaVersion: 1, artifact })).toEqual({ schemaVersion: 1, artifact });
  });

  it('rejects kind-only and malformed artifacts', () => {
    expect(isPlanArtifactV1({ kind: 'plan' })).toBe(false);
    expect(isPlanArtifactV1({ ...artifact, schemaVersion: 2 })).toBe(false);
    expect(isPlanArtifactV1({ ...artifact, revision: 0 })).toBe(false);
    expect(isPlanArtifactV1({ ...artifact, checklist: [{ id: '', title: '', status: 'done' }] })).toBe(false);
  });

  it('validates session-authoritative plan mode state', () => {
    expect(isPlanModeStateV1({ schemaVersion: 1, phase: 'discussing', updatedAt: 100 })).toBe(true);
    expect(isPlanModeStateV1({ schemaVersion: 1, phase: 'unknown', updatedAt: 100 })).toBe(false);
  });

  it('normalizes legacy role=plan messages to assistant artifacts', () => {
    const stored: StoredMessage = {
      id: 'legacy-message',
      type: 'plan',
      content: '# Old plan',
      timestamp: 123,
      planPath: 'plans/old.md',
    };

    const message = storedToMessage(stored);
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('# Old plan');
    expect(message.artifact).toMatchObject({
      kind: 'plan',
      artifactId: 'legacy-legacy-message',
      state: 'superseded',
      legacy: true,
    });
  });

  it('binds by full assistant content and supersedes the previous ready plan', () => {
    const messages: Message[] = [
      { id: 'old', role: 'assistant' as const, content: '# Old', timestamp: 1, artifact },
      { id: 'new', role: 'assistant' as const, content: '# New', timestamp: 2 },
    ];
    const nextArtifact = { ...artifact, artifactId: 'plan-2', revision: 2 };

    const result = applyPlanCustomMessageToRuntime(messages, {
      id: 'custom-1',
      customType: 'mortise-plan-artifact',
      content: '# New',
      details: { schemaVersion: 1, artifact: nextArtifact },
      timestamp: 3,
    });

    expect(result.message?.id).toBe('new');
    expect(messages[0]?.artifact?.state).toBe('superseded');
    expect(messages[1]?.artifact?.artifactId).toBe('plan-2');
  });

  it('creates an assistant plan message when the original assistant is unavailable', () => {
    const messages: import('@mortise/core/types').Message[] = [];
    applyPlanCustomMessageToRuntime(messages, {
      id: 'custom-missing',
      customType: 'mortise-plan-artifact',
      content: '# Recovered plan',
      details: { schemaVersion: 1, artifact },
      timestamp: 3,
    });

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: '# Recovered plan',
      artifact: { artifactId: 'plan-1' },
    });
  });
});

import { describe, expect, it } from 'bun:test';
import { isPlanArtifactV1 } from '../src/types/plan-artifact.ts';

const artifact = {
  schemaVersion: 1 as const,
  kind: 'plan' as const,
  artifactId: 'plan-1',
  revision: 1,
  state: 'ready' as const,
  review: { status: 'passed' as const, verdict: 'pass' as const },
  checklist: [],
  createdAt: 100,
};

describe('PlanArtifactV1', () => {
  it('accepts the canonical versioned artifact', () => {
    expect(isPlanArtifactV1(artifact)).toBe(true);
  });

  it('rejects the removed legacy marker', () => {
    expect(isPlanArtifactV1({ ...artifact, legacy: true })).toBe(false);
    expect(isPlanArtifactV1({ ...artifact, legacy: false })).toBe(false);
  });
});

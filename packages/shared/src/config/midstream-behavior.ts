export type MidStreamBehavior = 'steer' | 'queue';

export const DEFAULT_MID_STREAM_BEHAVIOR: MidStreamBehavior = 'queue';

export function normalizeMidStreamBehavior(value: unknown): MidStreamBehavior | undefined {
  return value === 'steer' || value === 'queue' ? value : undefined;
}

export function alternateMidStreamBehavior(value: MidStreamBehavior): MidStreamBehavior {
  return value === 'queue' ? 'steer' : 'queue';
}

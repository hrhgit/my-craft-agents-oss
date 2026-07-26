import { z } from 'zod'

const stringList = z.array(z.string().min(1)).default([])

const validationEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.enum(['unit', 'contract', 'integration', 'physical']),
  command: z.string().min(1),
  description: z.string().min(1),
  triggers: z.array(z.string().min(1)).min(1),
  required: z.boolean(),
  evidence: z.string().min(1),
}).strict()

export const moduleFrontmatterSchema = z.object({
  schema: z.literal('module-agent/v2'),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  summary: z.string().min(1),
  status: z.enum(['active', 'draft', 'deprecated']),
  keywords: stringList,
  owns: z.array(z.string().min(1)).min(1),
  related: stringList,
  depends_on: stringList,
  collaborates_with: stringList,
  validation: z.array(validationEntrySchema).min(1).refine(
    entries => entries.some(entry => entry.kind === 'unit'),
    'validation must include at least one unit entry for the fast plan',
  ),
}).strict()

export const configSchema = z.object({
  schema: z.literal('module-agent-system/v2'),
  modules_dir: z.string().min(1).default('.agents/modules'),
  include: z.array(z.string().min(1)).min(1).default(['**/*']),
  exclude: stringList,
  history_limit: z.number().int().min(1).max(100).default(20),
  max_route_candidates: z.number().int().min(1).max(5).default(5),
  test_timeout_ms: z.number().int().min(1000).max(3_600_000).default(600_000),
  test_output_limit: z.number().int().min(1000).max(100_000).default(12_000),
  lock_file: z.string().min(1).default('.agents/module-lock.json'),
  state_dir: z.string().min(1).default('output/module-agents'),
  receipt_ttl_ms: z.number().int().min(0).max(604_800_000).default(86_400_000),
  strict: z.boolean().default(false),
}).strict()

export const moduleLockSchema = z.object({
  schema: z.literal('module-agent-lock/v1'),
  digests: z.record(z.string(), z.string()),
}).strict()

export const taskPlanSchema = z.object({
  schema: z.literal('module-agent/task-plan/v1'),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  query: z.string().min(1),
  intent_hash: z.string().regex(/^[0-9a-f]{64}$/),
  base_ref: z.string().min(1),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  route_files: stringList,
  owners: z.array(z.string().min(1)).min(1),
  allowed_scopes: z.array(z.string().min(1)).min(1),
  recommended_tier: z.enum(['A', 'B', 'C']),
  phase: z.enum(['discover', 'implement', 'integrate', 'accept', 'archive', 'closed']),
  frozen_source_id: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  reviewed_modules: stringList,
  checkpoints: z.record(z.string(), z.string()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  closed_at: z.string().datetime().optional(),
}).strict()

export const REQUIRED_HEADINGS = [
  'Purpose',
  'Specialist mandate',
  'Responsibilities',
  'Non-goals',
  'Contracts and invariants',
  'Architecture and entry points',
  'Collaboration',
  'Validation',
  'Known risks',
  'Semantic history',
] as const

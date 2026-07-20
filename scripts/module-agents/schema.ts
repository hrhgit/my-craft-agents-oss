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
  schema: z.literal('module-agent/v1'),
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
  scope_digest: z.string().default(''),
}).strict()

export const configSchema = z.object({
  schema: z.literal('module-agent-system/v1'),
  modules_dir: z.string().min(1).default('.agents/modules'),
  include: z.array(z.string().min(1)).min(1).default(['**/*']),
  exclude: stringList,
  history_limit: z.number().int().min(1).max(100).default(20),
  max_route_candidates: z.number().int().min(1).max(5).default(5),
  test_timeout_ms: z.number().int().min(1000).max(3_600_000).default(600_000),
  test_output_limit: z.number().int().min(1000).max(100_000).default(12_000),
  strict: z.boolean().default(false),
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

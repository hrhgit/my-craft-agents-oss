export type ModuleStatus = 'active' | 'draft' | 'deprecated'

export type ValidationKindV1 = 'unit' | 'contract' | 'integration' | 'physical'
export type ValidationLevelV1 = 'fast' | 'contract' | 'full'
export type ValidationRiskTierV1 = 'A' | 'B' | 'C'
export type RepositoryValidationModeV1 = 'structure' | 'freshness' | 'strict'

export interface ValidationEntryV1 {
  id: string
  kind: ValidationKindV1
  command: string
  description: string
  triggers: string[]
  required: boolean
  evidence: string
}

export interface ModuleDocumentV1 {
  schema: 'module-agent/v2'
  id: string
  name: string
  summary: string
  status: ModuleStatus
  keywords: string[]
  owns: string[]
  related: string[]
  depends_on: string[]
  collaborates_with: string[]
  validation: ValidationEntryV1[]
  scope_digest: string
  body: string
  path: string
}

export interface RouteCandidateV1 {
  module: string
  confidence: number
  reasons: string[]
  depends_on: string[]
}

export interface RouteResultV1 {
  schema: 'module-agent/route/v1'
  query: string
  files: string[]
  candidates: RouteCandidateV1[]
}

export interface ImpactModuleV1 {
  module: string
  owned_files: string[]
  related_files: string[]
  reason: 'owner' | 'related'
  validation: ImpactValidationV1
}

export interface ValidationPlanSummaryV1 {
  level: ValidationLevelV1
  risk_tier: ValidationRiskTierV1
  validation_ids: string[]
}

export interface ImpactValidationV1 {
  recommended_level: Exclude<ValidationLevelV1, 'full'>
  recommended_tier: Exclude<ValidationRiskTierV1, 'C'>
  available_plans: ValidationPlanSummaryV1[]
}

export interface ImpactResultV1 {
  schema: 'module-agent/impact/v1'
  base: string
  files: string[]
  modules: ImpactModuleV1[]
}

export type ValidationRunStatusV1 = 'planned' | 'passed' | 'failed' | 'timed_out'
export type ValidationReceiptStatusV1 = 'disabled' | 'hit' | 'stored'

export interface ValidationRunV1 extends ValidationEntryV1 {
  status: ValidationRunStatusV1
  exit_code?: number
  duration_ms?: number
  stdout?: string
  stderr?: string
  output_truncated?: boolean
  receipt_status?: ValidationReceiptStatusV1
  receipt_key?: string
  receipt_created_at?: string
}

export interface ModuleTestResultV1 {
  schema: 'module-agent/test/v1'
  module: string
  level: ValidationLevelV1
  dry_run: boolean
  passed: boolean | null
  validations: ValidationRunV1[]
}

export interface ModuleTestBatchResultV1 {
  schema: 'module-agent/test-batch/v1'
  modules: Array<{ module: string; level: ValidationLevelV1; validation_ids: string[] }>
  dry_run: boolean
  passed: boolean | null
  executions: Array<{ key: string; modules: string[]; validation_ids: string[]; status: ValidationRunStatusV1; receipt_status?: ValidationReceiptStatusV1 }>
  results: ModuleTestResultV1[]
}

export type DiagnosticSeverity = 'error' | 'warning'

export interface ValidationDiagnosticV1 {
  schema: 'module-agent/diagnostic/v1'
  severity: DiagnosticSeverity
  code: string
  message: string
  module?: string
  path?: string
}

export interface ValidationResultV1 {
  schema: 'module-agent/validation/v1'
  valid: boolean
  strict: boolean
  mode: RepositoryValidationModeV1
  modules: number
  files: number
  diagnostics: ValidationDiagnosticV1[]
}

export interface ModuleSystemConfigV1 {
  schema: 'module-agent-system/v2'
  modules_dir: string
  include: string[]
  exclude: string[]
  history_limit: number
  max_route_candidates: number
  test_timeout_ms: number
  test_output_limit: number
  lock_file: string
  state_dir: string
  receipt_ttl_ms: number
  strict: boolean
}

export interface ModuleLockV1 {
  schema: 'module-agent-lock/v1'
  digests: Record<string, string>
}

export type TaskPlanPhaseV1 = 'discover' | 'implement' | 'integrate' | 'accept' | 'archive' | 'closed'

export interface TaskPlanV1 {
  schema: 'module-agent/task-plan/v1'
  id: string
  query: string
  intent_hash: string
  base_ref: string
  base_commit: string
  route_files: string[]
  owners: string[]
  allowed_scopes: string[]
  recommended_tier: ValidationRiskTierV1
  phase: TaskPlanPhaseV1
  frozen_source_id?: string
  reviewed_modules: string[]
  checkpoints: Partial<Record<Exclude<TaskPlanPhaseV1, 'closed'>, string>>
  created_at: string
  updated_at: string
  closed_at?: string
}

export type ModuleStatus = 'active' | 'draft' | 'deprecated'

export type ValidationKindV1 = 'unit' | 'contract' | 'integration' | 'physical'
export type ValidationLevelV1 = 'fast' | 'contract' | 'full'

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
  schema: 'module-agent/v1'
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
  validation_ids: string[]
}

export interface ImpactValidationV1 {
  recommended_level: Exclude<ValidationLevelV1, 'full'>
  available_plans: ValidationPlanSummaryV1[]
}

export interface ImpactResultV1 {
  schema: 'module-agent/impact/v1'
  base: string
  files: string[]
  modules: ImpactModuleV1[]
}

export type ValidationRunStatusV1 = 'planned' | 'passed' | 'failed' | 'timed_out'

export interface ValidationRunV1 extends ValidationEntryV1 {
  status: ValidationRunStatusV1
  exit_code?: number
  duration_ms?: number
  stdout?: string
  stderr?: string
  output_truncated?: boolean
}

export interface ModuleTestResultV1 {
  schema: 'module-agent/test/v1'
  module: string
  level: ValidationLevelV1
  dry_run: boolean
  passed: boolean | null
  validations: ValidationRunV1[]
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
  modules: number
  files: number
  diagnostics: ValidationDiagnosticV1[]
}

export interface ModuleSystemConfigV1 {
  schema: 'module-agent-system/v1'
  modules_dir: string
  include: string[]
  exclude: string[]
  history_limit: number
  max_route_candidates: number
  test_timeout_ms: number
  test_output_limit: number
  strict: boolean
}

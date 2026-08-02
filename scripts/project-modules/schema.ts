import { z } from 'zod'

const stringList = z.array(z.string().min(1)).default([])

const frontendImpactSchema = z.object({
  affects: z.boolean(),
  areas: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  if (value.affects && value.areas.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['areas'],
      message: 'Frontend-affecting modules must name at least one frontend area.',
    })
  }
  if (!value.affects && value.areas.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['areas'],
      message: 'Modules without frontend impact must use an empty areas list.',
    })
  }
})

export const projectModuleSchema = z.object({
  schema: z.literal('project-module/v1'),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  summary: z.string().min(1),
  status: z.enum(['active', 'draft', 'deprecated']).default('active'),
  when_to_read: z.array(z.string().min(1)).min(1),
  tags: stringList,
  entrypoints: z.array(z.string().min(1)).min(1),
  depends_on: stringList,
  related: stringList,
  frontend_impact: frontendImpactSchema,
  validation: stringList,
}).strict()

export type ProjectModule = z.infer<typeof projectModuleSchema> & {
  document: string
}

export interface ProjectModuleDiagnostic {
  code: 'DUPLICATE_ID' | 'FILENAME_MISMATCH' | 'INVALID_DOCUMENT' | 'INVALID_ENTRYPOINT' | 'INVALID_REFERENCE' | 'MISSING_ENTRYPOINT'
  message: string
  document: string
  module?: string
}

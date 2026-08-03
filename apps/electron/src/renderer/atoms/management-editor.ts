import { atom } from 'jotai'

export type ManagementEditorState =
  | { kind: 'skill'; skillSlug?: string }
  | { kind: 'automation'; automationId?: string }
  | null

export const managementEditorAtom = atom<ManagementEditorState>(null)

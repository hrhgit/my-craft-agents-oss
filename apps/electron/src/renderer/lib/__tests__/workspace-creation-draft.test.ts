import { beforeEach, describe, expect, it } from 'bun:test'

const values = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
})

const {
  clearWorkspaceCreationDraft,
  readWorkspaceCreationDraft,
  writeWorkspaceCreationDraft,
} = await import('../workspace-creation-draft')

describe('workspace creation draft', () => {
  beforeEach(() => values.clear())

  it('restores normal fields and removes duplicate locations', () => {
    writeWorkspaceCreationDraft({
      name: 'Project',
      locationPaths: ['E:\\Docs', 'E:\\Docs', 'E:\\Assets'],
      primaryLocationIndex: 2,
    })

    expect(readWorkspaceCreationDraft()).toEqual({
      name: 'Project',
      locationPaths: ['E:\\Docs', 'E:\\Assets'],
      primaryLocationIndex: 1,
    })
  })

  it('falls back to the first location when the persisted primary is invalid', () => {
    writeWorkspaceCreationDraft({
      name: '',
      locationPaths: ['E:\\Project'],
      primaryLocationIndex: 4,
    })
    expect(readWorkspaceCreationDraft().primaryLocationIndex).toBe(0)
  })

  it('clears the successful creation draft', () => {
    writeWorkspaceCreationDraft({
      name: 'Project',
      locationPaths: ['E:\\Docs'],
      primaryLocationIndex: 0,
    })
    clearWorkspaceCreationDraft()
    expect(readWorkspaceCreationDraft()).toEqual({
      name: '',
      locationPaths: [],
      primaryLocationIndex: null,
    })
  })
})

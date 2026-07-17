import { describe, expect, it } from 'bun:test'
import { FILE_WORKBENCH_SEMANTIC_IDS } from './file-workbench-semantics'

describe('file workbench semantic identity', () => {
  it('keeps file and tree commands stable', () => {
    expect(FILE_WORKBENCH_SEMANTIC_IDS).toEqual({
      createFile: 'workspace.files.create-file',
      createFolder: 'workspace.files.create-folder',
      refreshTree: 'workspace.files.refresh-tree',
      closeTree: 'workspace.files.close-tree',
      revert: 'workspace.files.revert',
      save: 'workspace.files.save',
      copyPath: 'workspace.files.copy-path',
      refreshPreview: 'workspace.files.refresh-preview',
      toggleTree: 'workspace.files.toggle-tree',
    })
  })
})

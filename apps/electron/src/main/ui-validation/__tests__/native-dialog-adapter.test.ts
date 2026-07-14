import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { ElectronNativeDialogAdapter } = await import('../native-dialog-adapter')

function windowStub() { return { isDestroyed: () => false } as never }

describe('ElectronNativeDialogAdapter', () => {
  it('opens only typed dialog shapes and reports completion without exposing selected paths', async () => {
    let resolveDialog!: (result: { canceled: boolean; filePaths: string[] }) => void
    const changes: unknown[] = []
    const adapter = new ElectronNativeDialogAdapter({
      showOpenDialog: async () => await new Promise(resolve => { resolveDialog = resolve }),
      showSaveDialog: async () => ({ canceled: true }),
    }, record => changes.push(record))
    const opened = adapter.open(windowStub(), { kind: 'open-directory', title: 'Choose workspace' })
    expect(opened).toMatchObject({ kind: 'open-directory', phase: 'opening' })
    expect(() => adapter.open(windowStub(), { kind: 'open-file' })).toThrow('already active')
    const completed = adapter.wait(opened.dialogId, { timeoutMs: 500 })
    resolveDialog({ canceled: false, filePaths: ['C:\\private\\workspace'] })
    await expect(completed).resolves.toMatchObject({ phase: 'completed', canceled: false, selectionCount: 1 })
    expect(adapter.status(opened.dialogId)).toMatchObject({ phase: 'completed', canceled: false, selectionCount: 1 })
    expect(JSON.stringify(adapter.status(opened.dialogId))).not.toContain('private')
    expect(changes).toHaveLength(2)
  })

  it('checks current completion before subscribing and supports cancellation', async () => {
    let resolveDialog!: (result: { canceled: boolean; filePaths: string[] }) => void
    const adapter = new ElectronNativeDialogAdapter({
      showOpenDialog: async () => await new Promise(resolve => { resolveDialog = resolve }),
      showSaveDialog: async () => ({ canceled: true }),
    })
    const opened = adapter.open(windowStub(), { kind: 'open-file' })
    const controller = new AbortController()
    const aborted = adapter.wait(opened.dialogId, { timeoutMs: 500, signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'DRIVER_DISCONNECTED' })

    resolveDialog({ canceled: true, filePaths: [] })
    await expect(adapter.wait(opened.dialogId)).resolves.toMatchObject({ phase: 'completed', canceled: true })
  })

  it('rejects arbitrary dialog kinds and bounds titles', () => {
    const adapter = new ElectronNativeDialogAdapter({
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
    })
    expect(() => adapter.open(windowStub(), { kind: 'message' as never })).toThrow('Unsupported native dialog kind')
    expect(() => adapter.open(windowStub(), { kind: 'open-file', title: 'x'.repeat(201) })).toThrow('1 to 200')
  })
})

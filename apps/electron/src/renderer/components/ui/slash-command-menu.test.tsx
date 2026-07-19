import { describe, expect, it, mock } from 'bun:test'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { DEFAULT_SLASH_COMMANDS } = await import('./slash-command-menu')

describe('default slash commands', () => {
  it('keeps permission modes in the composer selector instead of the slash menu', () => {
    expect(DEFAULT_SLASH_COMMANDS.map(command => command.id)).toEqual(['compact'])
    expect(DEFAULT_SLASH_COMMANDS.map(command => command.id)).not.toContain('safe')
    expect(DEFAULT_SLASH_COMMANDS.map(command => command.id)).not.toContain('ask')
    expect(DEFAULT_SLASH_COMMANDS.map(command => command.id)).not.toContain('allow-all')
  })
})

import { describe, expect, it, mock } from 'bun:test'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { DEFAULT_SLASH_COMMANDS } = await import('./slash-command-menu')

describe('default slash commands', () => {
  it('contains only host-owned default commands', () => {
    expect(DEFAULT_SLASH_COMMANDS.map(command => command.id)).toEqual(['compact'])
  })
})

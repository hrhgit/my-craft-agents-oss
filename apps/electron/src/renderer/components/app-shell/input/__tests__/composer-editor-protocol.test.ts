import { describe, expect, it } from 'bun:test'
import {
  composerDocumentToText,
  composerTextToDocument,
} from '../ComposerEditor'
import type { LoadedSkill } from '../../../../../shared/types'

const skills: LoadedSkill[] = [{
  slug: 'review',
  metadata: { name: 'Review', description: '' },
  content: '',
  path: 'C:/workspace/.agents/skills/review',
  source: 'project',
}]

describe('ComposerEditor text protocol', () => {
  it('round-trips skill, file and folder atoms without changing their source text', () => {
    const value = '请检查 [skill:.agents:review] 和 [file:src/app.ts]，目录是 [folder:src/components]。'
    const document = composerTextToDocument(value, skills)
    expect(document.content?.[0]?.content?.filter(node => node.type === 'composerMention')).toHaveLength(3)
    expect(composerDocumentToText(document)).toBe(value)
  })

  it('keeps ordinary bracket text as ordinary text', () => {
    const value = '数组 [one, two] 与未知引用 [skill:not-loaded] 都保留原样'
    expect(composerDocumentToText(composerTextToDocument(value, skills))).toBe(value)
  })

  it('preserves empty lines and long plain text', () => {
    const value = `${'x'.repeat(5000)}\n\n末行`
    expect(composerDocumentToText(composerTextToDocument(value, skills))).toBe(value)
  })
})

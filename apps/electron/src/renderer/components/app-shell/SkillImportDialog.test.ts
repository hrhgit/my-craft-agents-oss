import { describe, expect, it } from 'bun:test'
import type { DiscoveredSkill } from '../../../shared/types'
import { groupSkillImportCandidates, toggleSkillImportExpanded, toggleSkillImportGroup } from './SkillImportDialog'

const candidates: DiscoveredSkill[] = [
  { sourcePath: 'C:\\Users\\test\\.agents\\skills\\beta', skillsRoot: 'C:\\Users\\test\\.agents\\skills', slug: 'beta' },
  { sourcePath: 'C:\\Users\\test\\.codex\\skills\\alpha', skillsRoot: 'C:\\Users\\test\\.codex\\skills', slug: 'alpha' },
  { sourcePath: 'C:\\Users\\test\\.agents\\skills\\alpha', skillsRoot: 'C:\\Users\\test\\.agents\\skills', slug: 'alpha' },
]

describe('SkillImportDialog grouping', () => {
  it('groups candidates by source directory and sorts each group', () => {
    const groups = groupSkillImportCandidates(candidates)

    expect(groups.map(group => group.skillsRoot)).toEqual([
      'C:\\Users\\test\\.agents\\skills',
      'C:\\Users\\test\\.codex\\skills',
    ])
    expect(groups[0]?.candidates.map(candidate => candidate.slug)).toEqual(['alpha', 'beta'])
  })

  it('selects and deselects only the requested source group', () => {
    const groups = groupSkillImportCandidates(candidates)
    const agentsGroup = groups[0]!.candidates
    const codexPath = candidates[1]!.sourcePath

    const selected = toggleSkillImportGroup(new Set([codexPath]), agentsGroup)
    expect([...selected].sort()).toEqual(candidates.map(candidate => candidate.sourcePath).sort())

    const deselected = toggleSkillImportGroup(selected, agentsGroup)
    expect([...deselected]).toEqual([codexPath])
  })

  it('toggles a single source group between expanded and collapsed', () => {
    const expandedRoots = new Set(['C:\\Users\\test\\.agents\\skills', 'C:\\Users\\test\\.codex\\skills'])

    const collapsed = toggleSkillImportExpanded(expandedRoots, 'C:\\Users\\test\\.agents\\skills')
    expect([...collapsed]).toEqual(['C:\\Users\\test\\.codex\\skills'])

    const restored = toggleSkillImportExpanded(collapsed, 'C:\\Users\\test\\.agents\\skills')
    expect([...restored].sort()).toEqual([...expandedRoots].sort())
  })
})

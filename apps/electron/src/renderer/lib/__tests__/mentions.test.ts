import { describe, expect, it } from 'bun:test'
import {
  extractBadges,
  findMentionMatches,
  parseMentions,
  removeMention,
  resolveSkillMentions,
} from '../mentions'

describe('skill mentions', () => {
  const availableSkills = ['commit', 'review-pr', 'my_skill', 'skill.name']

  it('parses simple and workspace-qualified skill mentions', () => {
    expect(parseMentions('[skill:review-pr]', availableSkills).skills).toEqual(['review-pr'])
    expect(parseMentions('[skill:My Workspace:commit]', availableSkills).skills).toEqual(['commit'])
    expect(parseMentions('[skill:My-Cool_Workspace:my_skill]', availableSkills).skills).toEqual(['my_skill'])
  })

  it('deduplicates and ignores unavailable skills', () => {
    expect(parseMentions('[skill:commit] [skill:commit] [skill:missing]', availableSkills).skills)
      .toEqual(['commit'])
  })

  it('finds positions and removes qualified mentions', () => {
    const text = 'Please use [skill:My Workspace:commit] now'
    expect(findMentionMatches(text, availableSkills)).toEqual([{
      type: 'skill',
      id: 'commit',
      fullMatch: '[skill:My Workspace:commit]',
      startIndex: 11,
    }])
    expect(removeMention(text, 'skill', 'commit')).toBe('Please use now')
  })

  it('resolves mentions to display names', () => {
    const names = new Map([['commit', 'Commit Changes']])
    expect(resolveSkillMentions('Run [skill:commit] now', names)).toBe('Run [Mentioned skill: Commit Changes] now')
  })
})

describe('badge extraction', () => {
  const skills = [
    { slug: 'commit', metadata: { name: 'Commit' }, source: 'workspace' },
    { slug: 'review-pr', metadata: { name: 'Review PR' }, source: 'workspace' },
  ] as any[]

  it('qualifies skill badge text with the active workspace slug', () => {
    const badges = extractBadges('[skill:commit]', skills, 'my-project')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatchObject({
      type: 'skill',
      label: 'Commit',
      rawText: '[skill:my-project:commit]',
    })
  })

  it('re-qualifies an existing workspace-qualified mention', () => {
    const badges = extractBadges('[skill:other-ws:review-pr]', skills, 'my-project')
    expect(badges[0]?.rawText).toBe('[skill:my-project:review-pr]')
  })
})

import { beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

import { PrerequisiteManager } from '../prerequisite-manager.ts'

const WORKSPACE_ROOT = '/test/workspace'
const skillPath = (slug: string) => resolve(WORKSPACE_ROOT, '.pi', 'skills', slug, 'SKILL.md')

describe('PrerequisiteManager', () => {
  let manager: PrerequisiteManager
  let debugMessages: string[]

  beforeEach(() => {
    debugMessages = []
    manager = new PrerequisiteManager({
      workspaceRootPath: WORKSPACE_ROOT,
      onDebug: message => debugMessages.push(message),
    })
  })

  it('allows ordinary tools when no skill prerequisite is pending', () => {
    expect(manager.checkPrerequisites('Read')).toEqual({ allowed: true })
    expect(manager.checkPrerequisites('mcp__calendar__listEvents')).toEqual({ allowed: true })
  })

  it('blocks other tools until registered skill instructions are read', () => {
    const path = skillPath('review')
    manager.registerSkillPrerequisites([path])

    expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false)
    manager.trackReadTool({ file_path: path })
    expect(manager.checkPrerequisites('WebSearch')).toEqual({ allowed: true })
  })

  it('allows Read while skill instructions are pending', () => {
    manager.registerSkillPrerequisites([skillPath('review')])
    expect(manager.checkPrerequisites('Read')).toEqual({ allowed: true })
  })

  it('clears a skill prerequisite when Bash reads its path', () => {
    const path = skillPath('review')
    manager.registerSkillPrerequisites([path])

    expect(manager.trackBashSkillRead({ command: `cat ${path}` })).toBe(true)
    expect(manager.checkPrerequisites('WebSearch')).toEqual({ allowed: true })
    expect(debugMessages.some(message => message.includes('cleared skill prerequisite via Bash'))).toBe(true)
  })

  it('keeps pending skills when Bash reads another path', () => {
    manager.registerSkillPrerequisites([skillPath('review')])
    expect(manager.trackBashSkillRead({ command: 'cat /tmp/other.md' })).toBe(false)
    expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false)
  })

  it('resets read and pending prerequisite state after compaction', () => {
    const path = skillPath('review')
    manager.trackReadTool({ file_path: '/tmp/readme.md' })
    manager.registerSkillPrerequisites([path])

    manager.resetReadState()

    expect(manager.hasRead('/tmp/readme.md')).toBe(false)
    expect(manager.checkPrerequisites('WebSearch')).toEqual({ allowed: true })
  })
})

/**
 * Skills Module
 *
 * Workspace skills are specialized instructions that extend Claude's capabilities.
 */

export * from './types.ts';
export {
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  deleteSkill,
  skillNeedsIconDownload,
  downloadSkillIcon,
  resolveSkillDir,
} from './storage.ts';

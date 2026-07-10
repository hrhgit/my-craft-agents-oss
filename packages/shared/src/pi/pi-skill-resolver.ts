import { listSkillsSync as listPiSkillsSync } from '@earendil-works/pi-coding-agent/host-facade';
import { validateSkillSlug } from '../skills/storage.ts';

export type PiSkillTier = 'global' | 'project';

export interface PiSkillPath {
  tier: PiSkillTier;
  dir: string;
}

export interface PiResolvedSkill {
  tier: PiSkillTier;
  skillDir: string;
  skillFile: string;
}

function tierForIndex(index: number): PiSkillTier {
  return index === 0 ? 'global' : 'project';
}

export class PiSkillResolver {
  constructor(private readonly projectRoot?: string) {}

  getSkillPaths(): PiSkillPath[] {
    return listPiSkillsSync({ cwd: this.projectRoot }).skillRoots.map((dir, index) => ({
      tier: tierForIndex(index),
      dir,
    }));
  }

  resolveSkill(slug: string): PiResolvedSkill | null {
    if (validateSkillSlug(slug) === null) return null;

    const result = listPiSkillsSync({ cwd: this.projectRoot });
    const skill = result.skills.find(candidate => candidate.slug === slug);
    if (!skill) return null;

    const tierIndex = result.skillRoots.findIndex(root => skill.baseDir === root || skill.baseDir.startsWith(`${root}\\`) || skill.baseDir.startsWith(`${root}/`));
    return {
      tier: tierForIndex(tierIndex <= 0 ? 0 : tierIndex),
      skillDir: skill.baseDir,
      skillFile: skill.filePath,
    };
  }
}

export function createPiSkillResolver(projectRoot?: string): PiSkillResolver {
  return new PiSkillResolver(projectRoot);
}

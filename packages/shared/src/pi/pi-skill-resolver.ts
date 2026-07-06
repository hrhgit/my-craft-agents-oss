import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PI_PROJECT_SKILLS_DIR, PI_SKILLS_DIR } from '../config/paths.ts';
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

export class PiSkillResolver {
  constructor(private readonly projectRoot?: string) {}

  getSkillPaths(): PiSkillPath[] {
    const paths: PiSkillPath[] = [{ tier: 'global', dir: PI_SKILLS_DIR }];
    if (this.projectRoot) {
      paths.push({ tier: 'project', dir: join(this.projectRoot, PI_PROJECT_SKILLS_DIR) });
    }
    return paths;
  }

  resolveSkill(slug: string): PiResolvedSkill | null {
    if (validateSkillSlug(slug) === null) return null;

    const tiers = this.getSkillPaths();
    for (let i = tiers.length - 1; i >= 0; i--) {
      const tier = tiers[i]!;
      const skillDir = join(tier.dir, slug);
      const skillFile = join(skillDir, 'SKILL.md');
      if (existsSync(skillFile)) {
        return { tier: tier.tier, skillDir, skillFile };
      }
    }
    return null;
  }
}

export function createPiSkillResolver(projectRoot?: string): PiSkillResolver {
  return new PiSkillResolver(projectRoot);
}

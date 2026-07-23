/**
 * Skill Validate Handler
 *
 * Validates a skill's SKILL.md file for correct format and required fields.
 * Resolves skills from both tiers: project > global.
 *
 * Project-tier skills always resolve from the canonical workspace root.
 */

import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import {
  validateSlug,
  validateSkillContent,
  formatValidationResult,
} from '../validation.ts';

export interface SkillValidateArgs {
  skillSlug: string;
}

/**
 * Resolve the SKILL.md path by checking both tiers (project > global).
 * Returns the first match, or null if not found anywhere.
 */
function resolveSkillMdPath(
  ctx: SessionToolContext,
  slug: string
): { path: string; tier: string } | null {
  const tiers = getSkillRoots(ctx);
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tier = tiers[i]!;
    const skillPath = join(tier.dir, slug, 'SKILL.md');
    if (ctx.fs.exists(skillPath)) {
      return { path: skillPath, tier: tier.tier };
    }
  }

  return null;
}

function getSkillRoots(ctx: SessionToolContext): Array<{ dir: string; tier: 'global' | 'project' }> {
  const roots = ctx.skillPaths?.filter(Boolean);
  const paths = roots?.length ? roots : (ctx.skillsPath ? [ctx.skillsPath] : []);

  return paths.map((dir, index) => ({
    dir,
    tier: index === 0 ? 'global' : 'project',
  }));
}

/**
 * Handle the skill_validate tool call.
 *
 * 1. Validate slug format
 * 2. Resolve project skills from the workspace root
 * 3. Resolve SKILL.md from both tiers (project > global)
 * 4. Read and validate content (frontmatter + body)
 * 5. Return the validation result
 */
export async function handleSkillValidate(
  ctx: SessionToolContext,
  args: SkillValidateArgs
): Promise<ToolResult> {
  const { skillSlug } = args;

  // Validate slug format first
  const slugResult = validateSlug(skillSlug);
  if (!slugResult.valid) {
    return errorResponse(formatValidationResult(slugResult));
  }

  // Resolve SKILL.md from both tiers (project > global)
  const resolved = resolveSkillMdPath(ctx, skillSlug);
  if (!resolved) {
    const searchedPaths = getSkillRoots(ctx)
      .slice()
      .reverse()
      .map((tier) => `  - ${join(tier.dir, skillSlug, 'SKILL.md')} (${tier.tier})`)
      .join('\n');

    return errorResponse(
      `SKILL.md not found for skill "${skillSlug}". Searched:\n${searchedPaths}\n\nCreate it with YAML frontmatter.`
    );
  }

  // Read and validate content
  let content: string;
  try {
    content = ctx.fs.readFile(resolved.path);
  } catch (e) {
    return errorResponse(
      `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  const result = validateSkillContent(content, skillSlug);
  const tierInfo = `Validated from ${resolved.tier} tier: ${resolved.path}`;
  const formatted = formatValidationResult(result);

  return {
    content: [{ type: 'text', text: `${tierInfo}\n\n${formatted}` }],
    isError: !result.valid, // warnings don't make it an error
  };
}

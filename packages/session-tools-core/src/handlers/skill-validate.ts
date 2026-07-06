/**
 * Skill Validate Handler
 *
 * Validates a skill's SKILL.md file for correct format and required fields.
 * Resolves skills from both tiers: project > global.
 *
 * The handler resolves the session's workingDirectory on demand from the
 * persisted session.jsonl header — no construction-time propagation needed.
 * If resolution fails, project-tier skills are silently skipped with a warning.
 */

import { join } from 'node:path';
import { createPiSkillResolver } from '@craft-agent/shared/pi/skill-resolver';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { resolveSessionWorkingDirectory } from '../source-helpers.ts';
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
  slug: string,
  workingDirectory: string | undefined
): { path: string; tier: string } | null {
  const tiers = createPiSkillResolver(workingDirectory).getSkillPaths();
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tier = tiers[i]!;
    const skillPath = join(tier.dir, slug, 'SKILL.md');
    if (ctx.fs.exists(skillPath)) {
      return { path: skillPath, tier: tier.tier };
    }
  }

  return null;
}

/**
 * Handle the skill_validate tool call.
 *
 * 1. Validate slug format
 * 2. Resolve workingDirectory from ctx or session header (graceful fallback)
 * 3. Resolve SKILL.md from both tiers (project > global)
 * 4. Read and validate content (frontmatter + body)
 * 5. Return validation result with warnings if project tier was skipped
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

  // Resolve workingDirectory: ctx first (if factories ever populate it), then session header
  const workingDirectory = ctx.workingDirectory
    ?? resolveSessionWorkingDirectory(ctx.workspacePath, ctx.sessionId);

  // Resolve SKILL.md from both tiers (project > global)
  const resolved = resolveSkillMdPath(ctx, skillSlug, workingDirectory);
  if (!resolved) {
    const searchedPaths = createPiSkillResolver(workingDirectory)
      .getSkillPaths()
      .slice()
      .reverse()
      .map((tier) => `  - ${join(tier.dir, skillSlug, 'SKILL.md')} (${tier.tier})`)
      .join('\n');

    const warning = !workingDirectory
      ? '\n\nNote: Project-level skills (.pi/skills/) were not checked — working directory could not be resolved.'
      : '';

    return errorResponse(
      `SKILL.md not found for skill "${skillSlug}". Searched:\n${searchedPaths}${warning}\n\nCreate it with YAML frontmatter.`
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

  // If workingDirectory couldn't be resolved, warn that project tier was skipped
  const warnings: string[] = [];
  if (!workingDirectory) {
    warnings.push('Note: Project-level skills (.pi/skills/) were not checked — working directory could not be resolved.');
  }
  const warningText = warnings.length > 0 ? '\n\n' + warnings.join('\n') : '';

  return {
    content: [{ type: 'text', text: `${tierInfo}\n\n${formatted}${warningText}` }],
    isError: !result.valid, // warnings don't make it an error
  };
}

/**
 * Render Template Handler
 *
 * Renders HTML templates with data using Mustache syntax.
 * Templates are stored per-source in the workspace.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { loadTemplate, validateTemplateData } from '../templates/loader.ts';
import { renderMustache } from '../templates/mustache.ts';
import { basename, join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isPathWithinDirectoryForCreation } from '../runtime/path-security.ts';
import { validateSlug } from '../validation.ts';

export interface RenderTemplateArgs {
  source: string;
  template: string;
  data: Record<string, unknown>;
}

/**
 * Handle the render_template tool call.
 *
 * 1. Validates source and template exist
 * 2. Soft-validates data against template @required fields
 * 3. Renders template with Mustache
 * 4. Writes output HTML to session data folder
 * 5. Returns absolute path for use in html-preview blocks
 */
export async function handleRenderTemplate(
  ctx: SessionToolContext,
  args: RenderTemplateArgs
): Promise<ToolResult> {
  if (!ctx.dataPath) {
    return errorResponse('render_template requires dataPath in context.');
  }

  // Security: source comes from an untrusted tool call and is used to build a
  // filesystem path. Reject anything that contains path separators (basename
  // mismatch) or is not a bare slug, to prevent traversal outside sources/.
  if (basename(args.source) !== args.source) {
    return errorResponse(
      `Invalid source "${args.source}": must not contain path separators.`
    );
  }
  const sourceSlugResult = validateSlug(args.source);
  if (!sourceSlugResult.valid) {
    return errorResponse(
      `Invalid source "${args.source}": source must be a lowercase alphanumeric slug (e.g., "linear").`
    );
  }

  // Security: template is also untrusted and is concatenated into the template
  // file path. Reject any value containing path separators.
  if (basename(args.template) !== args.template) {
    return errorResponse(
      `Invalid template "${args.template}": must not contain path separators.`
    );
  }

  const sourcePath = join(ctx.workspacePath, 'sources', args.source);

  // Validate source exists
  if (!existsSync(sourcePath)) {
    return errorResponse(
      `Source "${args.source}" not found at ${sourcePath}`
    );
  }

  // Load template
  const template = loadTemplate(sourcePath, args.template);
  if (!template) {
    return errorResponse(
      `Template "${args.template}" not found for source "${args.source}".\n\nExpected file: ${join(sourcePath, 'templates', `${args.template}.html`)}`
    );
  }

  // Soft validation
  const warnings = validateTemplateData(template.meta, args.data);

  // Render template
  let rendered: string;
  try {
    rendered = renderMustache(template.content, args.data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Error rendering template "${args.template}": ${msg}`);
  }

  // Write output to session data folder
  const dataDir = ctx.dataPath;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const outputFileName = `${args.source}-${args.template}-${Date.now()}.html`;
  const outputPath = join(dataDir, outputFileName);

  // Security: defense-in-depth — ensure the resolved output path stays within
  // the session data directory before writing. source/template are already
  // bare names, but this guards against any future bypass.
  const resolvedOutput = resolve(dataDir, outputPath);
  if (!isPathWithinDirectoryForCreation(resolvedOutput, dataDir)) {
    return errorResponse(
      `Output path escapes session data directory: ${outputPath}`
    );
  }

  writeFileSync(resolvedOutput, rendered, 'utf-8');

  // Build response
  const lines: string[] = [];
  lines.push(`Rendered template: ${template.meta.name || args.template}`);
  lines.push(`Output: ${resolvedOutput}`);
  lines.push('');
  lines.push(`Use this absolute path as the "src" value in your html-preview block.`);

  if (warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of warnings) {
      lines.push(`  - ${w.message}`);
    }
    lines.push('The template was rendered but may have blank sections. Consider re-rendering with the missing fields.');
  }

  return successResponse(lines.join('\n'));
}

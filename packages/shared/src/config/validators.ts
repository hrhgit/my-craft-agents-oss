/**
 * Config Validators
 *
 * Zod schemas and validation utilities for config files.
 * Used by agents to validate config changes before they take effect.
 *
 * Validates:
 * - config.json: Main app configuration
 * - preferences.json: User preferences
 * - permissions.json: Permission rules for Explore mode
 * - tool-icons/tool-icons.json: CLI tool icon mappings
 */

import { z } from 'zod';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { safeJsonParse, readJsonFileSync } from '../utils/files.ts';
import { EntityColorSchema } from '../colors/validate.ts';
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels.ts';
import { SUPPORTED_LANGUAGE_CODES } from '../i18n/languages.ts';
import type { LanguageCode } from '../i18n/languages.ts';

// ============================================================
// Config Directory
// ============================================================

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// ============================================================
// Validation Result Types
// ============================================================

export interface ValidationIssue {
  file: string;
  path: string;  // JSON path like "workspaces[0].name"
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  fixed?: string[];
}

// ============================================================
// Zod Schemas
// ============================================================

// --- config.json ---

const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional(),
  createdAt: z.number().int().positive(),
  sessionId: z.string().optional(),
  iconUrl: z.string().optional(),
});

export const StoredConfigSchema = z.object({
  workspaces: z.array(WorkspaceSchema).min(0),
  activeWorkspaceId: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  // Legacy connection fields are intentionally not part of the validated shape.
  midStreamBehavior: z.enum(['steer', 'queue']).optional(),
  defaultThinkingLevel: z.enum([...THINKING_LEVEL_IDS, 'think'] as [string, ...string[]]).transform(v => v === 'think' ? 'medium' : v).optional(),
  // Note: tokenDisplay, showCost, cumulativeUsage, defaultPermissionMode removed
  // Permission mode and cyclable modes are now per-workspace in workspace config.json
});

// --- preferences.json ---

const LocationSchema = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
});

export const UserPreferencesSchema = z.object({
  name: z.string().optional(),
  timezone: z.string().optional(),  // TODO: Could validate against IANA timezone list
  location: LocationSchema.optional(),
  notes: z.string().optional(),
  // Internal: mirrors Appearance → Language. Not user-editable.
  // Validated against the registry-derived supported set.
  uiLanguage: z.enum([...SUPPORTED_LANGUAGE_CODES] as [LanguageCode, ...LanguageCode[]]).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).passthrough();

// ============================================================
// Validation Functions
// ============================================================

/**
 * Convert Zod error to ValidationIssues
 */
function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * Validate config.json
 */
export function validateConfig(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists
  if (!existsSync(CONFIG_FILE)) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: 'Config file does not exist',
        severity: 'error',
        suggestion: 'Run setup to create initial configuration',
      }],
      warnings: [],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = StoredConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'config.json'));
  } else {
    const config = result.data;

    // Semantic validations
    if (config.activeWorkspaceId && config.workspaces.length > 0) {
      const activeExists = config.workspaces.some(w => w.id === config.activeWorkspaceId);
      if (!activeExists) {
        errors.push({
          file: 'config.json',
          path: 'activeWorkspaceId',
          message: `Active workspace ID '${config.activeWorkspaceId}' does not exist in workspaces array`,
          severity: 'error',
          suggestion: 'Set activeWorkspaceId to an existing workspace ID or null',
        });
      }
    }

  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate preferences.json
 */
export function validatePreferences(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists (preferences are optional)
  if (!existsSync(PREFERENCES_FILE)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'preferences.json',
        path: '',
        message: 'Preferences file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(PREFERENCES_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'preferences.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = UserPreferencesSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'preferences.json'));
  } else {
    const prefs = result.data;

    // Warn about missing recommended fields
    if (!prefs.name) {
      warnings.push({
        file: 'preferences.json',
        path: 'name',
        message: 'User name is not set',
        severity: 'warning',
        suggestion: 'Setting a name helps personalize agent responses',
      });
    }

    if (!prefs.timezone) {
      warnings.push({
        file: 'preferences.json',
        path: 'timezone',
        message: 'Timezone is not set',
        severity: 'warning',
        suggestion: 'Setting timezone helps with date/time formatting',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate all config files
 * @param workspaceRoot - Optional workspace root path for workspace validation
 */
export function validateAll(workspaceRoot?: string): ValidationResult {
  const results: ValidationResult[] = [
    validateConfig(),
    validatePreferences(),
    validateToolIcons(),
  ];

  // Include workspace-scoped validation if workspaceRoot is provided
  if (workspaceRoot) {
    results.push(validateAllSkills(workspaceRoot));
    results.push(validateAutomations(workspaceRoot));
    results.push(validateAllPermissions(workspaceRoot));
  }

  const allErrors = results.flatMap(r => r.errors);
  const allWarnings = results.flatMap(r => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// ============================================================
// Slug Validation
// ============================================================

/**
 * Regex for valid slugs: lowercase alphanumeric with hyphens.
 * Must start and end with an alphanumeric character (no leading/trailing hyphens).
 * Single-character slugs are allowed.
 */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a slug format.
 * Slug must be lowercase alphanumeric with hyphens, starting and ending
 * with an alphanumeric character.
 */
export function validateSlug(slug: string): ValidationResult {
  if (!SLUG_REGEX.test(slug)) {
    const suggestedSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');

    return {
      valid: false,
      errors: [{
        file: '',
        path: 'slug',
        message: 'Slug must be lowercase alphanumeric with hyphens',
        severity: 'error',
        suggestion: `Suggested: '${suggestedSlug || 'valid-slug-name'}'`,
      }],
      warnings: [],
    };
  }

  return { valid: true, errors: [], warnings: [] };
}

// ============================================================
// Skill Validators
// ============================================================

import matter from 'gray-matter';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { basename, extname } from 'path';

/**
 * Schema for skill metadata (SKILL.md frontmatter)
 */
export const SkillMetadataSchema = z.object({
  name: z.string().min(1, "Add a 'name' field with a human-readable title (e.g., 'Git Commit Helper')"),
  description: z.string().min(1, "Add a 'description' field explaining what this skill does and when to use it (1-2 sentences)"),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
});

/**
 * Find icon file in skill directory
 */
function findSkillIconForValidation(skillDir: string): string | null {
  const iconExtensions = ['.svg', '.png', '.jpg', '.jpeg'];

  for (const ext of iconExtensions) {
    const iconPath = join(skillDir, `icon${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }

  return null;
}

/**
 * Validate a skill folder
 * @param workspaceRoot - Absolute path to workspace root folder
 * @param slug - Skill directory name
 */
export function validateSkill(workspaceRoot: string, slug: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');
  const file = `.pi/skills/${slug}/SKILL.md`;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. Check directory exists (slug format is validated by validateSkillContent below)
  if (!existsSync(skillDir)) {
    return {
      valid: false,
      errors: [{
        file: `.pi/skills/${slug}`,
        path: '',
        message: `Skill folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 3. Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'SKILL.md not found',
        severity: 'error',
        suggestion: 'Create a SKILL.md file with YAML frontmatter',
      }],
      warnings: [],
    };
  }

  // 4. Read and validate content using content-based validator
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Delegate content validation (frontmatter schema + body non-empty + slug format)
  const contentResult = validateSkillContent(content, slug);
  errors.push(...contentResult.errors);

  // 5. FS-only checks: icon existence (warnings)
  const iconPath = findSkillIconForValidation(skillDir);
  if (iconPath) {
    const ext = extname(iconPath).toLowerCase();
    if (!['.svg', '.png', '.jpg', '.jpeg'].includes(ext)) {
      warnings.push({
        file: `.pi/skills/${slug}/${basename(iconPath)}`,
        path: '',
        message: `Unexpected icon format: ${ext}`,
        severity: 'warning',
        suggestion: 'Use .svg, .png, or .jpg for icons',
      });
    }
  } else {
    const searchTerm = slug.replace(/-/g, ' ');
    warnings.push({
      file: `.pi/skills/${slug}/`,
      path: 'icon',
      message: 'No icon found',
      severity: 'warning',
      suggestion: `Search for '${searchTerm} icon' on heroicons.com, lucide.dev, or icons8.com. Save as icon.svg in the skill folder.`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate skill SKILL.md content from a string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks frontmatter schema and non-empty body. Skips icon/folder checks.
 *
 * @param markdownContent - The full SKILL.md file content
 * @param slug - The skill slug (folder name), used for slug format validation
 */
export function validateSkillContent(markdownContent: string, slug: string): ValidationResult {
  const file = `.pi/skills/${slug}/SKILL.md`;
  const errors: ValidationIssue[] = [];

  // 1. Validate slug format
  if (!SLUG_REGEX.test(slug)) {
    const suggestedSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    errors.push({
      file: `.pi/skills/${slug}`,
      path: 'slug',
      message: 'Slug must be lowercase alphanumeric with hyphens',
      severity: 'error',
      suggestion: `Rename folder to '${suggestedSlug || 'valid-slug-name'}'`,
    });
  }

  // 2. Parse frontmatter
  let frontmatter: unknown;
  let body: string;
  try {
    const parsed = matter(markdownContent);
    frontmatter = parsed.data;
    body = parsed.content;
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: 'frontmatter',
        message: `Invalid YAML frontmatter: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
        suggestion: 'See ~/.mortise/docs/skills.md for SKILL.md format reference',
      }],
      warnings: [],
    };
  }

  // 3. Validate frontmatter schema
  const metaResult = SkillMetadataSchema.safeParse(frontmatter);
  if (!metaResult.success) {
    errors.push(...zodErrorToIssues(metaResult.error, file));
  }

  // 4. Check content is not empty
  if (!body || body.trim().length === 0) {
    errors.push({
      file,
      path: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      severity: 'error',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],  // Icon/folder warnings skipped in content-only validation
  };
}

/**
 * Validate all skills in a workspace
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateAllSkills(workspaceRoot: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(skillsDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: '.pi/skills/',
        path: '',
        message: 'Skills directory does not exist (no skills configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(skillsDir);
  const skillFolders = entries.filter((entry) => {
    const entryPath = join(skillsDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (skillFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: '.pi/skills/',
        path: '',
        message: 'No skills configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of skillFolders) {
    const result = validateSkill(workspaceRoot, folder);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Permissions Validators
// ============================================================

import { PermissionsConfigSchema } from '../agent/mode-types.ts';
import {
  validatePermissionsConfig,
  getWorkspacePermissionsPath,
  getAppPermissionsDir,
} from '../agent/permissions-config.ts';
import { validateAutomationsContent, validateAutomations, AUTOMATIONS_CONFIG_FILE } from '../automations/index.ts';

/**
 * Internal: Validate a single permissions.json file
 * Checks JSON syntax, Zod schema, and regex pattern validity.
 */
function validatePermissionsFile(filePath: string, displayFile: string): ValidationResult {
  // File is optional - missing is just a warning
  if (!existsSync(filePath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: displayFile,
        path: '',
        message: 'Permissions file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content-based validator
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validatePermissionsContent(raw, displayFile);
}

/**
 * Validate permissions config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Runs Zod schema validation and regex pattern compilation checks.
 *
 * @param jsonString - The raw JSON content of the permissions file
 * @param displayFile - File name for error messages
 */
export function validatePermissionsContent(jsonString: string, displayFile: string = 'permissions.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = PermissionsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  // Validate regex patterns (semantic validation)
  const regexErrors = validatePermissionsConfig(result.data);
  for (const regexError of regexErrors) {
    errors.push({
      file: displayFile,
      path: regexError.split(':')[0] || '',
      message: regexError,
      severity: 'error',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * Validate workspace-level permissions.json
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateWorkspacePermissions(workspaceRoot: string): ValidationResult {
  const permissionsPath = getWorkspacePermissionsPath(workspaceRoot);
  return validatePermissionsFile(permissionsPath, 'permissions.json');
}

/**
 * Validate app-level default permissions
 */
export function validateDefaultPermissions(): ValidationResult {
  const permissionsPath = join(getAppPermissionsDir(), 'default.json');
  return validatePermissionsFile(permissionsPath, 'permissions/default.json');
}

/**
 * Validate all permissions files in a workspace
 * Includes app-level default and workspace-level permissions.
 */
export function validateAllPermissions(workspaceRoot: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Validate app-level default permissions
  const defaultResult = validateDefaultPermissions();
  errors.push(...defaultResult.errors);
  warnings.push(...defaultResult.warnings);

  // Validate workspace-level permissions
  const wsResult = validateWorkspacePermissions(workspaceRoot);
  errors.push(...wsResult.errors);
  warnings.push(...wsResult.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check if a permissions file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidPermissionsFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validatePermissionsContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Theme Validators
// ============================================================

const CSSColorSchema = z.string().min(1);

const ThemeDarkOverrideSchema = z.object({
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
}).strict();

/**
 * Zod schema for app-level theme override files (~/.mortise/theme.json).
 * Allows partial overrides but rejects unknown keys.
 */
export const ThemeOverrideSchema = z.object({
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: ThemeDarkOverrideSchema.optional(),
}).strict()
  .refine(
    (data) => {
      const keys = Object.keys(data);
      return keys.length > 0;
    },
    { message: 'Theme override must include at least one supported field' }
  )
  .refine(
    (data) => data.mode !== 'scenic' || Boolean(data.backgroundImage),
    { message: 'backgroundImage is required when mode is scenic', path: ['backgroundImage'] }
  );

/**
 * Zod schema for preset theme files.
 * Validates theme structure and requires at least one color property.
 */
export const PresetThemeSchema = z.object({
  name: z.string().min(1, 'Theme name is required'),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  source: z.string().optional(),
  supportedModes: z.array(z.enum(['light', 'dark'])).optional(),
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: z.object({}).passthrough().optional(),
  // Shiki theme for syntax highlighting
  shikiTheme: z.object({
    light: z.string().optional(),
    dark: z.string().optional(),
  }).optional(),
}).refine(
  (data) => {
    const colorProps = ['background', 'foreground', 'accent', 'info', 'success', 'destructive'];
    return colorProps.some(prop => prop in data);
  },
  { message: 'Theme must have at least one color property (background, foreground, accent, info, success, or destructive)' }
);

/**
 * Validate theme content from a JSON string (no disk reads).
 * Used to check if an existing theme file is valid before deciding to overwrite.
 */
export function validateThemeContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = PresetThemeSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * Validate app-level theme override content from a JSON string (no disk reads).
 * Unlike preset validation, this accepts partial ThemeOverrides objects and rejects unknown keys.
 */
export function validateThemeOverrideContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = ThemeOverrideSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}

/**
 * Check if a theme file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidThemeFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validateThemeContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Tool Icons Validators
// ============================================================

import { getToolIconsDir } from './storage.ts';

/**
 * Zod schema for a single tool icon entry in tool-icons.json.
 * Each entry maps CLI commands to an icon file.
 */
const ToolIconEntrySchema = z.object({
  id: z.string().min(1, 'Tool ID is required').regex(
    /^[a-z0-9-]+$/,
    'ID must be lowercase alphanumeric with hyphens (e.g., "my-tool")'
  ),
  displayName: z.string().min(1, 'Display name is required'),
  icon: z.string().min(1, 'Icon filename is required'),
  commands: z.array(z.string().min(1)).min(1, 'At least one command is required'),
});

/**
 * Zod schema for the full tool-icons.json config.
 * Contains a version number and array of tool icon mappings.
 */
const ToolIconsConfigSchema = z.object({
  version: z.number().int().min(1, 'Version must be a positive integer'),
  tools: z.array(ToolIconEntrySchema),
});

/**
 * Validate tool-icons config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks JSON syntax, Zod schema, duplicate IDs, and duplicate commands.
 */
export function validateToolIconsContent(jsonString: string): ValidationResult {
  const file = 'tool-icons/tool-icons.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate against Zod schema
  const result = ToolIconsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validation: check for duplicate tool IDs
  const seenIds = new Set<string>();
  for (const tool of config.tools) {
    if (seenIds.has(tool.id)) {
      errors.push({
        file,
        path: `tools[id=${tool.id}]`,
        message: `Duplicate tool ID '${tool.id}'`,
        severity: 'error',
        suggestion: 'Each tool must have a unique ID',
      });
    }
    seenIds.add(tool.id);
  }

  // Semantic validation: warn on duplicate commands across tools
  const seenCommands = new Map<string, string>();
  for (const tool of config.tools) {
    for (const cmd of tool.commands) {
      if (seenCommands.has(cmd)) {
        warnings.push({
          file,
          path: `tools[id=${tool.id}].commands`,
          message: `Command '${cmd}' is also mapped by tool '${seenCommands.get(cmd)}'`,
          severity: 'warning',
          suggestion: 'Commands should be unique across tools for unambiguous icon resolution',
        });
      } else {
        seenCommands.set(cmd, tool.id);
      }
    }
  }

  // Validate icon file extensions
  const validIconExtensions = new Set(['.png', '.ico', '.svg', '.jpg', '.jpeg']);
  for (const tool of config.tools) {
    const ext = tool.icon.includes('.') ? '.' + tool.icon.split('.').pop()!.toLowerCase() : '';
    if (!validIconExtensions.has(ext)) {
      warnings.push({
        file,
        path: `tools[id=${tool.id}].icon`,
        message: `Icon '${tool.icon}' has unrecognized extension '${ext}'`,
        severity: 'warning',
        suggestion: 'Supported formats: .png, .ico, .svg, .jpg',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate tool-icons/tool-icons.json from disk.
 * Reads the file, runs content validation, and also checks that referenced icon files exist.
 */
export function validateToolIcons(): ValidationResult {
  const toolIconsDir = getToolIconsDir();
  const configPath = join(toolIconsDir, 'tool-icons.json');
  const file = 'tool-icons/tool-icons.json';

  // File is optional — missing is just a warning
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Tool icons config does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content validator
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  const result = validateToolIconsContent(raw);

  // Filesystem-specific check: verify referenced icon files exist
  try {
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    if (parsed.tools && Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.icon) {
          const iconPath = join(toolIconsDir, tool.icon);
          if (!existsSync(iconPath)) {
            result.warnings.push({
              file: `tool-icons/${tool.icon}`,
              path: `tools[id=${tool.id}].icon`,
              message: `Icon file '${tool.icon}' not found in tool-icons directory`,
              severity: 'warning',
              suggestion: `Place '${tool.icon}' in ~/.mortise/tool-icons/`,
            });
          }
        }
      }
    }
  } catch {
    // JSON parse errors already reported by content validator
  }

  return result;
}

// ============================================================
// Formatting
// ============================================================

/**
 * Format validation result as text for agent response
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid && result.warnings.length === 0) {
    lines.push('All configuration files are valid.');
    return lines.join('\n');
  }

  if (result.valid) {
    lines.push('Configuration is valid with warnings:');
  } else {
    lines.push('Configuration has errors:');
  }

  lines.push('');

  // Errors first
  if (result.errors.length > 0) {
    lines.push('**Errors:**');
    for (const error of result.errors) {
      lines.push(`- \`${error.file}\` at \`${error.path}\`: ${error.message}`);
      if (error.suggestion) {
        lines.push(`  → ${error.suggestion}`);
      }
    }
    lines.push('');
  }

  // Then warnings
  if (result.warnings.length > 0) {
    lines.push('**Warnings:**');
    for (const warning of result.warnings) {
      lines.push(`- \`${warning.file}\` at \`${warning.path}\`: ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`  → ${warning.suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================
// PreToolUse Content Validation
// ============================================================
// These utilities are used by the PreToolUse hook to detect config files
// being written and validate their content before it reaches disk.

/**
 * Result of detecting what type of config file a path corresponds to.
 */
export interface ConfigFileDetection {
  type: 'skill' | 'permissions' | 'tool-icons' | 'automations';
  /** Slug of the skill (if applicable) */
  slug?: string;
  /** Display file path for error messages */
  displayFile: string;
}

/**
 * Detect if a file path corresponds to a known config file type within a workspace.
 * Returns null if the path is not a recognized config file.
 *
 * Matches patterns:
 * - .../.pi/skills/{slug}/SKILL.md → skill definition
 * - .../permissions.json → permission rules
 */
export function detectConfigFileType(filePath: string, workspaceRootPath: string): ConfigFileDetection | null {
  // Normalize to consistent forward slashes and ensure root ends with /
  // so startsWith doesn't false-match on path prefixes (e.g., /workspace vs /workspacefoo)
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only validate files within the workspace root
  if (!normalizedPath.startsWith(normalizedRoot)) {
    return null;
  }

  // Get the relative path from workspace root (no leading slash since root ends with /)
  const relativePath = normalizedPath.slice(normalizedRoot.length);

  // Match: .pi/skills/{slug}/SKILL.md
  const skillMatch = relativePath.match(/^\.pi\/skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch) {
    return { type: 'skill', slug: skillMatch[1], displayFile: `.pi/skills/${skillMatch[1]}/SKILL.md` };
  }

  // Match: automations config file
  if (relativePath === AUTOMATIONS_CONFIG_FILE) {
    return { type: 'automations', displayFile: relativePath };
  }

  // Match: permissions.json (workspace-level)
  if (relativePath === 'permissions.json') {
    return { type: 'permissions', displayFile: 'permissions.json' };
  }

  return null;
}

/**
 * Detect if a file path corresponds to an app-level config file (outside workspace scope).
 * Checks paths relative to CONFIG_DIR (~/.mortise/).
 * Returns null if the path is not a recognized app-level config file.
 *
 * Matches patterns:
 * - ~/.mortise/tool-icons/tool-icons.json → tool icon mappings
 */
export function detectAppConfigFileType(filePath: string): ConfigFileDetection | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedConfigDir = CONFIG_DIR.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only check files within CONFIG_DIR
  if (!normalizedPath.startsWith(normalizedConfigDir)) {
    return null;
  }

  const relativePath = normalizedPath.slice(normalizedConfigDir.length);

  // Match: tool-icons/tool-icons.json
  if (relativePath === 'tool-icons/tool-icons.json') {
    return { type: 'tool-icons', displayFile: 'tool-icons/tool-icons.json' };
  }

  return null;
}

/**
 * Validate config file content based on its detected type.
 * Dispatches to the appropriate content-based validator.
 * Returns null if the detection type is unrecognized.
 */
export function validateConfigFileContent(
  detection: ConfigFileDetection,
  content: string
): ValidationResult | null {
  switch (detection.type) {
    case 'skill':
      return validateSkillContent(content, detection.slug || 'unknown');
    case 'automations':
      return validateAutomationsContent(content, detection.displayFile);
    case 'permissions':
      return validatePermissionsContent(content, detection.displayFile);
    case 'tool-icons':
      return validateToolIconsContent(content);
    default:
      return null;
  }
}

# Skills Configuration Guide

This guide explains how to create and configure skills in Mortise Agent.

## What Are Skills?

Skills are specialized instructions that extend Claude's capabilities for specific tasks. They use a **standard SKILL.md format** with `name`/`description` frontmatter.

**Key points:**
- Skills are invoked via `/skill:<name>` slash commands (command name `skill:<name>`)
- Skills are discovered by the model through the system prompt and read on demand; `disable-model-invocation` turns off model-side discovery while keeping the user-side `/skill:` entry
- The SKILL.md format matches the standard SKILL.md skill format (name/description frontmatter)
## Same Format as Claude Code SDK

Mortise Agent uses **a standard SKILL.md format** with `name`/`description`/optional `disable-model-invocation` frontmatter. This means:

1. **Format compatibility**: skills follow the standard SKILL.md frontmatter format (name/description)
2. **Core frontmatter fields**: `name`, `description`, optional `disable-model-invocation`
3. **Same content structure**: Markdown body with instructions for Claude

**What Mortise Agent adds:**
- **Visual icons**: Display custom icons in the UI for each skill
- **Workspace organization**: Skills are scoped to workspaces
- **UI management**: Browse, edit, and validate skills through the interface

## Skill Precedence

When a skill is invoked (e.g., `/skill:commit`):

1. **Project skill checked first** - If `{projectRoot}/.mortise/skills/commit/SKILL.md` exists, it's used
2. **Global Mortise skill as fallback** - Otherwise `~/.mortise/agent/skills/commit/SKILL.md` is checked

This allows you to:
- **Override global skills** - Create a project skill with the same slug to replace global behavior
- **Extend global skills** - Reference global behavior in your custom skill and add project-specific instructions
- **Create new skills** - Add entirely new skills

## Skill Storage

Skills are stored as folders:
```
{projectRoot}/.mortise/skills/{slug}/
├── SKILL.md          # Required: Skill definition (standard SKILL.md format)
├── icon.svg          # Recommended: Skill icon for UI display
├── icon.png          # Alternative: PNG icon
└── (other files)     # Optional: Additional resources
```

## SKILL.md Format

The format is:

```yaml
---
name: "Skill Display Name"
description: "Brief description shown in skill list"
globs: ["*.ts", "*.tsx"]     # Optional: retained as metadata only (does not auto-trigger)
---

# Skill Instructions

Your skill content goes here. This is injected into Claude's context
when the skill is active.

## Guidelines

- Specific instructions for Claude
- Best practices to follow
- Things to avoid

## Examples

Show Claude how to perform the task correctly.
```

## Metadata Fields

### name (required)
Display name for the skill. Shown in the UI and skill list.

### description (required)
Brief description (1-2 sentences) explaining what the skill does.

### globs (optional)
Array of glob patterns. When a file matching these patterns is being worked on,
the pattern is retained as metadata only; it does not automatically trigger the skill.

```yaml
globs:
  - "*.test.ts"           # Test files
  - "*.spec.tsx"          # React test files
  - "**/__tests__/**"     # Test directories
```

## Creating a Skill

### 1. Create the skill directory

```bash
mkdir -p {projectRoot}/.mortise/skills/my-skill
```

### 2. Write SKILL.md

```markdown
---
name: "Code Review"
description: "Review code changes for quality, security, and best practices"
globs: ["*.ts", "*.tsx", "*.js", "*.jsx"]
---

# Code Review Skill

When reviewing code, focus on:

## Quality Checks
- Consistent code style
- Clear naming conventions
- Appropriate abstractions

## Security Checks
- Input validation
- Authentication/authorization
- Sensitive data handling

## Best Practices
- Error handling
- Performance considerations
- Test coverage
```

### 3. Add an icon (IMPORTANT)

Every skill should have a visually relevant icon. This helps users quickly identify skills in the UI.

**Icon requirements:**
- **Filename**: Must be `icon.svg`, `icon.png`, `icon.jpg`, `icon.jpeg`, or `icon.webp`
- **Format**: SVG preferred (scalable, crisp at all sizes)
- **Size**: For PNG/JPG, use at least 64x64 pixels

**How to get an icon:**

1. **Search online icon libraries:**
   - [Heroicons](https://heroicons.com/) - MIT licensed
   - [Feather Icons](https://feathericons.com/) - MIT licensed
   - [Simple Icons](https://simpleicons.org/) - Brand icons (git, npm, etc.)

2. **Use WebFetch to download:**
   ```
   # Find an appropriate icon URL and download it
   WebFetch to get SVG content, then save to icon.svg
   ```

3. **Match the skill's purpose:**
   - Git/commit skill → git icon or commit icon
   - Test skill → checkmark or test tube icon
   - Deploy skill → rocket or cloud icon
   - Review skill → magnifying glass or eye icon

### 4. Validate the skill

**IMPORTANT**: Always validate after creating or editing a skill:

Check that:
- Slug format is lowercase, alphanumeric, with hyphens only
- SKILL.md exists and is readable
- YAML frontmatter is valid
- Required fields are present (name, description)
- Content is non-empty
- Icon format is supported (if present)

## Example Skills

### Commit Message Skill

```yaml
---
name: "Commit"
description: "Create well-formatted git commit messages"
---

# Commit Message Guidelines

When creating commits:

1. **Format**: Use conventional commits
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation
   - `refactor:` Code refactoring
   - `test:` Adding tests

2. **Style**:
   - Keep subject line under 72 characters
   - Use imperative mood ("Add feature" not "Added feature")
   - Explain why, not what (the diff shows what)

3. **Co-authorship**:
   Always include: `Co-Authored-By: Claude <noreply@anthropic.com>`
```

**Recommended icon**: Git commit icon from Heroicons or Simple Icons

### Team Standards Skill

```yaml
---
name: "Team Standards"
description: "Enforce team coding conventions and patterns"
globs: ["src/**/*.ts", "src/**/*.tsx"]
---

# Team Coding Standards

## File Organization
- One component per file
- Co-locate tests with source files
- Use barrel exports (index.ts)

## Naming Conventions
- Components: PascalCase
- Hooks: camelCase with `use` prefix
- Constants: SCREAMING_SNAKE_CASE

## Import Order
1. External packages
2. Internal packages (@company/*)
3. Relative imports
```

**Recommended icon**: Clipboard list or checklist icon

## Overriding Global Skills

To customize a global skill like `/skill:commit`:

1. Create `{projectRoot}/.mortise/skills/commit/SKILL.md`
2. Write your custom instructions
3. Add an icon

Your project skill will be used instead of the global version.

This is useful for:
- Adding team-specific commit message formats
- Enforcing project-specific coding standards
- Customizing review criteria for your codebase

## Best Practices

1. **Be specific**: Give Claude clear, actionable instructions
2. **Include examples**: Show the expected output format
3. **Set boundaries**: Explain what NOT to do
4. **Keep focused**: One skill = one specific task or domain
5. **Add a relevant icon**: Makes skills easily identifiable in the UI
6. **Always validate**: Check slug format, frontmatter, and required fields after creating or editing

## Troubleshooting

**Skill not loading:**
- Check slug format (lowercase, alphanumeric, hyphens only)
- Verify SKILL.md exists and is readable
- Verify YAML frontmatter is valid and required fields (name, description) are present

**Skill not triggering:**
- Skills are not auto-triggered by file globs. Invoke them explicitly with `/skill:<name>` or let the model read them on demand.
- Verify the skill is in the correct workspace or global scope.

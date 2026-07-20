# Mortise Agent CLI Guide

`mortise` is the preferred interface for managing workspace config domains such as labels, skills, and automations.

## Usage

```bash
mortise <entity> <action> [args] [--flags] [--json '<json>'] [--stdin]
```

### Global flags
- `mortise --help`
- `mortise --version`
- `mortise --discover`

### Input modes
- Flat flags for simple values
- `--json` for structured inputs
- `--stdin` for piped JSON object input

---

<!-- cli:label:start -->
## Label

Manage workspace labels stored under `labels/`.

### Commands
- `mortise label list`
- `mortise label get <id>`
- `mortise label create --name "<name>" [--color "<color>"] [--parent-id <id|root>] [--value-type string|number|date]`
- `mortise label update <id> [--name "<name>"] [--color "<color>"] [--value-type string|number|date|none] [--clear-value-type]`
- `mortise label delete <id>`
- `mortise label move <id> --parent <id|root>`
- `mortise label reorder [--parent <id|root>] <ordered-id-1> <ordered-id-2> ...`
- `mortise label auto-rule-list <id>`
- `mortise label auto-rule-add <id> --pattern "<regex>" [--flags "gi"] [--value-template "$1"] [--description "..."]`
- `mortise label auto-rule-remove <id> --index <n>`
- `mortise label auto-rule-clear <id>`
- `mortise label auto-rule-validate <id>`

### Examples

```bash
mortise label list
mortise label get bug
mortise label create --name "Bug" --color "accent"
mortise label create --name "Priority" --value-type number
mortise label update bug --json '{"name":"Bug Report","color":"destructive"}'
mortise label update priority --value-type none
mortise label move bug --parent root
mortise label reorder --parent root development content bug
mortise label auto-rule-add linear-issue --pattern "\\b([A-Z]{2,5}-\\d+)\\b" --value-template "$1"
mortise label auto-rule-list linear-issue
mortise label auto-rule-validate linear-issue
```

### Notes
- Use `--json` / `--stdin` for nested or bulk updates.
- IDs are stable slugs generated from name on create.
- Use `--value-type none` or `--clear-value-type` to remove a label value type.
<!-- cli:label:end -->

---


---

<!-- cli:skill:start -->
## Skill

Manage project skills stored under `.pi/skills/{slug}/SKILL.md`.

### Commands
- `mortise skill list [--workspace-only] [--project-root <path>]`
- `mortise skill get <slug> [--project-root <path>]`
- `mortise skill where <slug> [--project-root <path>]`
- `mortise skill create` (see flags below)
- `mortise skill update <slug> --json '{...}' [--project-root <path>]`
- `mortise skill delete <slug>`
- `mortise skill validate <slug> [--source workspace|project|global] [--project-root <path>]`

### Flags for `skill create`

| Flag | Description |
|------|-------------|
| `--name "<name>"` | **(required)** Skill display name |
| `--description "<desc>"` | **(required)** Brief description (1-2 sentences) |
| `--slug "<slug>"` | Custom slug (auto-generated from name if omitted) |
| `--body "..."` | Skill content/instructions (markdown body) |
| `--icon "<url>"` | Icon URL (auto-downloaded to `icon.*`) |
| `--globs "*.ts,*.tsx"` | Comma-separated glob patterns for auto-suggestion |
| `--always-allow "Bash,Write"` | Comma-separated tool names to always allow |

### Examples

```bash
mortise skill list
mortise skill list --workspace-only
mortise skill where commit-helper
mortise skill create --name "Commit Helper" --description "Generate conventional commits" --slug commit-helper
mortise skill create --name "Code Review" --description "Review PRs" --globs "*.ts,*.tsx" --always-allow "Bash"
mortise skill update commit-helper --json '{"body":"Use concise, imperative commit messages."}'
mortise skill validate commit-helper
mortise skill validate commit-helper --source global
mortise skill delete commit-helper
```

### Notes
- `create` / `update` write `SKILL.md` frontmatter and content body.
- Use `where` to inspect project/workspace/global resolution precedence.
- `--project-root` scopes resolution to a project directory (defaults to cwd).
<!-- cli:skill:end -->

---

<!-- cli:automation:start -->
## Automation

Manage canonical workspace automations through a running Mortise host. The CLI
does not edit workspace files or run a separate scheduler.

### Commands
- `mortise-cli automation describe`
- `mortise-cli automation list`
- `mortise-cli automation get <id>`
- `mortise-cli automation validate <json|@file>`
- `mortise-cli automation create <json|@file> [--expected-revision <n|null>]`
- `mortise-cli automation update <json|@file> --expected-revision <n>`
- `mortise-cli automation delete <id> --expected-revision <n>`
- `mortise-cli automation set-enabled <id> <true|false> --expected-revision <n>`
- `mortise-cli automation run <id> [--trigger-id <id>]`
- `mortise-cli automation get-run <run-id>`
- `mortise-cli automation list-runs [--automation-id <id>] [--limit <n>]`
- `mortise-cli automation emit-event <json|@file>`
- `mortise-cli automation token path|rotate`

### Examples

```bash
mortise-cli --workspace ws-1 automation list
mortise-cli --workspace ws-1 automation create @automation.json --expected-revision null
mortise-cli --workspace ws-1 automation update @automation.json --expected-revision 3
mortise-cli --workspace ws-1 automation emit-event @event.json
mortise-cli --workspace ws-1 automation token path
```

### Notes
- Definition JSON uses protocol document version 3. Event, cron, once, and interval triggers share one definition format.
- Prompt and outbound webhook actions share the same run ledger and history.
- External input uses the loopback CloudEvents endpoint. `token path` exposes only the owner-only file path, not the token. The default local producer token accepts sources under `urn:mortise:external:` and event types under `mortise.`.
<!-- cli:automation:end -->

---

<!-- cli:permission:start -->
## Permission

Manage workspace Explore mode permissions stored in `permissions.json`.

### Commands
- `mortise permission list`
- `mortise permission get`
- `mortise permission set --json '{...}'`
- `mortise permission add-mcp-pattern "<pattern>" [--comment "..."]`
- `mortise permission add-bash-pattern "<pattern>" [--comment "..."]`
- `mortise permission add-write-path "<glob>"`
- `mortise permission remove <index> --type mcp|api|bash|write-path|blocked`
- `mortise permission validate`
- `mortise permission reset`

### Scope

Commands operate on the workspace-level `permissions.json`.

### Examples

```bash
# Read workspace permissions
mortise permission list
# Get workspace permissions
mortise permission get
# Add read-only MCP patterns
mortise permission add-mcp-pattern "list" --comment "List operations"
mortise permission add-mcp-pattern "get" --comment "Get operations"
mortise permission add-mcp-pattern "search" --comment "Search operations"
# Add bash patterns
mortise permission add-bash-pattern "^ls\\s" --comment "Allow ls"
# Add write path globs
mortise permission add-write-path "/tmp/**"
# Remove a rule by index and type
mortise permission remove 1 --type mcp
# Replace entire config
mortise permission set --json '{"allowedMcpPatterns":[{"pattern":"list","comment":"List ops"}]}'
# Validate all permissions
mortise permission validate
# Delete permissions file (revert to defaults)
mortise permission reset
```

### Notes
- `remove` uses 0-based index within the specified rule type array. Use `get` to see indices.
- `validate` runs schema and regex validation for workspace permissions.
- `reset` deletes the permissions file, reverting to defaults.
<!-- cli:permission:end -->

---

<!-- cli:theme:start -->
## Theme

Manage app-level and workspace-level theme settings.

### Commands
- `mortise theme get`
- `mortise theme validate [--preset <id>]`
- `mortise theme list-presets`
- `mortise theme get-preset <id>`
- `mortise theme set-color-theme <id>`
- `mortise theme set-workspace-color-theme <id|default>`
- `mortise theme set-override --json '{...}'`
- `mortise theme reset-override`

### Examples

```bash
# Inspect current theme state
mortise theme get

# Validate app override file
mortise theme validate

# Validate one preset file
mortise theme validate --preset nord

# List available presets
mortise theme list-presets

# Inspect a specific preset
mortise theme get-preset dracula

# Set app default preset
mortise theme set-color-theme nord

# Set workspace override
mortise theme set-workspace-color-theme dracula

# Clear workspace override (inherit app default)
mortise theme set-workspace-color-theme default

# Replace app-level theme.json override
mortise theme set-override --json '{"accent":"oklch(0.62 0.21 293)","dark":{"accent":"oklch(0.68 0.21 293)"}}'

# Remove app-level override file
mortise theme reset-override
```

### Notes
- `set-color-theme` and `set-workspace-color-theme` require an existing preset ID (`default` is always valid).
- `set-override` validates `theme.json` shape before writing.
- Workspace override is stored in `workspace/config.json` under `defaults.colorTheme`.
- App override is stored in `~/.mortise/theme.json`.
<!-- cli:theme:end -->

---

## Output contract

All commands return a single JSON envelope on stdout.

### Success
```json
{ "ok": true, "data": {}, "warnings": [] }
```

### Error
```json
{
  "ok": false,
  "error": {
    "code": "USAGE_ERROR",
    "message": "...",
    "suggestion": "..."
  },
  "warnings": []
}
```

Exit codes:
- `0` success
- `1` execution/internal failure
- `2` usage/validation/input failure

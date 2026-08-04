const STATE_ENTRY_TYPE = "mortise.permissions.mode";
const CONTRIBUTION_ID = "mortise.permissions.selector";
const ASK_COMMAND = "mortise-permissions-ask";
const ALLOW_ALL_COMMAND = "mortise-permissions-allow-all";
const DEFAULT_MODE = "allow-all";

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_fetch",
  "get_session_info",
  "list_sessions",
  "list_messaging_channels",
]);

function parseMode(value) {
  return value === "ask" || value === "allow-all" ? value : undefined;
}

function normalizeMode(value) {
  return parseMode(value) ?? "ask";
}

function restoreMode(sessionManager, configuredMode) {
  const entries = sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      return normalizeMode(entry.data?.mode);
    }
  }

  const configured = parseMode(configuredMode);
  if (configured) return configured;

  const header = sessionManager.getHeader();
  const legacyMode = header?.mortise?.permissionMode ?? header?.spawnConfig?.permissionMode;
  return legacyMode === undefined ? DEFAULT_MODE : normalizeMode(legacyMode);
}

function describeToolCall(event) {
  const input = event.input ?? {};
  if ((event.toolName === "bash" || event.toolName === "pwsh") && typeof input.command === "string") {
    return input.command.slice(0, 1200);
  }

  const path = input.path ?? input.file_path ?? input.notebook_path;
  if (typeof path === "string") return `${event.toolName}: ${path}`;

  let details = "";
  try {
    details = JSON.stringify(input);
  } catch {
    details = "";
  }
  return details ? `${event.toolName}: ${details.slice(0, 1200)}` : event.toolName;
}

function publish(ui, mode) {
  if (!ui.capabilities.contributions) return;
  ui.upsertContribution({
    schemaVersion: 1,
    id: CONTRIBUTION_ID,
    surface: "composer.toolbar",
    priority: 100,
    collapse: "never",
    overflow: "menu",
    content: {
      type: "menu",
      label: mode === "ask" ? "Ask" : "Execute",
      icon: mode === "ask" ? "info" : "repeat",
      tone: mode === "ask" ? "info" : "accent",
      options: [
        {
          id: "ask",
          label: "Ask",
          description: "Prompts before making edits.",
          icon: "info",
          tone: "info",
          action: { kind: "command", command: ASK_COMMAND },
          selected: mode === "ask",
        },
        {
          id: "allow-all",
          label: "Execute",
          description: "Automatic execution, no prompts.",
          icon: "repeat",
          tone: "accent",
          action: { kind: "command", command: ALLOW_ALL_COMMAND },
          selected: mode === "allow-all",
        },
      ],
    },
  });
}

export default function permissionsExtension(pi) {
  let mode = "ask";

  const setMode = (nextMode, ctx, persist = true) => {
    mode = normalizeMode(nextMode);
    if (persist) pi.appendEntry(STATE_ENTRY_TYPE, { mode });
    publish(ctx.ui, mode);
  };

  pi.on("session_start", (_event, ctx) => {
    setMode(restoreMode(ctx.sessionManager, pi.environment.config.mode), ctx, false);
  });

  pi.registerCommand(ASK_COMMAND, {
    description: "Ask before tools that can change state",
    async handler(_args, ctx) {
      setMode("ask", ctx);
    },
  });

  pi.registerCommand(ALLOW_ALL_COMMAND, {
    description: "Approve all tool calls without prompting",
    async handler(_args, ctx) {
      setMode("allow-all", ctx);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "allow-all" || READ_ONLY_TOOLS.has(event.toolName)) return;
    if (!ctx.ui.capabilities.dialogs) {
      return { block: true, reason: "Tool approval requires an interactive Mortise client." };
    }

    const allowed = await ctx.ui.confirm(
      "Approve tool call",
      describeToolCall(event),
    );
    if (!allowed) return { block: true, reason: "Tool call denied by user." };
  });
}

export const permissionsExtensionInternals = {
  STATE_ENTRY_TYPE,
  DEFAULT_MODE,
  READ_ONLY_TOOLS,
  parseMode,
  normalizeMode,
  restoreMode,
  describeToolCall,
};

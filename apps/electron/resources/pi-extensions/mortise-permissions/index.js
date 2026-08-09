const STATE_ENTRY_TYPE = "mortise.permissions.mode";
const MODE_CHANNEL = "permission-mode";
const APPROVAL_CHANNEL = "permission-approval";
const DEFAULT_MODE = "allow-all";
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "web_fetch",
  "webfetch",
  "web_search",
  "websearch",
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
  const extensionMode = header?.spawnConfig?.extensionBootstrap?.["mortise-permissions"]?.[MODE_CHANNEL]?.mode;
  if (extensionMode !== undefined) return normalizeMode(extensionMode);
  const legacyMode = header?.mortise?.permissionMode ?? header?.spawnConfig?.permissionMode;
  return legacyMode === undefined ? DEFAULT_MODE : normalizeMode(legacyMode);
}

function normalizedToolName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function describeToolCall(event) {
  const input = event.input ?? {};
  const toolName = normalizedToolName(event.toolName);
  if ((toolName === "bash" || toolName === "pwsh") && typeof input.command === "string") {
    return input.command.slice(0, 1200);
  }
  const path = input.path ?? input.file_path ?? input.notebook_path;
  if (typeof path === "string") return `${event.toolName}: ${path}`;
  let details = "";
  try { details = JSON.stringify(input); } catch { details = ""; }
  return details ? `${event.toolName}: ${details.slice(0, 1200)}` : event.toolName;
}

function createApprovalRequest(event) {
  const input = event.input ?? {};
  const description = describeToolCall(event);
  return {
    requestId: crypto.randomUUID(),
    type: input.permissionType === "admin_approval" ? "admin_approval" : "permission",
    toolName: event.toolName,
    description,
    ...(typeof input.command === "string" ? { command: input.command.slice(0, 4000) } : {}),
    ...(typeof input.appName === "string" ? { appName: input.appName } : {}),
    ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
    ...(typeof input.impact === "string" ? { impact: input.impact } : {}),
    ...(typeof input.requiresSystemPrompt === "boolean" ? { requiresSystemPrompt: input.requiresSystemPrompt } : {}),
    rememberForMinutes: typeof input.rememberForMinutes === "number" ? input.rememberForMinutes : 10,
    signature: `${normalizedToolName(event.toolName)}:${description}`,
  };
}

export default function permissionsExtension(pi) {
  let mode = "ask";
  let lastContext;
  const pending = [];
  const remembered = new Map();

  const publishMode = (ctx = lastContext) => {
    if (ctx) ctx.ui.publishFrontendState(MODE_CHANNEL, { mode });
  };

  const publishApproval = (ctx = lastContext) => {
    if (!ctx) return;
    ctx.ui.publishFrontendState(APPROVAL_CHANNEL, {
      request: pending[0]?.request ?? null,
      queueLength: pending.length,
    });
  };

  const setMode = (nextMode, ctx, persist = true) => {
    lastContext = ctx;
    mode = normalizeMode(nextMode);
    if (persist) pi.appendEntry(STATE_ENTRY_TYPE, { mode });
    publishMode(ctx);
  };

  const settle = (requestId, allowed) => {
    const index = pending.findIndex(item => item.request.requestId === requestId);
    if (index < 0) return false;
    const [item] = pending.splice(index, 1);
    clearTimeout(item.timeout);
    item.resolve(allowed);
    publishApproval();
    return true;
  };

  const cancelAll = () => {
    const waiting = pending.splice(0);
    for (const item of waiting) {
      clearTimeout(item.timeout);
      item.resolve(false);
    }
    publishApproval();
  };

  pi.registerFrontendChannel(MODE_CHANNEL, {
    scope: "session",
    snapshot: { mode: "ask" },
    sessionBootstrap: true,
    onMessage(message, ctx) {
      if (message && typeof message === "object" && "mode" in message) {
        setMode(message.mode, ctx);
      } else {
        lastContext = ctx;
        publishMode(ctx);
      }
      return { mode };
    },
  });

  pi.registerFrontendChannel(APPROVAL_CHANNEL, {
    scope: "session",
    snapshot: { request: null, queueLength: 0 },
    onMessage(message, ctx) {
      lastContext = ctx;
      if (!message || typeof message !== "object" || message.type !== "respond" || typeof message.requestId !== "string") {
        return { accepted: false };
      }
      const item = pending.find(candidate => candidate.request.requestId === message.requestId);
      if (!item) return { accepted: false };
      const allowed = message.allowed === true;
      if (allowed && message.alwaysAllow === true) {
        remembered.set(item.request.signature, Number.POSITIVE_INFINITY);
      } else if (allowed && typeof message.rememberForMinutes === "number") {
        const minutes = Math.min(Math.max(Math.floor(message.rememberForMinutes), 1), 60);
        remembered.set(item.request.signature, Date.now() + minutes * 60_000);
      }
      return { accepted: settle(message.requestId, allowed) };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    setMode(restoreMode(ctx.sessionManager, pi.environment.config.mode), ctx, false);
    publishApproval(ctx);
  });

  pi.registerCommand("mortise-permissions-ask", {
    description: "Ask before tools that can change state",
    async handler(_args, ctx) { setMode("ask", ctx); },
  });

  pi.registerCommand("mortise-permissions-allow-all", {
    description: "Approve all tool calls without prompting",
    async handler(_args, ctx) { setMode("allow-all", ctx); },
  });

  pi.on("tool_call", async (event, ctx) => {
    lastContext = ctx;
    if (mode === "allow-all" || READ_ONLY_TOOLS.has(normalizedToolName(event.toolName))) return;
    if (!ctx.ui.capabilities.contributions) {
      return { block: true, reason: "Tool approval requires an interactive Mortise client." };
    }

    const request = createApprovalRequest(event);
    const rememberedUntil = remembered.get(request.signature);
    if (rememberedUntil === Number.POSITIVE_INFINITY || (typeof rememberedUntil === "number" && rememberedUntil > Date.now())) return;
    if (rememberedUntil !== undefined) remembered.delete(request.signature);

    const allowed = await new Promise(resolve => {
      const timeout = setTimeout(() => settle(request.requestId, false), APPROVAL_TIMEOUT_MS);
      timeout.unref?.();
      pending.push({ request, resolve, timeout });
      publishApproval(ctx);
    });
    if (!allowed) return { block: true, reason: "Tool call denied or approval was cancelled." };
  });

  pi.on("session_shutdown", () => {
    cancelAll();
    remembered.clear();
    lastContext = undefined;
  });
}

export const permissionsExtensionInternals = {
  STATE_ENTRY_TYPE,
  MODE_CHANNEL,
  APPROVAL_CHANNEL,
  DEFAULT_MODE,
  APPROVAL_TIMEOUT_MS,
  READ_ONLY_TOOLS,
  parseMode,
  normalizeMode,
  restoreMode,
  normalizedToolName,
  describeToolCall,
  createApprovalRequest,
};

const SESSION_CHANNEL = "session-counter";
const WORKSPACE_CHANNEL = "workspace-note";

export default function extensionUiV2Lab(pi) {
  let sessionCount = 0;
  let workspaceNote = "Ready";

  const publish = (ctx) => {
    ctx.ui.publishFrontendState(SESSION_CHANNEL, { count: sessionCount });
    ctx.ui.publishFrontendState(WORKSPACE_CHANNEL, { note: workspaceNote });
  };

  pi.registerFrontendChannel(SESSION_CHANNEL, {
    scope: "session",
    snapshot: { count: 0 },
    onMessage(message, ctx) {
      if (message && typeof message === "object" && message.action === "increment") sessionCount += 1;
      publish(ctx);
      return { count: sessionCount };
    },
  });

  pi.registerFrontendChannel(WORKSPACE_CHANNEL, {
    scope: "workspace",
    snapshot: { note: "Ready" },
    onMessage(message, ctx) {
      if (message && typeof message === "object" && typeof message.note === "string") workspaceNote = message.note.slice(0, 120);
      publish(ctx);
      return { note: workspaceNote };
    },
  });

  pi.on("session_start", (_event, ctx) => publish(ctx));
}

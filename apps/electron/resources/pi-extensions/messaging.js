function failure(result, fallback) {
  return {
    content: [{ type: "text", text: result.error?.message ?? fallback }],
    details: { status: result.status },
    isError: true,
  };
}

export default function messagingExtension(pi) {
  pi.declareCapabilities([{ capability: "messaging.session", operations: ["list-bindings", "unbind"] }]);

  pi.registerTool({
    name: "list_messaging_channels",
    label: "List messaging channels",
    description: "List Telegram and WhatsApp channels bound to the current session.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const result = await ctx.capabilities.invoke("messaging.session", "list-bindings", {}, { signal });
      if (result.status !== "success") return failure(result, `Messaging channel lookup ${result.status}`);
      const bindings = Array.isArray(result.output) ? result.output : [];
      if (bindings.length === 0) {
        return { content: [{ type: "text", text: "No messaging channels bound to this session." }], details: { bindings: [] } };
      }
      const lines = bindings.map((binding) => {
        const base = binding.channelName || binding.channelId || binding.id;
        const channel = binding.threadId !== undefined ? `${base} › Topic #${binding.threadId}` : base;
        return `- ${binding.platform}: ${channel} (${binding.enabled ? "active" : "disabled"})`;
      });
      return {
        content: [{ type: "text", text: `Messaging bindings for this session:\n${lines.join("\n")}` }],
        details: { bindings },
      };
    },
  });

  pi.registerTool({
    name: "unbind_messaging_channel",
    label: "Unbind messaging channel",
    description: "Disconnect Telegram, WhatsApp, or all messaging channels from the current session.",
    parameters: {
      type: "object",
      properties: { platform: { type: "string", enum: ["telegram", "whatsapp"] } },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params.platform ? { platform: params.platform } : {};
      const result = await ctx.capabilities.invoke("messaging.session", "unbind", input, { signal });
      if (result.status !== "success") return failure(result, `Messaging channel unbind ${result.status}`);
      const removed = Number(result.output?.removed ?? 0);
      const text = removed > 0
        ? `Unbound ${removed} messaging channel(s) for ${params.platform ?? "all platforms"}.`
        : "No messaging channels were bound to this session.";
      return { content: [{ type: "text", text }], details: { removed } };
    },
  });
}

export default function browserExtension(pi) {
  pi.declareCapabilities([{ capability: "browser.command", operations: ["execute"] }]);
  pi.registerTool({
    name: "browser_tool",
    label: "Browser",
    description: `Run browser actions using Mortise's session-owned browser with a CLI-like command.

Examples: --help, open, navigate https://example.com, snapshot, click @e12, fill @e5 value,
scroll down 800, screenshot, wait network-idle 8000, windows, release, close.`,
    promptSnippet: "Control Mortise's built-in browser through browser_tool commands.",
    parameters: {
      type: "object",
      properties: { command: { anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1000 }] } },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await ctx.capabilities.invoke("browser.command", "execute", { command: params.command }, { signal, timeoutMs: 35000 });
      if (result.status !== "success") {
        return { content: [{ type: "text", text: result.error?.message ?? `Browser command ${result.status}` }], details: { status: result.status }, isError: true };
      }
      const output = result.output;
      const previews = (output.artifactRefs ?? []).map((artifact) => `\n\nSaved screenshot: ${artifact.path}\n\n\`\`\`image-preview\n${JSON.stringify({ src: artifact.path, title: "Browser Screenshot" }, null, 2)}\n\`\`\``).join("");
      return { content: [{ type: "text", text: output.text + previews }], details: { artifactRefs: output.artifactRefs ?? [] } };
    },
  });
}

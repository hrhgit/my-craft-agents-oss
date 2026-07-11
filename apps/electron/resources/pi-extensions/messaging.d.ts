declare const messagingExtension: (pi: {
  declareCapabilities(declarations: Array<{ capability: string; operations: string[] }>): void
  registerTool(tool: unknown): void
}) => void
export default messagingExtension

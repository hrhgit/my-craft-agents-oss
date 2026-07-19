export interface NamedExtensionCommand {
  name: string
}

export function matchExactExtensionCommand(
  input: string,
  commands: readonly NamedExtensionCommand[],
): NamedExtensionCommand | undefined {
  const value = input.trim()
  if (!value.startsWith('/') || value.includes(' ')) return undefined
  return commands.find(command => value === `/${command.name}`)
}

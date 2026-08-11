export const OPERATION_PROTOCOL_CAPABILITY = 'long-operations/v1' as const

export const REQUIRED_PROTOCOL_CAPABILITIES = [
  OPERATION_PROTOCOL_CAPABILITY,
] as const

export function missingRequiredProtocolCapabilities(
  capabilities: readonly string[] | undefined,
): string[] {
  const advertised = new Set(capabilities ?? [])
  return REQUIRED_PROTOCOL_CAPABILITIES.filter(capability => !advertised.has(capability))
}

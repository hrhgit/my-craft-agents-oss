/**
 * Electron resolves V2 extension assets through its custom protocol. WebUI
 * exposes the same catalog resources through the authenticated HTTP route.
 */
export function toWebExtensionResourceUrl(url: string): string {
  return url.replace(/^mortise-extension:\/\//, '/api/extensions/ui/')
}

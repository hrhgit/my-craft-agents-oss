/** Private main-to-preload transport data. Never expose this through ElectronAPI. */
export type WorkspaceLocationRuntimeConfig =
  | {
      kind: 'local'
      workspaceId: string
      locationId: string
    }
  | {
      kind: 'remote'
      workspaceId: string
      locationId: string
      url: string
      remoteWorkspaceId: string
      token: string
      allowInsecureTls?: boolean
    }

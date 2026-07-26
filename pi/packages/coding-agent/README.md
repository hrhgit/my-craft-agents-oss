# Mortise Headless Agent Runtime

`@mortise/pi-coding-agent` is the embedded, UI-neutral Agent and RPC runtime
used by Mortise. It preserves Session, tool execution, compaction, extension
lifecycle, and versioned RPC contracts while leaving all user interaction and
GUI rendering to the host.

It has no terminal UI, interactive mode, standalone CLI installation, package
manager, updater, or independent release surface. Production consumers launch
the compiled `pi`/`pi.exe` artifact with no mode selector and negotiate support
through `get_capabilities`.

## Build

```bash
npm run build:workspace
npm run build:workspace:binary
```

The binary build consumes `dist/bun/headless.js` and stages only the executable,
current package metadata, image-processing WebAssembly, and the selected
platform sidecar. Mortise packaging validates the artifact and its immutable
source/build provenance before publication.

For extension APIs, host-rendered contributions, and runnable examples, see
`../../../apps/electron/resources/docs/pi-extensions.md` and
`examples/extensions/mortise-gui.ts`.

# Mortise Embedded Agent Runtime

This subtree contains the Mortise-owned embedded Agent runtime. It is built and
released only as part of Mortise; it is not an independently installed Pi CLI
or a separate product line.

## Packages

- `@mortise/pi-ai`: provider-neutral model streaming and message contracts.
- `@mortise/pi-agent-core`: the UI-neutral Agent Loop and tool execution core.
- `@mortise/pi-coding-agent`: the headless Session, extension lifecycle, and
  versioned RPC runtime used by Mortise hosts.

## Development

From this directory:

```bash
npm ci --ignore-scripts
npm run build:workspace
npx tsgo --noEmit
./test.sh
```

The production executable is compiled from
`packages/coding-agent/src/bun/headless.ts`. It accepts only the bounded
headless provider/model arguments and otherwise communicates over JSONL RPC on
stdin/stdout. Mortise build and packaging code is the sole producer and stager
of that executable.

Extension authoring and host-rendered GUI documentation lives in
`../apps/electron/resources/docs/pi-extensions.md`.

## License

MIT

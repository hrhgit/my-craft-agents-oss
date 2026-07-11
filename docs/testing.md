# Testing

Craft Agent uses Bun for TypeScript tests and Python `unittest` for the bundled document-tool smoke tests.

## Layout

- Unit tests belong in the nearest `__tests__/` directory and use the name `<subject>.test.ts` (or `.test.tsx`). Keep the production module beside that directory.
- Tests that exercise a package boundary may live in `<package>/tests/`. `packages/shared/tests/` is the existing example.
- End-to-end flows belong under `scripts/e2e/`.
- Bundled document-tool smoke tests stay in `apps/electron/resources/scripts/tests/`; they validate packaged wrappers rather than source modules.
- `*.isolated.ts` files are standalone process tests. Do not rename them to `.test.ts`; they are run after the normal Bun discovery pass.

Existing colocated tests are valid legacy exceptions. Move them only with their package's related tests, updating relative imports and any explicit test command in the same change.

## Commands

```bash
# All TypeScript tests, including standalone isolated tests
bun run test

# Bun-discovered TypeScript tests only
bun run test:unit

# Standalone process tests only
bun run test:isolated

# Bundled document-tool smoke tests
bun run test:doc-tools
```

`validate:dev` deliberately runs a smaller, fast validation set. Run `bun run test` before broad test-related changes; expanding CI coverage is a separate decision because it changes validation time and flake exposure. The isolated-test runner is a Bun script so the command works on Windows as well as POSIX shells.

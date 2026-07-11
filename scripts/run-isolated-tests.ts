export {}

const cwd = process.cwd()
const tests: string[] = []

for await (const path of new Bun.Glob('**/*.isolated.ts').scan({ cwd })) {
  if (!path.startsWith('node_modules/')) tests.push(path)
}

for (const test of tests.sort()) {
  const child = Bun.spawn([process.execPath, 'test', `./${test}`], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (await child.exited !== 0) process.exit(1)
}

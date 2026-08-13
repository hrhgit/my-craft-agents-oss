export {}

const cwd = process.cwd()
const tests: string[] = []
const patterns = process.argv.slice(2)

for (const pattern of patterns.length > 0 ? patterns : ['**/*.isolated.ts']) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
    if (!path.startsWith('node_modules/') && !tests.includes(path)) tests.push(path)
  }
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

import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.split(/[?#]/, 1)[0].endsWith('.ts')) return nextLoad(url, context)
  const source = await readFile(new URL(url), 'utf8')
  const transformed = await transform(source, { loader: 'ts', format: 'esm', target: 'node22', sourcemap: 'inline' })
  return { format: 'module', source: transformed.code, shortCircuit: true }
}

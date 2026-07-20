import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { impact, listModules, route, testModule, validationPlan } from '../core.ts'
import { loadRepository, refreshModule, validateRepository } from '../repository.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function shell(root: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function moduleDocument(id: string, owns: string[], extra: Record<string, unknown> = {}): string {
  const data: Record<string, unknown> = {
    schema: 'module-agent/v1', id, name: id, summary: `${id} behavior and contracts`, status: 'active',
    keywords: [id, 'behavior'], owns, related: [], depends_on: [], collaborates_with: [],
    validation: [{
      id: 'regression', kind: 'unit', command: 'bun -e "console.log(\'validated\')"',
      description: 'Run the fixture regression.', triggers: ['owned-change'], required: true,
      evidence: 'Command output.',
    }], scope_digest: '', ...extra,
  }
  const yaml = Object.entries(data).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}:${value.length ? `\n${value.map(item => `  - ${typeof item === 'string' ? JSON.stringify(item) : JSON.stringify(item)}`).join('\n')}` : ' []'}`
    return `${key}: ${JSON.stringify(value)}`
  }).join('\n')
  return `---\n${yaml}\n---\n\n${[
    'Purpose', 'Specialist mandate', 'Responsibilities', 'Non-goals', 'Contracts and invariants',
    'Architecture and entry points', 'Collaboration', 'Validation', 'Known risks', 'Semantic history',
  ].map(heading => `## ${heading}\n\n${heading === 'Semantic history' ? '- 2026-01-01: Initial contract.\n' : 'Defined.\n'}`).join('\n')}`
}

function fixture(modules: Array<{ id: string; owns: string[]; extra?: Record<string, unknown> }>): string {
  const root = mkdtempSync(join(tmpdir(), 'module-agents-')); roots.push(root)
  mkdirSync(join(root, '.agents', 'modules'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '.agents', 'module-system.yaml'), [
    'schema: module-agent-system/v1',
    'modules_dir: .agents/modules',
    'include:',
    '  - "src/**"',
    'exclude: []',
    'history_limit: 20',
    'max_route_candidates: 5',
    'strict: false',
  ].join('\n'))
  for (const module of modules) writeFileSync(join(root, '.agents', 'modules', `${module.id}.md`), moduleDocument(module.id, module.owns, module.extra))
  writeFileSync(join(root, '.gitattributes'), 'src/alpha.ts text\nsrc/beta.ts -text\n')
  writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1\n')
  writeFileSync(join(root, 'src', 'beta.ts'), 'export const beta = 2\n')
  shell(root, ['init', '-q'])
  shell(root, ['config', 'user.email', 'module-agent@example.invalid'])
  shell(root, ['config', 'user.name', 'Module Agent Test'])
  shell(root, ['add', '.'])
  shell(root, ['commit', '-qm', 'fixture'])
  return root
}

async function refreshAll(root: string): Promise<ReturnType<typeof loadRepository>> {
  const repo = await loadRepository(root)
  for (const module of repo.modules) await refreshModule(repo, module)
  return loadRepository(root)
}

describe('module agent repository', () => {
  it('rejects a module directory outside the repository', async () => {
    const root = fixture([{ id: 'all', owns: ['src/**'] }])
    const configPath = join(root, '.agents', 'module-system.yaml')
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('modules_dir: .agents/modules', 'modules_dir: ../modules'))
    await expect(loadRepository(root)).rejects.toThrow('modules_dir must stay inside the repository')
  })

  it('refreshes canonical scope digests and ignores CRLF-only changes', async () => {
    const root = fixture([
      { id: 'alpha', owns: ['src/alpha.ts'] },
      { id: 'beta', owns: ['src/beta.ts'] },
    ])
    let repo = await refreshAll(root)
    expect((await validateRepository(repo, true)).valid).toBe(true)
    const digest = repo.modules[0].scope_digest
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1\r\n')
    repo = await loadRepository(root)
    expect((await validateRepository(repo, true)).valid).toBe(true)
    expect(repo.modules[0].scope_digest).toBe(digest)
  })

  it('detects stale digests, unowned files, overlapping ownership, and invalid relations', async () => {
    const root = fixture([
      { id: 'alpha', owns: ['src/*.ts', 'src/missing/**'], extra: { depends_on: ['missing'], related: ['src/nope/**'] } },
      { id: 'beta', owns: ['src/beta.ts'] },
    ])
    writeFileSync(join(root, 'src', 'orphan.js'), 'unowned\n')
    const result = await validateRepository(await loadRepository(root), false)
    expect(result.valid).toBe(false)
    expect(new Set(result.diagnostics.map(item => item.code))).toEqual(new Set([
      'EMPTY_OWNERSHIP_PATTERN', 'EMPTY_RELATED_PATTERN', 'INVALID_RELATION', 'OVERLAPPING_OWNERSHIP', 'UNOWNED_FILE', 'STALE_SCOPE_DIGEST',
    ]))
  })

  it('reports dependency cycles as non-blocking warnings in strict mode', async () => {
    const root = fixture([
      { id: 'alpha', owns: ['src/alpha.ts'], extra: { depends_on: ['beta'] } },
      { id: 'beta', owns: ['src/beta.ts'], extra: { depends_on: ['alpha'] } },
    ])
    const repo = await refreshAll(root)
    const normal = await validateRepository(repo, false)
    expect(normal.valid).toBe(true)
    expect(normal.diagnostics.some(item => item.code === 'DEPENDENCY_CYCLE')).toBe(true)
    expect((await validateRepository(repo, true)).valid).toBe(true)
  })
})

describe('routing and impact', () => {
  it('prioritizes ownership, then related paths and keywords without returning document bodies', async () => {
    const root = fixture([
      { id: 'alpha', owns: ['src/alpha.ts'], extra: { related: ['src/beta.ts'], keywords: ['provider', 'model'] } },
      { id: 'beta', owns: ['src/beta.ts'] },
    ])
    const repo = await loadRepository(root)
    const result = route(repo, 'provider changes', ['src/alpha.ts'])
    expect(result.candidates[0]).toMatchObject({ module: 'alpha', confidence: 1 })
    expect(result.candidates.map(candidate => candidate.module)).toEqual(['alpha'])
    expect(JSON.stringify(result)).not.toContain('## Purpose')
  })

  it('keeps list output compact unless details are requested', async () => {
    const root = fixture([{ id: 'all', owns: ['src/**'] }])
    const repo = await loadRepository(root)
    expect(listModules(repo)[0]).not.toHaveProperty('owns')
    expect(listModules(repo, true)[0]).toHaveProperty('owns', ['src/**'])
  })

  it('maps baseline changes and untracked files to owners', async () => {
    const root = fixture([
      { id: 'alpha', owns: ['src/alpha.ts'] },
      { id: 'beta', owns: ['src/beta.ts', 'src/new.ts'] },
    ])
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 3\n')
    writeFileSync(join(root, 'src', 'new.ts'), 'export const added = true\n')
    const result = await impact(await loadRepository(root), 'HEAD')
    expect(result.files).toEqual(['src/alpha.ts', 'src/new.ts'])
    expect(result.modules.map(({ validation, ...item }) => item)).toEqual([
      { module: 'alpha', owned_files: ['src/alpha.ts'], related_files: [], reason: 'owner' },
      { module: 'beta', owned_files: ['src/new.ts'], related_files: [], reason: 'owner' },
    ])
    expect(result.modules.every(item => item.validation.recommended_level === 'contract')).toBe(true)
    expect(result.modules[0].validation.available_plans).toEqual([
      { level: 'fast', validation_ids: ['regression'] },
      { level: 'contract', validation_ids: ['regression'] },
      { level: 'full', validation_ids: ['regression'] },
    ])
  })

  it('omits changed files excluded from the managed universe', async () => {
    const root = fixture([{ id: 'all', owns: ['src/**'] }])
    const configPath = join(root, '.agents', 'module-system.yaml')
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('exclude: []', 'exclude: ["src/excluded.ts"]'))
    writeFileSync(join(root, 'src', 'excluded.ts'), 'excluded\n')
    const result = await impact(await loadRepository(root), 'HEAD')
    expect(result.files).not.toContain('src/excluded.ts')
  })

  it('reports both sides of an unstaged rename', async () => {
    const root = fixture([{ id: 'all', owns: ['src/**'] }])
    renameSync(join(root, 'src', 'alpha.ts'), join(root, 'src', 'renamed.ts'))
    const result = await impact(await loadRepository(root), 'HEAD')
    expect(result.files).toContain('src/alpha.ts')
    expect(result.files).toContain('src/renamed.ts')
  })

  it('keeps refresh edits limited to the digest field', async () => {
    const root = fixture([{ id: 'all', owns: ['src/**'] }])
    const repo = await loadRepository(root)
    const before = readFileSync(repo.modules[0].path, 'utf8')
    await refreshModule(repo, repo.modules[0])
    const after = readFileSync(repo.modules[0].path, 'utf8')
    expect(after.replace(/^scope_digest:.*$/m, 'scope_digest:')).toBe(before.replace(/^scope_digest:.*$/m, 'scope_digest:'))
  })

  it('keeps the module-system digest stable when it owns module documents', async () => {
    const root = fixture([{ id: 'module-system', owns: ['src/**', '.agents/**'] }])
    const configPath = join(root, '.agents', 'module-system.yaml')
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('  - "src/**"', '  - "src/**"\n  - ".agents/**"'))
    let repo = await loadRepository(root)
    const first = await refreshModule(repo, repo.modules[0])
    repo = await loadRepository(root)
    const second = await refreshModule(repo, repo.modules[0])
    expect(second).toBe(first)
    expect((await validateRepository(await loadRepository(root), true)).valid).toBe(true)
  })

  it('includes tracked file mode in the scope digest', async () => {
    const root = fixture([{ id: 'all', owns: ['src/**'] }])
    let repo = await refreshAll(root)
    expect((await validateRepository(repo)).valid).toBe(true)
    shell(root, ['update-index', '--chmod=+x', 'src/alpha.ts'])
    repo = await loadRepository(root)
    expect((await validateRepository(repo)).diagnostics).toContainEqual(expect.objectContaining({ code: 'STALE_SCOPE_DIGEST' }))
  })
})

describe('module-owned validation', () => {
  it('builds cumulative fast, contract, and full plans in document order', async () => {
    const validation = [
      { id: 'unit', kind: 'unit', command: 'unit', description: 'unit', triggers: ['owned-change'], required: true, evidence: 'unit' },
      { id: 'contract', kind: 'contract', command: 'contract', description: 'contract', triggers: ['contract-change'], required: true, evidence: 'contract' },
      { id: 'integration', kind: 'integration', command: 'integration', description: 'integration', triggers: ['release'], required: true, evidence: 'integration' },
      { id: 'physical', kind: 'physical', command: 'physical', description: 'physical', triggers: ['ui-change'], required: false, evidence: 'physical' },
    ]
    const root = fixture([{ id: 'all', owns: ['src/**'], extra: { validation } }])
    const module = (await loadRepository(root)).modules[0]
    expect(validationPlan(module, 'fast').map(item => item.id)).toEqual(['unit'])
    expect(validationPlan(module, 'contract').map(item => item.id)).toEqual(['unit', 'contract'])
    expect(validationPlan(module, 'full').map(item => item.id)).toEqual(['unit', 'contract', 'integration', 'physical'])
  })

  it('plans without execution and runs required commands with bounded evidence', async () => {
    const validation = [
      { id: 'pass', kind: 'unit', command: 'bun -e "console.log(\'x\'.repeat(2000))"', description: 'pass', triggers: ['owned-change'], required: true, evidence: 'output' },
      { id: 'optional-failure', kind: 'unit', command: 'bun -e "process.exit(7)"', description: 'optional', triggers: ['owned-change'], required: false, evidence: 'status' },
    ]
    const root = fixture([{ id: 'all', owns: ['src/**'], extra: { validation } }])
    const configPath = join(root, '.agents', 'module-system.yaml')
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\ntest_output_limit: 1000\n`)
    const repo = await loadRepository(root)
    const planned = await testModule(repo, repo.modules[0], 'fast', true)
    expect(planned).toMatchObject({ dry_run: true, passed: null })
    expect(planned.validations.map(item => item.status)).toEqual(['planned', 'planned'])
    const result = await testModule(repo, repo.modules[0], 'fast')
    expect(result.passed).toBe(true)
    expect(result.validations).toMatchObject([
      { id: 'pass', status: 'passed', output_truncated: true },
      { id: 'optional-failure', status: 'failed', exit_code: 7 },
    ])
    expect(result.validations[0].stdout!.length).toBeLessThanOrEqual(1000)
  })

  it('rejects duplicate validation ids', async () => {
    const entry = { id: 'same', kind: 'unit', command: 'bun --version', description: 'same', triggers: ['owned-change'], required: true, evidence: 'status' }
    const root = fixture([{ id: 'all', owns: ['src/**'], extra: { validation: [entry, entry] } }])
    const result = await validateRepository(await loadRepository(root))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_VALIDATION_ID' }))
  })

  it('fails a module result when a required validation fails', async () => {
    const validation = [{
      id: 'required-failure', kind: 'unit', command: 'bun -e "process.exit(9)"',
      description: 'required', triggers: ['owned-change'], required: true, evidence: 'status',
    }]
    const root = fixture([{ id: 'all', owns: ['src/**'], extra: { validation } }])
    const repo = await loadRepository(root)
    const result = await testModule(repo, repo.modules[0], 'fast')
    expect(result.passed).toBe(false)
    expect(result.validations[0]).toMatchObject({ status: 'failed', exit_code: 9 })
  })

  it('times out a validation command and its process tree', async () => {
    const validation = [{
      id: 'timeout', kind: 'unit', command: 'bun -e "setTimeout(() => {}, 5000)"',
      description: 'timeout', triggers: ['owned-change'], required: true, evidence: 'status',
    }]
    const root = fixture([{ id: 'all', owns: ['src/**'], extra: { validation } }])
    const configPath = join(root, '.agents', 'module-system.yaml')
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\ntest_timeout_ms: 1000\n`)
    const repo = await loadRepository(root)
    const result = await testModule(repo, repo.modules[0], 'fast')
    expect(result.passed).toBe(false)
    expect(result.validations[0].status).toBe('timed_out')
    expect(result.validations[0].duration_ms!).toBeLessThan(4000)
  })

  it('recommends fast validation for one owner without related impact', async () => {
    const root = fixture([
      { id: 'alpha', owns: ['src/alpha.ts'] },
      { id: 'beta', owns: ['src/beta.ts'] },
    ])
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 4\n')
    const result = await impact(await loadRepository(root), 'HEAD')
    expect(result.modules[0].validation.recommended_level).toBe('fast')
  })

  it('recommends contract validation when a related module is impacted', async () => {
    const root = fixture([
      { id: 'alpha', owns: ['src/alpha.ts'] },
      { id: 'beta', owns: ['src/beta.ts'], extra: { related: ['src/alpha.ts'] } },
    ])
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 5\n')
    const result = await impact(await loadRepository(root), 'HEAD')
    expect(result.modules.map(item => [item.module, item.reason, item.validation.recommended_level])).toEqual([
      ['alpha', 'owner', 'contract'],
      ['beta', 'related', 'contract'],
    ])
  })
})

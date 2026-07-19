import { describe, it, expect } from 'bun:test'
import { homedir, tmpdir } from 'os'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { join, sep } from 'path'
import { validateFilePath } from '../utils'

const home = homedir()
const tmp = tmpdir()

describe('validateFilePath', () => {
  it('allows paths inside home directory', async () => {
    const path = join(home, 'Documents', 'test.txt')
    const result = await validateFilePath(path)
    expect(result).toContain('test.txt')
  })

  it('allows paths inside temp directory', async () => {
    const path = join(tmp, 'mortise-test.txt')
    const result = await validateFilePath(path)
    expect(result).toContain('mortise-test.txt')
  })

  it('denies paths outside all allowed directories', async () => {
    // Use a path that's definitely outside home and tmp on any platform
    const path = sep === '\\' ? 'Z:\\forbidden\\test.txt' : '/forbidden/test.txt'
    await expect(validateFilePath(path)).rejects.toThrow('Access denied')
  })

  it('allows paths inside additionalAllowedDirs', async () => {
    const projectDir = sep === '\\' ? 'D:\\Projects\\myapp' : '/opt/projects/myapp'
    const path = join(projectDir, 'src', 'main.ts')
    const result = await validateFilePath(path, [projectDir])
    expect(result).toContain('main.ts')
  })

  it('still allows homedir paths when additionalAllowedDirs are provided', async () => {
    const path = join(home, 'test.txt')
    const result = await validateFilePath(path, ['/some/other/dir'])
    expect(result).toContain('test.txt')
  })

  it('blocks sensitive files even inside allowed dirs', async () => {
    const path = join(home, '.ssh', 'id_rsa')
    await expect(validateFilePath(path)).rejects.toThrow('sensitive')
  })

  it('sensitive patterns match Windows backslash separators', () => {
    // Verify the regex patterns used in validateFilePath match both / and \
    const sshPatternUnix = /\.ssh[\\/]/
    const sshPatternWindows = /\.ssh[\\/]/
    expect(sshPatternUnix.test('C:\\Users\\me\\.ssh\\id_rsa')).toBe(true)
    expect(sshPatternWindows.test('/home/me/.ssh/id_rsa')).toBe(true)
    expect(/\.gnupg[\\/]/.test('C:\\Users\\me\\.gnupg\\keys')).toBe(true)
    expect(/\.aws[\\/]credentials/.test('C:\\Users\\me\\.aws\\credentials')).toBe(true)
  })

  it('blocks .env files', async () => {
    const path = join(home, 'project', '.env')
    await expect(validateFilePath(path)).rejects.toThrow('sensitive')
  })

  it('blocks credentials.json', async () => {
    const path = join(home, 'project', 'credentials.json')
    await expect(validateFilePath(path)).rejects.toThrow('sensitive')
  })

  it('blocks .pem files even inside additionalAllowedDirs', async () => {
    const projectDir = join(home, 'project')
    const path = join(projectDir, 'server.pem')
    await expect(validateFilePath(path, [projectDir])).rejects.toThrow('sensitive')
  })

  it('blocks case variants of sensitive paths', async () => {
    const sensitivePaths = [
      join(home, '.SSH', 'id_rsa'),
      join(home, '.GNUPG', 'private-keys-v1.d', 'key'),
      join(home, '.AWS', 'CREDENTIALS'),
      join(home, 'project', '.ENV'),
      join(home, 'project', '.Env.Local'),
      join(home, 'project', 'CREDENTIALS.JSON'),
      join(home, 'project', 'SECRETS.YAML'),
      join(home, 'project', 'SERVER.PEM'),
      join(home, 'project', 'PRIVATE.KEY'),
    ]

    for (const path of sensitivePaths) {
      await expect(validateFilePath(path)).rejects.toThrow('sensitive')
    }
  })

  it('expands tilde paths', async () => {
    const result = await validateFilePath('~/test-file.txt')
    expect(result).toContain(home)
  })

  it('rejects relative paths', async () => {
    await expect(validateFilePath('relative/path.txt')).rejects.toThrow('absolute')
  })

  it('filters out falsy values in additionalAllowedDirs', async () => {
    const path = join(home, 'test.txt')
    // Should not throw even with undefined/empty values in the array
    const result = await validateFilePath(path, ['', undefined as unknown as string])
    expect(result).toContain('test.txt')
  })

  it('allows an allowed directory that is itself a symlink or junction', async () => {
    const sandbox = await mkdtemp(join(tmp, 'mortise-path-root-link-'))
    try {
      const target = join(sandbox, 'target')
      const alias = join(sandbox, 'workspace-link')
      const targetFile = join(target, 'notes.txt')
      await mkdir(target)
      await writeFile(targetFile, 'ok')
      try {
        await symlink(target, alias, 'junction')
      } catch {
        return
      }

      await expect(validateFilePath(join(alias, 'notes.txt'), [alias], {
        allowHome: false,
        allowTmp: false,
      })).resolves.toBe(await realpath(targetFile))
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('still blocks existing and future children that escape through a nested link', async () => {
    const sandbox = await mkdtemp(join(tmp, 'mortise-path-nested-link-'))
    const outside = await mkdtemp(join(tmp, 'mortise-path-nested-outside-'))
    try {
      const target = join(sandbox, 'target')
      const alias = join(sandbox, 'workspace-link')
      const escape = join(target, 'escape')
      await mkdir(target)
      await writeFile(join(outside, 'outside.txt'), 'outside')
      try {
        await symlink(target, alias, 'junction')
        await symlink(outside, escape, 'junction')
      } catch {
        return
      }

      const options = { allowHome: false, allowTmp: false }
      await expect(validateFilePath(join(alias, 'escape', 'outside.txt'), [alias], options))
        .rejects.toThrow('Access denied')
      await expect(validateFilePath(join(alias, 'escape', 'future.txt'), [alias], options))
        .rejects.toThrow('Access denied')
    } finally {
      await rm(sandbox, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('treats Windows path casing as the same allowed directory', async () => {
    if (sep !== '\\') return
    const root = await mkdtemp(join(tmp, 'mortise-path-case-'))
    try {
      const mixedCaseDir = join(root, 'WorkSpace')
      const file = join(mixedCaseDir, 'notes.txt')
      await mkdir(mixedCaseDir)
      await writeFile(file, 'ok')
      await expect(validateFilePath(file, [mixedCaseDir.toLowerCase()], { allowHome: false, allowTmp: false }))
        .resolves.toBe(file)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

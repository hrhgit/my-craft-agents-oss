const testModules = [
  'apps.electron.resources.scripts.tests.test_pdf_tool_smoke',
  'apps.electron.resources.scripts.tests.test_xlsx_tool_smoke',
  'apps.electron.resources.scripts.tests.test_docx_tool_smoke',
  'apps.electron.resources.scripts.tests.test_pptx_tool_smoke',
  'apps.electron.resources.scripts.tests.test_img_tool_smoke',
  'apps.electron.resources.scripts.tests.test_ical_tool_smoke',
  'apps.electron.resources.scripts.tests.test_doc_diff_smoke',
  'apps.electron.resources.scripts.tests.test_markitdown_smoke',
]

const configuredPython = process.env.PYTHON?.trim()
const candidates: string[][] = [
  ...(configuredPython ? [[configuredPython]] : []),
  ['python3'],
  ['python'],
  ...(process.platform === 'win32' ? [['py', '-3']] : []),
]

for (const [command, ...prefixArgs] of candidates) {
  let probe: ReturnType<typeof Bun.spawnSync>
  try {
    probe = Bun.spawnSync([command!, ...prefixArgs, '--version'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
    throw error
  }
  if (probe.exitCode !== 0) continue

  const result = Bun.spawnSync([command!, ...prefixArgs, '-m', 'unittest', ...testModules], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(result.exitCode)
}

console.error('No usable Python 3 interpreter found. Set PYTHON or install python3, python, or the Windows py launcher.')
process.exit(1)

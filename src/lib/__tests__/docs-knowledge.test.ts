import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const envKeys = [
  'MISSION_CONTROL_DOCS_DIR',
  'OPENCLAW_DOCS_DIR',
  'MISSION_CONTROL_DOCS_ALLOWED_PREFIXES',
  'OPENCLAW_DOCS_ALLOWED_PREFIXES',
  'MISSION_CONTROL_DOCUMENTS_ROOTS',
  'OPENCLAW_DOCUMENTS_ROOTS',
  'OPENCLAW_STATE_DIR',
  'MISSION_CONTROL_OPENCLAW_HOME',
  'OPENCLAW_HOME',
  'OPENCLAW_WORKSPACE_DIR',
]

const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

async function loadModule() {
  vi.resetModules()
  return import('@/lib/docs-knowledge')
}

afterEach(() => {
  for (const key of envKeys) {
    const value = previousEnv[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})

describe('docs-knowledge multi-root resolution', () => {
  it('prefers explicit multi-root documents paths and preserves legacy docs roots', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docs-test-'))
    const labDir = path.join(tempRoot, 'openclaw-lab')
    const stateDir = path.join(tempRoot, '.openclaw')
    const workspaceDir = path.join(stateDir, 'workspace')
    const docsBaseDir = path.join(tempRoot, 'legacy-base')
    const kbDir = path.join(docsBaseDir, 'knowledge-base')

    fs.mkdirSync(path.join(labDir, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(workspaceDir, 'agent-a', 'memory'), { recursive: true })
    fs.mkdirSync(kbDir, { recursive: true })

    fs.writeFileSync(path.join(labDir, 'notes', 'runbook.md'), '# lab runbook\nhello documents')
    fs.writeFileSync(path.join(workspaceDir, 'agent-a', 'memory', 'today.md'), '# today\nhello workspace')
    fs.writeFileSync(path.join(kbDir, 'legacy.md'), '# legacy\nhello legacy')

    process.env.MISSION_CONTROL_DOCUMENTS_ROOTS = [labDir, stateDir, workspaceDir].join(',')
    process.env.MISSION_CONTROL_DOCS_DIR = docsBaseDir

    const docs = await loadModule()
    expect(docs.listDocsRoots()).toEqual(['openclaw-lab', '.openclaw', 'workspace', 'knowledge-base'])
    expect(docs.isDocsPathAllowed('openclaw-lab/notes/runbook.md')).toBe(true)
    expect(docs.isDocsPathAllowed('.openclaw/workspace/agent-a/memory/today.md')).toBe(true)
    expect(docs.isDocsPathAllowed('workspace/agent-a/memory/today.md')).toBe(true)
    expect(docs.isDocsPathAllowed('knowledge-base/legacy.md')).toBe(true)

    const doc = await docs.readDocsContent('openclaw-lab/notes/runbook.md')
    expect(doc.content).toContain('hello documents')

    const results = await docs.searchDocs('hello', 10)
    expect(results.map((row) => row.path)).toEqual(expect.arrayContaining([
      'openclaw-lab/notes/runbook.md',
      'workspace/agent-a/memory/today.md',
      'knowledge-base/legacy.md',
    ]))

    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
})

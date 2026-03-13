import { readdir, readFile, stat, lstat, realpath } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join, sep } from 'path'
import { resolveWithin } from '@/lib/paths'
import { config } from '@/lib/config'

const DOC_ROOT_CANDIDATES = ['docs', 'knowledge-base', 'knowledge', 'memory', 'shared-memory', 'reports']

interface DocsRoot {
  name: string
  path: string
}

export interface DocsTreeNode {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: DocsTreeNode[]
}

function normalizeRelativePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function normalizeAbsolutePath(value: string): string {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

function docsBaseDir(): string {
  return process.env.MISSION_CONTROL_DOCS_DIR || process.env.OPENCLAW_DOCS_DIR || config.memoryDir
}

function docsAllowedRootsFromEnv(baseDir: string): string[] {
  const raw = process.env.MISSION_CONTROL_DOCS_ALLOWED_PREFIXES || process.env.OPENCLAW_DOCS_ALLOWED_PREFIXES || ''
  return raw
    .split(',')
    .map((part) => normalizeRelativePath(part).replace(/\/$/, ''))
    .filter(Boolean)
    .filter((prefix) => existsSync(join(baseDir, prefix)))
}

function docsExtraRootsFromEnv(): string[] {
  const raw = process.env.MISSION_CONTROL_DOCUMENTS_ROOTS || process.env.OPENCLAW_DOCUMENTS_ROOTS || ''
  return raw
    .split(',')
    .map((part) => normalizeAbsolutePath(part))
    .filter(Boolean)
    .filter((rootPath) => existsSync(rootPath))
}

function isWithinBase(base: string, candidate: string): boolean {
  if (candidate === base) return true
  return candidate.startsWith(base + sep)
}

async function resolveSafePath(baseDir: string, relativePath: string): Promise<string> {
  const baseReal = await realpath(baseDir)
  const fullPath = resolveWithin(baseDir, relativePath)

  let parentReal: string
  try {
    parentReal = await realpath(dirname(fullPath))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error('Parent directory not found')
    throw err
  }

  if (!isWithinBase(baseReal, parentReal)) {
    throw new Error('Path escapes base directory (symlink)')
  }

  try {
    const st = await lstat(fullPath)
    if (st.isSymbolicLink()) throw new Error('Symbolic links are not allowed')
    const fileReal = await realpath(fullPath)
    if (!isWithinBase(baseReal, fileReal)) {
      throw new Error('Path escapes base directory (symlink)')
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }

  return fullPath
}

function buildLegacyDocsRoots(): DocsRoot[] {
  const baseDir = docsBaseDir()
  if (!baseDir || !existsSync(baseDir)) return []

  const envRoots = docsAllowedRootsFromEnv(baseDir)
  const relativeRoots = envRoots.length > 0
    ? envRoots
    : DOC_ROOT_CANDIDATES.filter((root) => existsSync(join(baseDir, root)))

  const fallbackRoots = relativeRoots.length > 0
    ? relativeRoots
    : (config.memoryAllowedPrefixes || [])
      .map((prefix) => normalizeRelativePath(prefix).replace(/\/$/, ''))
      .filter((prefix) => prefix.length > 0)
      .filter((prefix) => existsSync(join(baseDir, prefix)))

  return fallbackRoots.map((root) => ({
    name: root,
    path: join(baseDir, root),
  }))
}

function buildPreferredDocsRoots(): DocsRoot[] {
  const envRoots = docsExtraRootsFromEnv()
  const preferred: Array<string | undefined> = envRoots.length > 0
    ? envRoots
    : [
        join(config.homeDir, 'openclaw-lab'),
        join(config.homeDir, 'OpenClaw Lab'),
        config.openclawStateDir,
        process.env.OPENCLAW_WORKSPACE_DIR || join(config.openclawStateDir, 'workspace'),
        join(config.homeDir, 'workspaces'),
      ]

  return preferred
    .map((rootPath) => normalizeAbsolutePath(rootPath || ''))
    .filter(Boolean)
    .filter((rootPath) => existsSync(rootPath))
    .map((rootPath) => ({
      name: basename(rootPath),
      path: rootPath,
    }))
}

function dedupeDocsRoots(roots: DocsRoot[]): DocsRoot[] {
  const seenPaths = new Set<string>()
  const seenNames = new Set<string>()
  const deduped: DocsRoot[] = []

  for (const root of roots) {
    const normalizedPath = normalizeAbsolutePath(root.path)
    if (!normalizedPath || seenPaths.has(normalizedPath)) continue

    let name = normalizeRelativePath(root.name).replace(/\/$/, '') || basename(normalizedPath) || 'documents'
    if (seenNames.has(name)) {
      let counter = 2
      while (seenNames.has(`${name}-${counter}`)) counter += 1
      name = `${name}-${counter}`
    }

    seenPaths.add(normalizedPath)
    seenNames.add(name)
    deduped.push({ name, path: normalizedPath })
  }

  return deduped
}

function resolveDocsRoots(): DocsRoot[] {
  return dedupeDocsRoots([
    ...buildPreferredDocsRoots(),
    ...buildLegacyDocsRoots(),
  ])
}

function findDocsRootForPath(relativePath: string): { root: DocsRoot; subpath: string } | null {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized) return null

  for (const root of resolveDocsRoots()) {
    if (normalized === root.name) {
      return { root, subpath: '' }
    }
    if (normalized.startsWith(`${root.name}/`)) {
      return { root, subpath: normalized.slice(root.name.length + 1) }
    }
  }

  return null
}

export function listDocsRoots(): string[] {
  return resolveDocsRoots().map((root) => root.name)
}

export function isDocsPathAllowed(relativePath: string): boolean {
  return findDocsRootForPath(relativePath) !== null
}

async function buildTreeFrom(dirPath: string, relativeBase: string): Promise<DocsTreeNode[]> {
  const items = await readdir(dirPath, { withFileTypes: true })
  const nodes: DocsTreeNode[] = []

  for (const item of items) {
    if (item.isSymbolicLink()) continue
    const fullPath = join(dirPath, item.name)
    const relativePath = normalizeRelativePath(join(relativeBase, item.name))

    try {
      const info = await stat(fullPath)
      if (item.isDirectory()) {
        const children = await buildTreeFrom(fullPath, relativePath)
        nodes.push({
          path: relativePath,
          name: item.name,
          type: 'directory',
          modified: info.mtime.getTime(),
          children,
        })
      } else if (item.isFile()) {
        nodes.push({
          path: relativePath,
          name: item.name,
          type: 'file',
          size: info.size,
          modified: info.mtime.getTime(),
        })
      }
    } catch {
      // Ignore unreadable files
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export async function getDocsTree(): Promise<DocsTreeNode[]> {
  const roots = resolveDocsRoots()
  const tree: DocsTreeNode[] = []

  for (const root of roots) {
    try {
      const info = await stat(root.path)
      if (!info.isDirectory()) continue
      tree.push({
        path: root.name,
        name: root.name,
        type: 'directory',
        modified: info.mtime.getTime(),
        children: await buildTreeFrom(root.path, root.name),
      })
    } catch {
      // Ignore unreadable roots
    }
  }

  return tree
}

export async function readDocsContent(relativePath: string): Promise<{ content: string; size: number; modified: number; path: string }> {
  const match = findDocsRootForPath(relativePath)
  if (!match) {
    throw new Error('Path not allowed')
  }

  const safePath = await resolveSafePath(match.root.path, match.subpath)
  const content = await readFile(safePath, 'utf-8')
  const info = await stat(safePath)

  return {
    content,
    size: info.size,
    modified: info.mtime.getTime(),
    path: normalizeRelativePath(relativePath),
  }
}

function isSearchable(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.txt')
}

export async function searchDocs(query: string, limit = 100): Promise<Array<{ path: string; name: string; matches: number }>> {
  const roots = resolveDocsRoots()
  if (roots.length === 0) return []

  const q = query.trim().toLowerCase()
  if (!q) return []

  const results: Array<{ path: string; name: string; matches: number }> = []

  const searchFile = async (fullPath: string, relativePath: string) => {
    try {
      const info = await stat(fullPath)
      if (info.size > 1_000_000) return
      const content = (await readFile(fullPath, 'utf-8')).toLowerCase()
      let count = 0
      let idx = content.indexOf(q)
      while (idx !== -1) {
        count += 1
        idx = content.indexOf(q, idx + q.length)
      }
      if (count > 0) {
        results.push({
          path: normalizeRelativePath(relativePath),
          name: relativePath.split('/').pop() || relativePath,
          matches: count,
        })
      }
    } catch {
      // Ignore unreadable files
    }
  }

  const searchDir = async (fullDir: string, relativeDir: string) => {
    const items = await readdir(fullDir, { withFileTypes: true })
    for (const item of items) {
      if (item.isSymbolicLink()) continue
      const itemFull = join(fullDir, item.name)
      const itemRel = normalizeRelativePath(join(relativeDir, item.name))
      if (item.isDirectory()) {
        await searchDir(itemFull, itemRel)
      } else if (item.isFile() && isSearchable(item.name.toLowerCase())) {
        await searchFile(itemFull, itemRel)
      }
    }
  }

  for (const root of roots) {
    try {
      await searchDir(root.path, root.name)
    } catch {
      // Ignore unreadable roots
    }
  }

  return results.sort((a, b) => b.matches - a.matches).slice(0, Math.max(1, Math.min(limit, 200)))
}

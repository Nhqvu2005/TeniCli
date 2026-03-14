import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { resolve, relative, join, dirname } from 'path'
import { c, toolLog, sym } from './ui'
import type { ContentBlock } from './provider'

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, any>
}

// ── File change tracker (for /diff and /undo) ────────────────────
export class FileTracker {
  private writes: { path: string; backup: string | null; newLines: number; time: Date }[] = []

  recordWrite(absPath: string, newContent: string) {
    const backup = existsSync(absPath) ? readFileSync(absPath, 'utf8') : null
    this.writes.push({
      path: absPath,
      backup,
      newLines: newContent.split('\n').length,
      time: new Date(),
    })
  }

  getChanges(): { path: string; isNew: boolean; lines: number; time: Date }[] {
    const seen = new Map<string, { isNew: boolean; lines: number; time: Date }>()
    for (const w of this.writes) {
      seen.set(w.path, { isNew: w.backup === null, lines: w.newLines, time: w.time })
    }
    return Array.from(seen.entries()).map(([path, info]) => ({ path, ...info }))
  }

  undo(): { path: string; restored: boolean } | null {
    const last = this.writes.pop()
    if (!last) return null
    if (last.backup !== null) {
      writeFileSync(last.path, last.backup, 'utf8')
      return { path: last.path, restored: true }
    } else {
      // File was new — delete it
      try { require('fs').unlinkSync(last.path) } catch {}
      return { path: last.path, restored: false }
    }
  }

  get count() { return this.writes.length }

  clear() { this.writes = [] }
}

export const fileTracker = new FileTracker()

// ── Tool Definitions (Anthropic format) ──────────────────────────
export const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read contents of a file. Returns the file text.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
        start_line: { type: 'number', description: 'Optional: start line (1-indexed)' },
        end_line: { type: 'number', description: 'Optional: end line (1-indexed, inclusive)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories in a path. Returns names with type indicators.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: cwd)' },
        depth: { type: 'number', description: 'Max depth (default: 1)' },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    description: 'Search for text in files using pattern matching (like grep). Returns matching lines with file paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in (default: cwd)' },
        include: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'exec_command',
    description: 'Execute a shell command. Returns stdout and stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (default: project cwd)' },
      },
      required: ['command'],
    },
  },
]

// ── Tool Executors ───────────────────────────────────────────────
const MAX_OUTPUT = 30000 // Truncate large outputs

export async function executeTool(name: string, input: Record<string, any>, cwd: string): Promise<ContentBlock> {
  try {
    let result: string

    switch (name) {
      case 'read_file':
        result = execReadFile(input, cwd)
        toolLog('read_file', c.dim(relative(cwd, resolvePath(input.path, cwd))))
        break
      case 'write_file':
        result = execWriteFile(input, cwd)
        toolLog('write_file', c.dim(relative(cwd, resolvePath(input.path, cwd))))
        break
      case 'list_dir':
        result = execListDir(input, cwd)
        toolLog('list_dir', c.dim(input.path || '.'))
        break
      case 'search_files':
        result = await execSearchFiles(input, cwd)
        toolLog('search_files', c.dim(`"${input.pattern}"`))
        break
      case 'exec_command':
        result = await execCommand(input, cwd)
        toolLog('exec_command', c.dim(truncate(input.command, 60)))
        break
      default:
        result = `Unknown tool: ${name}`
    }

    return { type: 'tool_result' as const, content: truncate(result, MAX_OUTPUT) }
  } catch (e: any) {
    return { type: 'tool_result' as const, content: `Error: ${e.message}`, is_error: true }
  }
}

// ── Individual executors ─────────────────────────────────────────
function resolvePath(p: string, cwd: string): string {
  return resolve(cwd, p)
}

function execReadFile(input: Record<string, any>, cwd: string): string {
  const fp = resolvePath(input.path, cwd)
  if (!existsSync(fp)) return `File not found: ${input.path}`
  const content = readFileSync(fp, 'utf8')
  const lines = content.split('\n')

  if (input.start_line || input.end_line) {
    const start = Math.max(1, input.start_line || 1) - 1
    const end = Math.min(lines.length, input.end_line || lines.length)
    return lines.slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n')
  }

  // If file is large, add line numbers
  if (lines.length > 50) {
    return lines.map((l, i) => `${i + 1}: ${l}`).join('\n')
  }
  return content
}

function execWriteFile(input: Record<string, any>, cwd: string): string {
  const fp = resolvePath(input.path, cwd)
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  fileTracker.recordWrite(fp, input.content)
  writeFileSync(fp, input.content, 'utf8')
  return `Written ${input.content.split('\n').length} lines to ${input.path}`
}

function execListDir(input: Record<string, any>, cwd: string): string {
  const dir = resolvePath(input.path || '.', cwd)
  if (!existsSync(dir)) return `Directory not found: ${input.path || '.'}`
  const depth = input.depth || 1

  const entries: string[] = []
  function walk(d: string, level: number) {
    if (level > depth) return
    try {
      const items = readdirSync(d)
      for (const item of items) {
        if (item.startsWith('.') || item === 'node_modules') continue
        const full = join(d, item)
        const rel = relative(dir, full)
        try {
          const stat = statSync(full)
          const prefix = '  '.repeat(level)
          if (stat.isDirectory()) {
            entries.push(`${prefix}${rel}/`)
            walk(full, level + 1)
          } else {
            const size = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`
            entries.push(`${prefix}${rel} (${size})`)
          }
        } catch {}
      }
    } catch {}
  }

  walk(dir, 0)
  return entries.length > 0 ? entries.join('\n') : '(empty directory)'
}

async function execSearchFiles(input: Record<string, any>, cwd: string): Promise<string> {
  const dir = resolvePath(input.path || '.', cwd)
  const pattern = input.pattern

  // Try ripgrep first (faster), fallback to manual
  try {
    const args = ['rg', '-n', '--max-count=50', '--no-heading']
    if (input.include) args.push('--glob', input.include)
    args.push(pattern, dir)

    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code === 0 || code === 1) return out.trim() || 'No matches found.'
  } catch {}

  // Fallback: simple file search
  const results: string[] = []
  function search(d: string) {
    try {
      for (const item of readdirSync(d)) {
        if (item.startsWith('.') || item === 'node_modules') continue
        const full = join(d, item)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) { search(full); continue }
          if (stat.size > 500000) continue // Skip large files
          if (input.include && !matchGlob(item, input.include)) continue
          const content = readFileSync(full, 'utf8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              results.push(`${relative(cwd, full)}:${i + 1}: ${lines[i].trim()}`)
              if (results.length >= 50) return
            }
          }
        } catch {}
      }
    } catch {}
  }
  search(dir)
  return results.length > 0 ? results.join('\n') : 'No matches found.'
}

async function execCommand(input: Record<string, any>, cwd: string): Promise<string> {
  const dir = resolvePath(input.cwd || '.', cwd)

  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd' : 'sh'
  const shellFlag = isWindows ? '/c' : '-c'

  const proc = Bun.spawn([shell, shellFlag, input.command], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PAGER: 'cat' },
  })

  // Timeout: 30 seconds
  const timeout = setTimeout(() => proc.kill(), 30000)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timeout)
  const code = await proc.exited

  let output = ''
  if (stdout.trim()) output += stdout.trim()
  if (stderr.trim()) output += (output ? '\n' : '') + `[stderr] ${stderr.trim()}`
  output += `\n[exit code: ${code}]`
  return output
}

// ── Helpers ──────────────────────────────────────────────────────
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... (truncated, ${s.length - max} chars omitted)`
}

function matchGlob(filename: string, pattern: string): boolean {
  // Simple glob: *.ext
  if (pattern.startsWith('*.')) {
    return filename.endsWith(pattern.slice(1))
  }
  return filename.includes(pattern.replace(/\*/g, ''))
}

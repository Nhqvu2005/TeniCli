import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'fs'
import { resolve, relative, join, dirname } from 'path'
import { c, toolLog, sym } from './ui'
import type { ContentBlock } from './provider'

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, any>
}

// ── Snapshot entry on disk ────────────────────────────────────────
interface SnapshotEntry {
  path: string           // absolute file path that was modified
  backup: string | null  // original file content (null = file was new)
  newContent: string     // the content that was written (for hash comparison)
  newLines: number       // lines in the new version
  time: string           // ISO timestamp
  label: string          // human-readable label
}

// ── Persistent File Tracker (disk-backed snapshots) ──────────────
export class FileTracker {
  private snapshotDir: string
  // In-memory cache for current session (fast access)
  private sessionWrites: SnapshotEntry[] = []

  constructor(cwd?: string) {
    const projectRoot = cwd || process.cwd()
    this.snapshotDir = join(projectRoot, '.tenicli', 'snapshots')
    if (!existsSync(this.snapshotDir)) mkdirSync(this.snapshotDir, { recursive: true })
    // Load existing snapshots from disk into memory
    this.loadFromDisk()
  }

  private loadFromDisk() {
    try {
      const files = readdirSync(this.snapshotDir)
        .filter(f => f.endsWith('.json'))
        .sort() // chronological by timestamp filename
      for (const file of files) {
        try {
          const content = readFileSync(join(this.snapshotDir, file), 'utf8')
          const entry: SnapshotEntry = JSON.parse(content)
          this.sessionWrites.push(entry)
        } catch {}
      }
    } catch {}
  }

  private saveEntry(entry: SnapshotEntry): string {
    const ts = Date.now()
    const filename = `${ts}.json`
    const filepath = join(this.snapshotDir, filename)
    writeFileSync(filepath, JSON.stringify(entry), 'utf8')
    return filename
  }

  private removeEntry(entry: SnapshotEntry) {
    // Find and delete the matching snapshot file from disk
    try {
      const files = readdirSync(this.snapshotDir).filter(f => f.endsWith('.json')).sort()
      // Remove the last one that matches this path (most recent)
      for (let i = files.length - 1; i >= 0; i--) {
        try {
          const content = readFileSync(join(this.snapshotDir, files[i]), 'utf8')
          const disk: SnapshotEntry = JSON.parse(content)
          if (disk.path === entry.path && disk.time === entry.time) {
            unlinkSync(join(this.snapshotDir, files[i]))
            return
          }
        } catch {}
      }
    } catch {}
  }

  recordWrite(absPath: string, newContent: string) {
    const backup = existsSync(absPath) ? readFileSync(absPath, 'utf8') : null
    const entry: SnapshotEntry = {
      path: absPath,
      backup,
      newContent,
      newLines: newContent.split('\n').length,
      time: new Date().toISOString(),
      label: backup === null ? `create ${relative(process.cwd(), absPath)}` : `modify ${relative(process.cwd(), absPath)}`,
    }
    this.sessionWrites.push(entry)
    this.saveEntry(entry)
  }

  getChanges(): { path: string; isNew: boolean; lines: number; time: Date }[] {
    const seen = new Map<string, { isNew: boolean; lines: number; time: Date }>()
    for (const w of this.sessionWrites) {
      seen.set(w.path, { isNew: w.backup === null, lines: w.newLines, time: new Date(w.time) })
    }
    return Array.from(seen.entries()).map(([path, info]) => ({ path, ...info }))
  }

  /** Get full timeline (all individual actions, not deduplicated) */
  getTimeline(): { path: string; isNew: boolean; lines: number; time: Date; label: string }[] {
    return this.sessionWrites.map(w => ({
      path: w.path,
      isNew: w.backup === null,
      lines: w.newLines,
      time: new Date(w.time),
      label: w.label,
    }))
  }

  undo(): { path: string; restored: boolean; warning?: string } | null {
    const last = this.sessionWrites.pop()
    if (!last) return null
    // Remove from disk
    this.removeEntry(last)

    // Safety: detect manual edits since AI wrote this file
    if (existsSync(last.path)) {
      const currentContent = readFileSync(last.path, 'utf8')
      if (currentContent !== last.newContent) {
        // File was manually edited after AI wrote it — warn but still restore
        const warning = `File was modified externally since AI edit. Restoring anyway.`
        if (last.backup !== null) {
          writeFileSync(last.path, last.backup, 'utf8')
          return { path: last.path, restored: true, warning }
        } else {
          try { unlinkSync(last.path) } catch {}
          return { path: last.path, restored: false, warning }
        }
      }
    }

    // Normal restore
    if (last.backup !== null) {
      writeFileSync(last.path, last.backup, 'utf8')
      return { path: last.path, restored: true }
    } else {
      try { unlinkSync(last.path) } catch {}
      return { path: last.path, restored: false }
    }
  }

  undoAll(): number {
    let count = 0
    while (this.sessionWrites.length > 0) {
      this.undo()
      count++
    }
    return count
  }

  get count() { return this.sessionWrites.length }

  clear() {
    // Clear in-memory only (disk snapshots stay for cross-session undo)
    this.sessionWrites = []
  }

  /** Purge all snapshots from disk */
  purge() {
    try {
      const files = readdirSync(this.snapshotDir).filter(f => f.endsWith('.json'))
      for (const f of files) { try { unlinkSync(join(this.snapshotDir, f)) } catch {} }
    } catch {}
    this.sessionWrites = []
  }
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

// ── Security ─────────────────────────────────────────────────────
import { realpathSync, lstatSync } from 'fs'

const BLOCKED_COMMANDS = [
  'rm -rf /',  'rm -rf ~',  'rm -rf *',
  'del /s /q c:',  'del /s /q d:',
  'format c:',  'format d:',
  'mkfs',  'dd if=',
  'shutdown',  'reboot',
  ':(){:|:&};:',  // fork bomb
  'chmod -R 777 /',
  '> /dev/sda',
  'mv / ',  'mv ~ ',
]

// Shell indirection patterns that could wrap dangerous commands
const DANGEROUS_PATTERNS = [
  /\$\(.*\b(rm|del|format|mkfs|dd|shutdown|reboot)\b/i,      // $(rm -rf /)
  /`.*\b(rm|del|format|mkfs|dd|shutdown|reboot)\b/i,         // `rm -rf /`
  /\|\s*(sh|bash|cmd|powershell)/i,                          // curl ... | sh
  /\beval\s/i,                                                // eval "..."
]

function isBlockedCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase().trim()
  // Direct match
  if (BLOCKED_COMMANDS.some(b => lower.startsWith(b) || lower.includes(b))) return true
  // Shell indirection / injection patterns
  if (DANGEROUS_PATTERNS.some(p => p.test(cmd))) return true
  return false
}

function isPathAllowed(filePath: string, cwd: string): boolean {
  const resolved = resolve(filePath)
  const root = resolve(cwd)

  // Check if resolved path is within project root
  if (!resolved.startsWith(root)) return false

  // If path exists, resolve symlinks and re-check real location
  try {
    if (existsSync(filePath)) {
      const stat = lstatSync(filePath)
      if (stat.isSymbolicLink()) {
        const real = realpathSync(filePath)
        if (!real.startsWith(root)) return false
      }
    }
    // Check parent dir for symlinks (path traversal via symlinked dir)
    const parent = dirname(resolved)
    if (existsSync(parent)) {
      const parentStat = lstatSync(parent)
      if (parentStat.isSymbolicLink()) {
        const realParent = realpathSync(parent)
        if (!realParent.startsWith(root)) return false
      }
    }
  } catch {}

  return true
}

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

// ── Inline Diff Display ──────────────────────────────────────────
function computeDiff(oldLines: string[], newLines: string[]): { type: 'same' | 'add' | 'del'; line: string }[] {
  // Simple LCS-based diff for reasonable-sized files
  const N = oldLines.length, M = newLines.length

  // For very large files, fall back to a simple heuristic
  if (N * M > 2_000_000) {
    const result: { type: 'same' | 'add' | 'del'; line: string }[] = []
    for (const l of oldLines) result.push({ type: 'del', line: l })
    for (const l of newLines) result.push({ type: 'add', line: l })
    return result
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0))
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack to produce diff
  const result: { type: 'same' | 'add' | 'del'; line: string }[] = []
  let i = N, j = M
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'same', line: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', line: newLines[j - 1] })
      j--
    } else {
      result.push({ type: 'del', line: oldLines[i - 1] })
      i--
    }
  }
  return result.reverse()
}

function printDiff(filePath: string, oldContent: string | null, newContent: string, cwd: string) {
  const rel = relative(cwd, filePath)
  const header = `  ${c.dim('──')} ${c.cyan(rel)} ${c.dim('─'.repeat(Math.max(2, 50 - rel.length)))}`
  console.log(header)

  if (oldContent === null) {
    // Brand new file
    const lineCount = newContent.split('\n').length
    console.log(`  ${c.green(`+ (new file, ${lineCount} lines)`)}`)
    console.log()
    return
  }

  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const diff = computeDiff(oldLines, newLines)

  // Only show changed lines with some context (up to 3 lines)
  const CONTEXT = 3
  const changedIndices = new Set<number>()
  diff.forEach((d, i) => { if (d.type !== 'same') changedIndices.add(i) })

  if (changedIndices.size === 0) {
    console.log(`  ${c.gray('(no changes)')}`)
    console.log()
    return
  }

  // Expand context around changes
  const visibleIndices = new Set<number>()
  for (const idx of changedIndices) {
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(diff.length - 1, idx + CONTEXT); k++) {
      visibleIndices.add(k)
    }
  }

  let lastPrinted = -1
  let additions = 0, deletions = 0
  const MAX_DIFF_LINES = 200
  let printed = 0

  for (let i = 0; i < diff.length; i++) {
    if (!visibleIndices.has(i)) continue

    if (printed >= MAX_DIFF_LINES) {
      const remaining = Array.from(visibleIndices).filter(idx => idx > i).length
      console.log(c.gray(`    ... (${remaining + changedIndices.size - additions - deletions} more lines, diff capped at ${MAX_DIFF_LINES})`))
      break
    }

    if (lastPrinted !== -1 && i - lastPrinted > 1) {
      console.log(c.gray('    ...'))
    }

    const d = diff[i]
    if (d.type === 'del') {
      console.log(`  ${c.pink(`- ${d.line}`)}`)
      deletions++
    } else if (d.type === 'add') {
      console.log(`  ${c.green(`+ ${d.line}`)}`)
      additions++
    } else {
      console.log(`  ${c.gray(`  ${d.line}`)}`)
    }
    lastPrinted = i
    printed++
  }

  console.log(`  ${c.green(`+${additions}`)} ${c.pink(`-${deletions}`)}`)
  console.log()
}

function execWriteFile(input: Record<string, any>, cwd: string): string {
  const fp = resolvePath(input.path, cwd)
  // Security: block writes outside project root
  if (!isPathAllowed(fp, cwd)) {
    const msg = `BLOCKED: Cannot write outside project root. Path "${input.path}" resolves outside "${cwd}"`
    console.log(`  ${c.pink(`⛔ ${msg}`)}`)
    return msg
  }
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const oldContent = existsSync(fp) ? readFileSync(fp, 'utf8') : null
  fileTracker.recordWrite(fp, input.content)
  writeFileSync(fp, input.content, 'utf8')
  // Show inline diff
  printDiff(fp, oldContent, input.content, cwd)
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

import { spawn } from 'child_process'

async function execSearchFiles(input: Record<string, any>, cwd: string): Promise<string> {
  const dir = resolvePath(input.path || '.', cwd)
  const pattern = input.pattern

  // Try ripgrep first (faster), fallback to manual
  try {
    const args = ['-n', '--max-count=50', '--no-heading']
    if (input.include) args.push('--glob', input.include)
    args.push(pattern, dir)

    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn('rg', args, { shell: true })
      let out = ''
      proc.stdout.on('data', d => out += d.toString())
      proc.on('close', code => {
        if (code === 0 || code === 1) resolve(out.trim() || 'No matches found.')
        else reject(new Error('rg failed'))
      })
      proc.on('error', reject)
    })
    return result
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
  // Security: block dangerous commands
  if (isBlockedCommand(input.command)) {
    const msg = `BLOCKED: Dangerous command rejected: "${input.command}"`
    console.log(`  ${c.pink(`⛔ ${msg}`)}`)
    return msg
  }
  const dir = resolvePath(input.cwd || '.', cwd)

  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd' : 'sh'
  const shellFlag = isWindows ? '/c' : '-c'

  return new Promise((resolve) => {
    const proc = spawn(shell, [shellFlag, input.command], {
      cwd: dir,
      env: { ...process.env, PAGER: 'cat' },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', d => stdout += d.toString())
    proc.stderr.on('data', d => stderr += d.toString())

    const timeout = setTimeout(() => proc.kill(), 30000)

    proc.on('close', code => {
      clearTimeout(timeout)
      let output = ''
      if (stdout.trim()) output += stdout.trim()
      if (stderr.trim()) output += (output ? '\n' : '') + `[stderr] ${stderr.trim()}`
      output += `\n[exit code: ${code}]`
      resolve(output)
    })
    
    proc.on('error', err => {
      clearTimeout(timeout)
      resolve(`[error] Failed to start process: ${err.message}`)
    })
  })
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

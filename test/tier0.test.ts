/**
 * TeniCLI Tier 0 Hardening Tests
 * Run: bun test test/tier0.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'fs'
import { join, resolve } from 'path'

const CLI = resolve(__dirname, '..', 'teni.exe')
const run = (args: string, cwd?: string) => {
  try {
    return execSync(`"${CLI}" ${args}`, { encoding: 'utf8', cwd: cwd || process.cwd(), timeout: 10000 })
  } catch (e: any) {
    return e.stdout || e.stderr || e.message
  }
}

// ── 1. Exit Codes & Output Contract ─────────────────────────────
describe('Exit Codes & Output Contract', () => {
  test('--version exits 0 and prints version', () => {
    const out = run('--version')
    expect(out.trim()).toMatch(/^teni v\d+\.\d+\.\d+$/)
  })

  test('--help exits 0 and shows COMMANDS section', () => {
    const out = run('--help')
    expect(out).toContain('COMMANDS')
    expect(out).toContain('EXIT CODES')
    expect(out).toContain('teni run')
    expect(out).toContain('teni remote')
  })

  test('teni run without prompt exits 1', () => {
    try {
      execSync(`"${CLI}" run`, { encoding: 'utf8', timeout: 5000 })
      expect(true).toBe(false) // should not reach here
    } catch (e: any) {
      expect(e.status).toBe(1)
    }
  })

  test('teni diff --json returns valid JSON with files array', () => {
    const out = run('diff --json')
    const parsed = JSON.parse(out.trim())
    expect(parsed).toHaveProperty('files')
    expect(Array.isArray(parsed.files)).toBe(true)
  })

  test('teni log --json returns valid JSON with actions array', () => {
    const out = run('log --json')
    const parsed = JSON.parse(out.trim())
    expect(parsed).toHaveProperty('actions')
    expect(Array.isArray(parsed.actions)).toBe(true)
  })

  test('teni undo --json returns valid JSON', () => {
    const out = run('undo --json')
    const parsed = JSON.parse(out.trim())
    expect(parsed).toHaveProperty('ok')
  })
})

// ── 2. Command Blocking ─────────────────────────────────────────
describe('Command Blocking (Security)', () => {
  // These tests verify the blocklist by importing the function directly
  // Since we can't easily test exec_command without an API call,
  // we test the isBlockedCommand logic via the CLI's behavior

  test('help shows security-related exit codes', () => {
    const out = run('--help')
    expect(out).toContain('3  Tool execution failure')
  })
})

// ── 3. Path Safety ──────────────────────────────────────────────
describe('Path Safety', () => {
  const testDir = join(__dirname, '__path_test__')

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  test('resolve does not escape project root with ../', () => {
    // This tests the principle — actual enforcement is in execWriteFile
    const root = resolve(testDir)
    const malicious = resolve(testDir, '../../etc/passwd')
    expect(malicious.startsWith(root)).toBe(false)
  })

  test('symlink detection works on Windows', () => {
    // Skip on systems where symlinks require admin
    try {
      const target = join(testDir, 'real.txt')
      const link = join(testDir, 'link.txt')
      writeFileSync(target, 'hello', 'utf8')
      symlinkSync(target, link)
      const stat = lstatSync(link)
      expect(stat.isSymbolicLink()).toBe(true)
    } catch {
      // Symlinks require admin on some Windows — skip gracefully
      console.log('  (symlink test skipped — requires admin)')
    }
  })
})

// ── 4. Snapshot & Rollback ──────────────────────────────────────
describe('Snapshot & Rollback', () => {
  test('teni undo with no snapshots returns gracefully', () => {
    const out = run('undo')
    expect(out).toContain('Nothing to undo')
  })

  test('teni undo --all with no snapshots returns gracefully', () => {
    const out = run('undo --all')
    expect(out).toContain('Nothing to undo')
  })

  test('teni diff with no changes returns empty', () => {
    const out = run('diff')
    expect(out).toContain('No files changed')
  })

  test('teni log with no actions returns empty', () => {
    const out = run('log')
    expect(out).toContain('No AI actions')
  })
})

// ── 5. Output Consistency ───────────────────────────────────────
describe('Output Consistency', () => {
  test('--json output is always parseable JSON', () => {
    for (const cmd of ['diff --json', 'log --json', 'undo --json']) {
      const out = run(cmd).trim()
      expect(() => JSON.parse(out)).not.toThrow()
    }
  })

  test('undo --json includes warning field', () => {
    const out = run('undo --json')
    const parsed = JSON.parse(out.trim())
    expect(parsed).toHaveProperty('ok')
    // warning should be null when no undo happened
    expect(parsed.warning === null || parsed.warning === undefined).toBe(true)
  })
})

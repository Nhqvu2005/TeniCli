// ── Tokyo Night ANSI palette ─────────────────────────────────────
const esc = (c: string) => `\x1b[${c}m`
const w = (c: string, e: string) => (s: string) => `${esc(c)}${s}${esc(e)}`
const fg = (n: number) => (s: string) => `\x1b[38;5;${n}m${s}\x1b[39m`

export const c = {
  bold:    w('1', '22'),
  dim:     w('2', '22'),
  italic:  w('3', '23'),
  under:   w('4', '24'),
  // Tokyo Night mapped to 256-color
  blue:    fg(111),   // #7aa2f7 — primary, prompt
  purple:  fg(141),   // #bb9af7 — AI marker
  green:   fg(149),   // #9ece6a — success
  yellow:  fg(179),   // #e0af68 — tools, warnings
  pink:    fg(210),   // #f7768e — errors
  cyan:    fg(117),   // #7dcfff — paths, links
  gray:    fg(60),    // #565f89 — dim, borders
  text:    fg(146),   // #a9b1d6 — main text
  orange:  fg(215),   // #ff9e64 — accents
}

export const RESET = '\x1b[0m'
export const CLEAR_LINE = '\x1b[2K\r'

// ── Symbols ──────────────────────────────────────────────────────
export const sym = {
  prompt:  c.blue('❯'),
  ai:      c.purple('◆'),
  tool:    c.yellow('⚙'),
  ok:      c.green('✓'),
  err:     c.pink('✗'),
  warn:    c.yellow('⚠'),
  arrow:   c.gray('→'),
  dot:     c.gray('•'),
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
}

// ── Mascot ───────────────────────────────────────────────────────
export function mascot(): string {
  // Use exclusively full blocks (█) to prevent tearing from varying terminal line heights
  const ghost = [
    "  ██  ██  ",
    "██████████",
    "███  ██  █",
    "██████████",
    "██████████",
    " ██ ██ ██ "
  ]

  const textMap = {
    T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
    E: ["████ ", "█    ", "███  ", "█    ", "████ "],
    N: ["█  █ ", "██ █ ", "█ ██ ", "█  █ ", "█  █ "],
    I: ["███", " █ ", " █ ", " █ ", "███"],
    space: ["  ", "  ", "  ", "  ", "  "],
    C: [" ███", "█   ", "█   ", "█   ", " ███"],
    L: ["█   ", "█   ", "█   ", "█   ", "████"]
  }

  const letters = [textMap.T, textMap.E, textMap.N, textMap.I, textMap.space, textMap.C, textMap.L, textMap.I]
  const textLines = ["", "", "", "", ""]
  for (let l = 0; l < 5; l++) {
    textLines[l] = letters.map(letter => letter[l]).join("  ")
  }

  const ghostFormatted = ghost.map(s => c.cyan(s.padEnd(14, ' ')))
  const textFormatted = [
    " ".repeat(textLines[0].length), // align to ghost row 2
    ...textLines
  ].map(s => c.blue(s))

  return ghostFormatted.map((gL, i) => `${gL} ${textFormatted[i] || ''}`).join('\n')
}

// ── Box drawing helpers ──────────────────────────────────────────
const box = {
  h: '─', v: '│',
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  line: (w: number) => '─'.repeat(w),
}

export function drawBox(lines: string[], width = 60) {
  const pad = (s: string, w: number) => {
    // strip ANSI to measure visible length
    const vis = s.replace(/\x1b\[[0-9;]*m/g, '')
    const diff = w - vis.length
    return diff > 0 ? s + ' '.repeat(diff) : s
  }
  console.log(c.gray(`  ${box.tl}${box.line(width)}${box.tr}`))
  for (const line of lines) {
    console.log(c.gray(`  ${box.v}`) + ` ${pad(line, width - 2)} ` + c.gray(box.v))
  }
  console.log(c.gray(`  ${box.bl}${box.line(width)}${box.br}`))
}

// ── Output helpers ───────────────────────────────────────────────
export function header() {
  console.clear()
  console.log()
  console.log(mascot())
  console.log()
  drawBox([
    c.gray('type to chat') + ` ${sym.dot} ` + c.gray('/help for commands') + ` ${sym.dot} ` + c.gray('v0.1.0'),
  ], 60)
  console.log()
}

// ── Spinner ──────────────────────────────────────────────────────
export class Spinner {
  private i = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private msg: string
  constructor(msg = 'Thinking') { this.msg = msg }
  start() {
    this.timer = setInterval(() => {
      process.stdout.write(`${CLEAR_LINE}  ${c.blue(sym.spinner[this.i % sym.spinner.length])} ${c.gray(this.msg)}`)
      this.i++
    }, 80)
    return this
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    process.stdout.write(CLEAR_LINE)
  }
}

// Slash commands for autocomplete
const SLASH_COMMANDS = [
  '/model', '/auth', '/mode', '/compact', '/diff', '/undo',
  '/init', '/update', '/clear', '/cost', '/help', '/exit'
]

export function readLine(prompt: string, enableHints = false): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt)
    
    if (!enableHints || !process.stdin.isTTY) {
      // Simple mode: no autocomplete
      let buf = ''
      const onData = (chunk: any) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (str.charCodeAt(0) === 3) { process.stdout.write('\n'); process.exit(0) }
        if (str.charCodeAt(0) === 4) { cleanup(); reject(new Error('EOF')); return }
        buf += str
        const nl = buf.indexOf('\n')
        if (nl !== -1) { cleanup(); resolve(buf.slice(0, nl).replace(/\r$/, '')) }
      }
      const cleanup = () => { process.stdin.removeListener('data', onData) }
      if (!process.stdin.readableEncoding) process.stdin.setEncoding('utf8')
      process.stdin.on('data', onData)
      process.stdin.resume()
      return
    }

    // Raw mode: character-by-character with autocomplete
    let line = ''
    let hintLen = 0
    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    if (!process.stdin.readableEncoding) process.stdin.setEncoding('utf8')
    process.stdin.resume()

    const clearHint = () => {
      if (hintLen > 0) {
        process.stdout.write(`\x1b[${hintLen}D\x1b[0K`)
        hintLen = 0
      }
    }

    const showHint = () => {
      clearHint()
      if (line.startsWith('/') && line.length > 1) {
        const matches = SLASH_COMMANDS.filter(cmd => cmd.startsWith(line))
        if (matches.length > 0) {
          const rest = matches[0].slice(line.length)
          if (rest) {
            const hint = c.gray(rest)
            process.stdout.write(hint)
            hintLen = rest.length
            // Move cursor back
            process.stdout.write(`\x1b[${rest.length}D`)
          }
        }
      }
    }

    const onData = (chunk: any) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const ch of str) {
        const code = ch.charCodeAt(0)
        
        // Ctrl+C
        if (code === 3) {
          process.stdin.setRawMode(wasRaw)
          process.stdout.write('\n')
          process.exit(0)
        }
        // Ctrl+D
        if (code === 4) {
          clearHint()
          process.stdin.setRawMode(wasRaw)
          cleanup()
          reject(new Error('EOF'))
          return
        }
        // Enter
        if (code === 13 || code === 10) {
          clearHint()
          process.stdin.setRawMode(wasRaw)
          process.stdout.write('\n')
          cleanup()
          resolve(line)
          return
        }
        // Backspace
        if (code === 127 || code === 8) {
          if (line.length > 0) {
            clearHint()
            line = line.slice(0, -1)
            process.stdout.write('\b \b')
            showHint()
          }
          continue
        }
        // Tab — autocomplete
        if (code === 9) {
          if (line.startsWith('/')) {
            const matches = SLASH_COMMANDS.filter(cmd => cmd.startsWith(line))
            if (matches.length > 0) {
              clearHint()
              const rest = matches[0].slice(line.length)
              line = matches[0]
              process.stdout.write(rest)
            }
          }
          continue
        }
        // Ignore other control chars
        if (code < 32) continue
        
        // Regular character
        clearHint()
        line += ch
        process.stdout.write(ch)
        showHint()
      }
    }
    const cleanup = () => { process.stdin.removeListener('data', onData) }
    process.stdin.on('data', onData)
  })
}

export async function readInput(): Promise<string> {
  const lines: string[] = []
  let first = true
  while (true) {
    const p = first
      ? `\n  ${c.gray(box.tl + box.line(3))} ${sym.prompt} `
      : `  ${c.gray(box.v)}    `
    const line = await readLine(p, first)
    first = false
    if (line.endsWith('\\')) { lines.push(line.slice(0, -1)) }
    else { lines.push(line); break }
  }
  return lines.join('\n')
}

// ── Interactive number selector ──────────────────────────────────
export async function selectOption(title: string, options: { label: string; desc?: string }[]): Promise<number> {
  console.log(`\n  ${c.bold(title)}`)
  options.forEach((o, i) => {
    const num = c.blue(`  ${i + 1}.`)
    const desc = o.desc ? c.gray(` (${o.desc})`) : ''
    console.log(`${num} ${o.label}${desc}`)
  })
  while (true) {
    const ans = await readLine(`\n  ${c.gray('choose')} ${c.blue('❯')} `)
    const n = parseInt(ans.trim())
    if (n >= 1 && n <= options.length) return n - 1
    console.log(`  ${sym.warn} enter 1-${options.length}`)
  }
}

// ── Output helpers ───────────────────────────────────────────────

export function toolLog(name: string, detail: string) {
  console.log(`\n  ${sym.tool} ${c.yellow(name)} ${c.gray(detail)}`)
}

export function errorLog(msg: string) {
  console.error(`  ${sym.err} ${c.pink(msg)}`)
}

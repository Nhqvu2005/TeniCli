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
export function header(version = '0.0.0') {
  console.clear()
  console.log()
  console.log(mascot())
  console.log()
  drawBox([
    c.gray('type to chat') + ` ${sym.dot} ` + c.gray('/help for commands') + ` ${sym.dot} ` + c.gray(`v${version}`),
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
  { cmd: '/model',   desc: 'switch AI model' },
  { cmd: '/auth',    desc: 'set API key' },
  { cmd: '/mode',    desc: 'toggle mode' },
  { cmd: '/compact', desc: 'toggle compact' },
  { cmd: '/diff',    desc: 'show file changes' },
  { cmd: '/undo',    desc: 'revert last change' },
  { cmd: '/init',    desc: 'init project context' },
  { cmd: '/remote',  desc: 'start web remote' },
  { cmd: '/update',  desc: 'update tenicli' },
  { cmd: '/clear',   desc: 'clear screen' },
  { cmd: '/cost',    desc: 'show token usage' },
  { cmd: '/help',    desc: 'list commands' },
  { cmd: '/exit',    desc: 'quit' },
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

    // Raw mode: character-by-character with dropdown autocomplete
    let line = ''
    let menuLines = 0   // number of dropdown lines currently rendered
    let selIdx = 0      // currently highlighted item in dropdown
    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    if (!process.stdin.readableEncoding) process.stdin.setEncoding('utf8')
    process.stdin.resume()

    const getMatches = () => {
      if (!line.startsWith('/') || line.length < 1) return []
      return SLASH_COMMANDS.filter(c => c.cmd.startsWith(line))
    }

    const clearMenu = () => {
      if (menuLines > 0) {
        // Clear each line below, then move cursor back up
        for (let i = 0; i < menuLines; i++) {
          process.stdout.write('\x1b[1B')  // move down
          process.stdout.write('\x1b[2K')  // clear entire line
        }
        // Move back up to the input line
        process.stdout.write(`\x1b[${menuLines}A`)
        menuLines = 0
      }
      // Clear any ghost text on current line to the right
      process.stdout.write('\x1b[0K')
    }

    const renderMenu = () => {
      clearMenu()
      const matches = getMatches()
      if (matches.length === 0) return
      if (selIdx >= matches.length) selIdx = matches.length - 1
      if (selIdx < 0) selIdx = 0

      // Save cursor position
      process.stdout.write('\x1b[s')
      for (let i = 0; i < matches.length; i++) {
        process.stdout.write('\n\x1b[2K')  // next line, clear it
        const m = matches[i]
        if (i === selIdx) {
          // Highlighted item: blue background
          process.stdout.write(`    ${c.blue(c.bold(m.cmd))} ${c.gray(m.desc)}`)
        } else {
          process.stdout.write(`    ${c.gray(m.cmd)} ${c.gray(c.dim(m.desc))}`)
        }
      }
      menuLines = matches.length
      // Restore cursor position back to input line
      process.stdout.write('\x1b[u')
    }

    let escBuf = ''
    const onData = (chunk: any) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (let ci = 0; ci < str.length; ci++) {
        const ch = str[ci]
        const code = ch.charCodeAt(0)

        // Handle escape sequences (arrow keys)
        if (escBuf.length > 0 || code === 27) {
          escBuf += ch
          if (escBuf.length === 1) continue // wait for more
          if (escBuf.length === 2 && escBuf[1] === '[') continue // wait for more
          if (escBuf.length >= 3) {
            const matches = getMatches()
            if (escBuf === '\x1b[A' && matches.length > 0) { // Up
              selIdx = (selIdx - 1 + matches.length) % matches.length
              renderMenu()
            } else if (escBuf === '\x1b[B' && matches.length > 0) { // Down
              selIdx = (selIdx + 1) % matches.length
              renderMenu()
            }
            escBuf = ''
            continue
          }
          continue
        }

        // Ctrl+C
        if (code === 3) {
          clearMenu()
          process.stdin.setRawMode(wasRaw)
          process.stdout.write('\n')
          process.exit(0)
        }
        // Ctrl+D
        if (code === 4) {
          clearMenu()
          process.stdin.setRawMode(wasRaw)
          cleanup()
          reject(new Error('EOF'))
          return
        }
        // Enter
        if (code === 13 || code === 10) {
          const matches = getMatches()
          // If dropdown is visible and a match is selected, accept it
          if (matches.length > 0 && line !== matches[selIdx].cmd) {
            clearMenu()
            const selected = matches[selIdx].cmd
            // Erase current typed text and write selected command
            process.stdout.write('\b \b'.repeat(line.length))
            line = selected
            process.stdout.write(line)
          }
          clearMenu()
          process.stdin.setRawMode(wasRaw)
          process.stdout.write('\n')
          cleanup()
          resolve(line)
          return
        }
        // Backspace
        if (code === 127 || code === 8) {
          if (line.length > 0) {
            clearMenu()
            line = line.slice(0, -1)
            process.stdout.write('\b \b')
            selIdx = 0
            renderMenu()
          }
          continue
        }
        // Tab — accept selected completion
        if (code === 9) {
          const matches = getMatches()
          if (matches.length > 0) {
            clearMenu()
            const selected = matches[selIdx].cmd
            const rest = selected.slice(line.length)
            line = selected
            process.stdout.write(rest)
            renderMenu()
          }
          continue
        }
        // Ignore other control chars
        if (code < 32) continue
        
        // Regular character
        clearMenu()
        line += ch
        process.stdout.write(ch)
        selIdx = 0
        renderMenu()
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
  // Always show Cancel as last option
  console.log(`  ${c.gray(`  0. Cancel`)}`)
  while (true) {
    const ans = await readLine(`\n  ${c.gray('choose')} ${c.blue('❯')} `)
    const t = ans.trim().toLowerCase()
    if (t === '0' || t === 'q' || t === 'cancel' || t === 'exit' || t === '') return -1
    const n = parseInt(t)
    if (n >= 1 && n <= options.length) return n - 1
    console.log(`  ${sym.warn} enter 1-${options.length} or 0 to cancel`)
  }
}

// ── Output helpers ───────────────────────────────────────────────

export function toolLog(name: string, detail: string) {
  console.log(`\n  ${sym.tool} ${c.yellow(name)} ${c.gray(detail)}`)
}

export function errorLog(msg: string) {
  console.error(`  ${sym.err} ${c.pink(msg)}`)
}

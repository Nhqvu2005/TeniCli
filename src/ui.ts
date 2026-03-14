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

// ── Vietnamese-safe UTF-8 input ──────────────────────────────────
export function readLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt)
    let buf = ''
    const onData = (chunk: any) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Ctrl+C
      if (str.charCodeAt(0) === 3) { process.stdout.write('\n'); process.exit(0) }
      // Ctrl+D (EOF)
      if (str.charCodeAt(0) === 4) { cleanup(); reject(new Error('EOF')); return }
      buf += str
      const nl = buf.indexOf('\n')
      if (nl !== -1) { cleanup(); resolve(buf.slice(0, nl).replace(/\r$/, '')) }
    }
    const cleanup = () => { process.stdin.removeListener('data', onData) }
    if (!process.stdin.readableEncoding) process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

export async function readInput(): Promise<string> {
  const lines: string[] = []
  let first = true
  while (true) {
    const p = first
      ? `\n  ${c.gray(box.tl + box.line(3))} ${sym.prompt} `
      : `  ${c.gray(box.v)}    `
    const line = await readLine(p)
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

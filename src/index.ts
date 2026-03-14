#!/usr/bin/env node
import { loadConfig, loadStoredConfig, saveStoredConfig, MODELS, type ProviderType } from './config'
import { ChatSession } from './chat'
import { fileTracker } from './tools'
import { header, readInput, readLine, selectOption, drawBox, c, sym, errorLog } from './ui'
import { writeFileSync, existsSync } from 'fs'
import { join, relative } from 'path'

import pkg from '../package.json'
const VERSION = pkg.version

// ── Args ─────────────────────────────────────────────────────────
function parseArgs(args: string[]) {
  const o: Record<string, any> = { prompt: '', print: false }
  let i = 0
  while (i < args.length) {
    switch (args[i]) {
      case '-p': case '--print':
        o.print = true
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) o.prompt = args[++i]
        break
      case '-m': case '--model': o.model = args[++i]; break
      case '--base-url': o.baseUrl = args[++i]; break
      case '-v': case '--version': console.log(`teni v${VERSION}`); process.exit(0)
      case '-h': case '--help': showHelp(); process.exit(0)
      default:
        if (!args[i].startsWith('-')) { o.prompt = args.slice(i).join(' '); i = args.length }
    }
    i++
  }
  return o
}

function showHelp() {
  console.log(`
${c.bold(c.blue('TeniCLI'))} — Lightweight AI Coding Agent

${c.bold('USAGE')}
  teni                     Start chatting
  teni "prompt"            Start with a prompt
  teni -p "prompt"         Non-interactive mode

${c.bold('OPTIONS')}
  -p, --print <prompt>  Print response and exit
  -m, --model <model>   Override model
  --base-url <url>      Override API base URL
  -v, --version         Show version
  -h, --help            Show help

${c.bold('IN-CHAT')}
  /model   Select model     /auth    Set API key
  /mode    Ask/Auto toggle  /compact Summarize chat
  /diff    Files changed    /undo    Revert last write
  /init    Create TENICLI.md  /clear New conversation
  /cost    Token usage      /exit    Quit
  \\\\       Multiline input
`)
}

// ── Slash commands ───────────────────────────────────────────────
async function handleCommand(cmd: string, session: ChatSession): Promise<boolean> {
  switch (cmd.toLowerCase().split(' ')[0]) {
    case '/exit': case '/quit': case '/q':
      console.log(`\n  ${c.gray('Bye!')} 👋\n`)
      process.exit(0)

    case '/clear':
      session.clear()
      fileTracker.clear()
      console.log(`  ${sym.ok} Conversation cleared`)
      return true

    case '/compact':
      await session.compact()
      return true

    case '/diff': {
      const changes = fileTracker.getChanges()
      if (changes.length === 0) {
        console.log(`  ${c.gray('No files changed in this session.')}`)
      } else {
        console.log(`\n  ${c.bold('Files changed this session:')}`)
        for (const f of changes) {
          const rel = relative(session.cfg.cwd, f.path)
          const tag = f.isNew ? c.green('[NEW]') : c.yellow('[MOD]')
          console.log(`    ${tag} ${c.cyan(rel)} ${c.gray(`(${f.lines} lines)`)}`)
        }
        console.log(`  ${c.gray(`total: ${changes.length} files`)}`)
      }
      return true
    }

    case '/undo': {
      const result = fileTracker.undo()
      if (!result) {
        console.log(`  ${c.gray('Nothing to undo.')}`)
      } else {
        const rel = relative(session.cfg.cwd, result.path)
        if (result.restored) {
          console.log(`  ${sym.ok} Restored: ${c.cyan(rel)}`)
        } else {
          console.log(`  ${sym.ok} Deleted (was new): ${c.cyan(rel)}`)
        }
      }
      return true
    }

    case '/init': {
      const mdPath = join(session.cfg.cwd, 'TENICLI.md')
      if (existsSync(mdPath)) {
        console.log(`  ${sym.warn} TENICLI.md already exists.`)
      } else {
        writeFileSync(mdPath, TENICLI_TEMPLATE, 'utf8')
        console.log(`  ${sym.ok} Created ${c.cyan('TENICLI.md')}`)
      }
      return true
    }

    case '/mode': {
      session.autoMode = !session.autoMode
      const label = session.autoMode ? c.yellow('auto') : c.green('ask')
      console.log(`  ${sym.ok} Mode: ${label} ${c.gray(session.autoMode ? '(tools run without asking)' : '(confirm write/exec)')}`)
      return true
    }

    case '/cost': {
      const s = session.stats
      console.log(`  ${sym.ai} ${c.blue(String(s.input))}↑ input  ${c.blue(String(s.output))}↓ output  ${c.gray(`(${session.messageCount} msgs)`)}`)
      return true
    }

    case '/model': {
      const options = MODELS.map(m => ({
        label: `${m.name} ${session.cfg.provider.model === m.id ? c.green('●') : ''}`,
        desc: `${m.provider} • ${m.speed}`,
      }))
      options.push({ label: 'Custom model...', desc: 'type model ID' })

      const idx = await selectOption('Select model', options)

      if (idx < MODELS.length) {
        const m = MODELS[idx]
        session.cfg.provider.model = m.id
        session.cfg.provider.type = m.provider

        // Update base URL if provider changed
        const stored = loadStoredConfig()
        const key = m.provider === 'openai'
          ? (process.env.OPENAI_API_KEY || stored.keys?.openai || '')
          : (process.env.ANTHROPIC_API_KEY || stored.keys?.anthropic || '')
        if (key) session.cfg.provider.apiKey = key

        if (!stored.baseUrls?.[m.provider]) {
          session.cfg.provider.baseUrl = m.provider === 'openai'
            ? 'https://api.openai.com'
            : 'https://api.anthropic.com'
        }

        saveStoredConfig({ activeModel: m.id })
        console.log(`  ${sym.ok} Model: ${c.blue(m.name)}`)
      } else {
        const custom = await readLine(`  ${c.gray('model ID')} ${c.blue('❯')} `)
        if (custom.trim()) {
          session.cfg.provider.model = custom.trim()
          saveStoredConfig({ activeModel: custom.trim() })
          console.log(`  ${sym.ok} Model: ${c.blue(custom.trim())}`)
        }
      }
      return true
    }

    case '/auth': {
      const providerIdx = await selectOption('Provider', [
        { label: 'Anthropic', desc: 'Claude models' },
        { label: 'OpenAI', desc: 'GPT models' },
        { label: 'Custom', desc: 'Anthropic-compatible proxy' },
      ])

      const providerNames: ProviderType[] = ['anthropic', 'openai', 'anthropic']
      const provider = providerNames[providerIdx]

      const key = await readLine(`  ${c.gray('API Key')} ${c.blue('❯')} `)
      if (!key.trim()) { console.log(`  ${sym.warn} Cancelled`); return true }

      const keys: Record<string, string> = { [provider]: key.trim() }
      const baseUrls: Record<string, string> = {}

      if (providerIdx === 2) {
        // Custom provider — ask for base URL
        const url = await readLine(`  ${c.gray('Base URL')} ${c.blue('❯')} `)
        if (url.trim()) baseUrls[provider] = url.trim()
      }

      saveStoredConfig({ keys, baseUrls })

      // Apply immediately
      session.cfg.provider.apiKey = key.trim()
      session.cfg.provider.type = provider
      if (baseUrls[provider]) session.cfg.provider.baseUrl = baseUrls[provider]

      console.log(`  ${sym.ok} ${provider} key saved to ~/.tenicli/config.json`)
      return true
    }

    case '/help':
      console.log(`
  ${c.bold('Commands')}
    ${c.blue('/model')}    Select AI model
    ${c.blue('/auth')}     Set API key
    ${c.blue('/mode')}     Toggle ask/auto ${c.gray('(confirm before write/exec)')}
    ${c.blue('/compact')}  Summarize conversation ${c.gray('(save tokens)')}
    ${c.blue('/diff')}     List files changed this session
    ${c.blue('/undo')}     Revert last file write
    ${c.blue('/init')}     Create TENICLI.md template
    ${c.blue('/update')}   Update to latest version
    ${c.blue('/clear')}    New conversation
    ${c.blue('/cost')}     Show token usage
    ${c.blue('/exit')}     Quit
    ${c.gray('\\\\')}         Continue on next line`)
      return true

    case '/update': {
      console.log(`\n  ${sym.tool} ${c.yellow('Checking for updates...')}`)
      try {
        const { execSync } = await import('child_process')
        const result = execSync('npm i -g tenicli@latest 2>&1', { encoding: 'utf8' })
        console.log(`  ${sym.ok} ${c.green('Updated!')} Restart teni to use the new version.`)
        console.log(c.gray(`  ${result.trim().split('\n').pop()}`))
      } catch (e: any) {
        errorLog(`Update failed: ${e.message}`)
      }
      return true
    }

    default:
      console.log(`  ${sym.warn} Unknown: ${cmd.split(' ')[0]} — try /help`)
      return true
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig()
  if (args.model) cfg.provider.model = args.model
  if (args.baseUrl) cfg.provider.baseUrl = args.baseUrl

  const session = new ChatSession(cfg)

  // Non-interactive
  if (args.print && args.prompt) {
    if (!cfg.provider.apiKey) { errorLog('No API key. Run: teni then /auth'); process.exit(1) }
    await session.send(args.prompt)
    process.exit(0)
  }

  // Interactive — go straight to chat
  header(VERSION)
  const modelName = MODELS.find(m => m.id === cfg.provider.model)?.name || cfg.provider.model
  const modeLabel = session.autoMode ? c.yellow('auto') : c.green('ask')
  
  const statusLines = [
    `${c.gray('model')} ${c.blue(modelName)}  ${c.gray('mode')} ${modeLabel}  ${c.gray('cwd')} ${c.cyan(cfg.cwd)}`,
  ]
  if (!cfg.provider.apiKey) {
    statusLines.push('')
    statusLines.push(`${sym.warn} ${c.yellow('No API key configured. Run /auth to set one.')}`)
  }
  drawBox(statusLines, 60)
  console.log()

  // Send initial prompt if provided
  if (args.prompt) {
    console.log(` ${sym.prompt} ${args.prompt}`)
    if (cfg.provider.apiKey) await session.send(args.prompt)
  }

  // Chat loop
  while (true) {
    try {
      const input = await readInput()
      const trimmed = input.trim()
      if (!trimmed) continue

      if (trimmed.startsWith('/')) {
        await handleCommand(trimmed, session)
        continue
      }

      if (!session.cfg.provider.apiKey) {
        console.log(`  ${sym.warn} ${c.yellow('No API key. Run /auth first.')}`)
        continue
      }

      await session.send(trimmed)
    } catch (e: any) {
      if (e.message === 'EOF') { console.log(`\n  ${c.gray('Bye!')} 👋\n`); process.exit(0) }
      errorLog(e.message)
    }
  }
}

main().catch(e => { errorLog(e.message); process.exit(1) })

// ── TENICLI.md template ──────────────────────────────────────────
const TENICLI_TEMPLATE = `# Project Instructions

## Overview
Describe your project here so the AI understands the context.

## Tech Stack
- Language:
- Framework:
- Database:

## Coding Rules
- Follow existing code style
- Write tests for new features
- Use descriptive variable names

## File Structure
Describe important files and directories.

## Notes
Any special instructions or constraints.
`


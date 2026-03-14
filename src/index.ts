#!/usr/bin/env node
import { loadConfig, loadStoredConfig, saveStoredConfig, MODELS, type ProviderType } from './config'
import { ChatSession } from './chat'
import { lastRateLimits, type RateLimits } from './provider'
import { fileTracker } from './tools'
import { header, readInput, readLine, selectOption, drawBox, c, sym, errorLog } from './ui'
import { writeFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { randomBytes } from 'crypto'
import { saveConversation, loadConversation, listConversations, createConversation, saveSessionState, loadSessionState, type ConversationRecord } from './history'

import pkg from '../package.json'
const VERSION = pkg.version

// ── Args ─────────────────────────────────────────────────────────
function parseArgs(args: string[]) {
  const o: Record<string, any> = { prompt: '', print: false }
  let i = 0
  while (i < args.length) {
    switch (args[i]) {
      case 'serve':
        o.serve = true
        break
      case '--port': o.port = parseInt(args[++i]); break
      case '--password': o.password = args[++i]; break
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
  teni serve               Start web remote server

${c.bold('OPTIONS')}
  -p, --print <prompt>  Print response and exit
  -m, --model <model>   Override model
  --base-url <url>      Override API base URL
  -v, --version         Show version
  -h, --help            Show help

${c.bold('SERVE OPTIONS')}
  --port <port>         Server port (default: 3000)
  --password <pw>       Access password (auto-generated if omitted)

${c.bold('IN-CHAT')}
  /model   Select model     /auth    Set API key
  /mode    Ask/Auto toggle  /compact Summarize chat
  /diff    Files changed    /undo    Revert last write
  /init    Create TENICLI.md  /clear New conversation
  /update  Update tenicli   /cost    Token usage
  /exit    Quit             \\\\       Multiline input
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
      const stored = loadStoredConfig()
      const customModels = stored.customModels || []

      // Build full model list: built-in + custom
      const allModels = [
        ...MODELS.map(m => ({ id: m.id, name: m.name, provider: m.provider, speed: m.speed, custom: false })),
        ...customModels.map(cm => ({ id: cm.id, name: cm.id, provider: cm.provider, speed: 'custom' as const, custom: true })),
      ]

      const options = allModels.map(m => ({
        label: `${m.name} ${session.cfg.provider.model === m.id ? c.green('●') : ''}`,
        desc: `${m.provider} • ${m.speed}`,
      }))
      options.push({ label: 'Custom model...', desc: 'type model ID' })

      const idx = await selectOption('Select model', options)
      if (idx === -1) { console.log(`  ${c.gray('Cancelled')}`); return true }

      if (idx < allModels.length) {
        const m = allModels[idx]
        session.cfg.provider.model = m.id
        session.cfg.provider.type = m.provider

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
        // Custom model
        const provIdx = await selectOption('Provider for custom model', [
          { label: 'Anthropic', desc: 'Claude-compatible' },
          { label: 'OpenAI', desc: 'GPT-compatible' },
        ])
        if (provIdx === -1) { console.log(`  ${c.gray('Cancelled')}`); return true }

        const provType: ProviderType = provIdx === 0 ? 'anthropic' : 'openai'
        const custom = await readLine(`  ${c.gray('model ID')} ${c.blue('❯')} `)
        if (!custom.trim()) { console.log(`  ${c.gray('Cancelled')}`); return true }

        const modelId = custom.trim()
        session.cfg.provider.model = modelId
        session.cfg.provider.type = provType

        // Save custom model to list (no duplicates)
        const existing = customModels.filter(cm => cm.id !== modelId)
        existing.push({ id: modelId, provider: provType })
        saveStoredConfig({ activeModel: modelId, customModels: existing })

        const key = provType === 'openai'
          ? (process.env.OPENAI_API_KEY || stored.keys?.openai || '')
          : (process.env.ANTHROPIC_API_KEY || stored.keys?.anthropic || '')
        if (key) session.cfg.provider.apiKey = key

        console.log(`  ${sym.ok} Model: ${c.blue(modelId)} ${c.gray(`(saved to list)`)}`)
      }
      return true
    }

    case '/auth': {
      const providerIdx = await selectOption('Provider', [
        { label: 'Anthropic', desc: 'Claude models' },
        { label: 'OpenAI', desc: 'GPT models' },
        { label: 'Custom', desc: 'Anthropic-compatible proxy' },
      ])
      if (providerIdx === -1) { console.log(`  ${c.gray('Cancelled')}`); return true }

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
    ${c.blue('/remote')}   Start web remote access
    ${c.blue('/history')}  Browse past conversations
    ${c.blue('/quota')}    Show API rate limits
    ${c.blue('/update')}   Update to latest version
    ${c.blue('/clear')}    New conversation
    ${c.blue('/cost')}     Show token usage
    ${c.blue('/exit')}     Quit
    ${c.gray('\\\\')}         Continue on next line`)
      return true

    case '/remote': {
      const { getLocalIPs } = await import('./qr')
      const { startServer, getActiveServers } = await import('./server')
      const servers = getActiveServers()

      if (servers.size > 0) {
        // Show active servers + option to add new
        const opts = Array.from(servers.entries()).map(([port, s]) => ({
          label: `Port ${port} ${c.green('\u25cf')}`,
          desc: `password: ${s.password}`,
        }))
        opts.push({ label: c.cyan('+ New server'), desc: 'start on random port' })
        opts.push({ label: c.yellow('Stop all'), desc: 'close all remote servers' })

        const idx = await selectOption('Remote servers', opts)
        if (idx === -1) { console.log(`  ${c.gray('Cancelled')}`); return true }

        if (idx < servers.size) {
          // Show info about existing server
          const entry = Array.from(servers.entries())[idx]
          const ips = getLocalIPs()
          const ip = ips[0] || 'localhost'
          console.log(`\n  ${c.gray('URL:')} ${c.cyan(`http://${ip}:${entry[0]}`)}`)
          console.log(`  ${c.gray('Password:')} ${c.yellow(entry[1].password)}`)
          return true
        } else if (idx === servers.size) {
          // Fall through to create new
        } else {
          // Stop all
          for (const [port, s] of servers) { s.close() }
          console.log(`  ${sym.ok} All remote servers stopped`)
          return true
        }
      }

      // Create new server on random port
      const port = 3000 + Math.floor(Math.random() * 7000) // 3000-9999
      const password = randomBytes(6).toString('hex')
      const ips = getLocalIPs()
      const localIP = ips[0] || 'localhost'
      const url = `http://${localIP}:${port}`

      startServer(port, password)

      console.log()
      drawBox([
        c.bold(c.green('Remote Access Enabled')),
        '',
        `${c.gray('URL:')}      ${c.cyan(url)}`,
        `${c.gray('Password:')} ${c.yellow(password)}`,
        `${c.gray('Port:')}     ${c.blue(String(port))}`,
        '',
        c.gray('Anyone on the same WiFi can access this URL.'),
        c.gray('Use /remote again to manage servers.'),
      ], 58)
      console.log()
      return true
    }

    case '/quota': {
      const rl = lastRateLimits
      if (!rl.requestsLimit && !rl.tokensLimit) {
        console.log(`  ${c.gray('No rate limit data yet. Send a message first.')}`)
        return true
      }

      const lines: string[] = [c.bold('API Rate Limits'), '']
      if (rl.requestsLimit !== undefined) {
        const used = rl.requestsLimit - (rl.requestsRemaining || 0)
        const pct = Math.round((rl.requestsRemaining || 0) / rl.requestsLimit * 100)
        const color = pct > 50 ? c.green : pct > 20 ? c.yellow : c.pink
        lines.push(`${c.gray('Requests:')}  ${color(String(rl.requestsRemaining))}/${rl.requestsLimit} remaining ${c.gray(`(${pct}%)`)}`)
      }
      if (rl.tokensLimit !== undefined) {
        const pct = Math.round((rl.tokensRemaining || 0) / rl.tokensLimit * 100)
        const color = pct > 50 ? c.green : pct > 20 ? c.yellow : c.pink
        lines.push(`${c.gray('Tokens:')}    ${color(String(rl.tokensRemaining?.toLocaleString()))}/${rl.tokensLimit.toLocaleString()} remaining ${c.gray(`(${pct}%)`)}`)
      }
      if (rl.requestsReset) {
        const reset = new Date(rl.requestsReset)
        lines.push(`${c.gray('Resets at:')} ${c.cyan(reset.toLocaleTimeString())}`)
      }

      console.log()
      drawBox(lines, 58)
      return true
    }

    case '/history': {
      const convs = listConversations()
      if (convs.length === 0) {
        console.log(`  ${c.gray('No saved conversations.')}`)
        return true
      }
      const options = convs.slice(0, 10).map(cv => ({
        label: cv.title.slice(0, 40),
        desc: `${cv.model} • ${new Date(cv.updatedAt).toLocaleDateString()}`,
      }))
      const idx = await selectOption('Resume conversation', options)
      if (idx === -1) { console.log(`  ${c.gray('Cancelled')}`); return true }

      const conv = convs[idx]
      session.clear()
      session.importState({ messages: conv.messages, tokens: conv.tokens })
      // Store conversation ID on session for auto-save
      ;(session as any).__convId = conv.id
      console.log(`  ${sym.ok} Restored: ${c.blue(conv.title)} ${c.gray(`(${conv.messages.length} msgs)`)}`)
      return true
    }

    case '/update': {
      console.log(`\n  ${sym.tool} ${c.yellow('Updating tenicli...')}`)
      try {
        // Save current session for restore after restart
        const state = session.exportState()
        const conv = createConversation(session.cfg.provider.model)
        conv.title = session.getTitle()
        conv.messages = state.messages
        conv.tokens = state.tokens
        saveSessionState(conv)

        const { execSync, spawn } = await import('child_process')
        execSync('npm i -g tenicli@latest 2>&1', { encoding: 'utf8' })
        console.log(`  ${sym.ok} ${c.green('Updated! Restarting...')}\n`)

        // Restart the process
        const child = spawn(process.execPath, process.argv.slice(1), {
          stdio: 'inherit',
          detached: false,
        })
        child.on('exit', (code) => process.exit(code || 0))
        // Prevent the parent from keeping the event loop alive
        return true
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

  // Serve mode — start web server
  if (args.serve) {
    const port = args.port || 3000
    const password = args.password || randomBytes(6).toString('hex')
    const { startServer } = await import('./server')
    startServer(port, password)
    return
  }

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

  // Check for session restore (after /update auto-reload)
  const resumed = loadSessionState()
  let currentConv = createConversation(cfg.provider.model)

  if (resumed) {
    session.importState({ messages: resumed.messages, tokens: resumed.tokens })
    currentConv = resumed
    console.log(`  ${sym.ok} ${c.green('Session restored after update')} ${c.gray(`(${resumed.messages.length} msgs)`)}`)
    console.log()
  }

  // Auto-save helper
  const autoSave = () => {
    if (session.messageCount === 0) return
    const state = session.exportState()
    currentConv.title = session.getTitle()
    currentConv.messages = state.messages
    currentConv.tokens = state.tokens
    currentConv.model = cfg.provider.model
    currentConv.updatedAt = new Date().toISOString()
    saveConversation(currentConv)
  }

  // Save on exit
  process.on('SIGINT', () => { autoSave(); console.log(`\n  ${c.gray('Bye!')} 👋\n`); process.exit(0) })

  // Send initial prompt if provided
  if (args.prompt) {
    console.log(` ${sym.prompt} ${args.prompt}`)
    if (cfg.provider.apiKey) await session.send(args.prompt)
    autoSave()
  }

  // Chat loop
  while (true) {
    try {
      const input = await readInput()
      const trimmed = input.trim()
      if (!trimmed) continue

      if (trimmed.startsWith('/')) {
        if (trimmed === '/clear') {
          autoSave()  // save before clearing
          currentConv = createConversation(cfg.provider.model)  // new conv
        }
        await handleCommand(trimmed, session)
        continue
      }

      if (!session.cfg.provider.apiKey) {
        console.log(`  ${sym.warn} ${c.yellow('No API key. Run /auth first.')}`)
        continue
      }

      await session.send(trimmed)
      autoSave()  // save after each response
    } catch (e: any) {
      if (e.message === 'EOF') { autoSave(); console.log(`\n  ${c.gray('Bye!')} 👋\n`); process.exit(0) }
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


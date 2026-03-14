import { streamChat, type Message, type ContentBlock, type ChatEvent } from './provider'
import { executeTool, TOOLS } from './tools'
import { c, sym, Spinner, toolLog, errorLog, readLine } from './ui'
import type { Config } from './config'

export class ChatSession {
  private messages: Message[] = []
  private tokens = { input: 0, output: 0 }
  cfg: Config
  autoMode = false  // false = ask before tool exec, true = auto

  constructor(cfg: Config) { this.cfg = cfg }

  async send(userText: string): Promise<void> {
    this.messages.push({ role: 'user', content: userText })
    await this.agentLoop()
  }

  // ── Agentic loop ───────────────────────────────────────────────
  private async agentLoop(): Promise<void> {
    while (true) {
      const result = await this.streamResponse()

      if (result.stopReason === 'tool_use') {
        const toolBlocks = result.content.filter(b => b.type === 'tool_use')
        const toolResults: ContentBlock[] = []

        for (const block of toolBlocks) {
          // Ask mode: confirm before executing write/exec tools
          if (!this.autoMode && (block.name === 'write_file' || block.name === 'exec_command')) {
            const inputPreview = block.name === 'write_file'
              ? block.input?.path
              : block.input?.command?.slice(0, 80)
            console.log(`\n  ${sym.warn} ${c.yellow(block.name!)} ${c.gray(inputPreview || '')}`)
            const ans = await readLine(`  ${c.gray('allow?')} ${c.blue('[y/n/auto]')} `)
            const a = ans.trim().toLowerCase()
            if (a === 'auto') { this.autoMode = true }
            else if (a !== 'y' && a !== 'yes' && a !== '') {
              toolResults.push({
                type: 'tool_result', tool_use_id: block.id,
                content: 'User denied this action.', is_error: true,
              })
              continue
            }
          }

          const res = await executeTool(block.name!, block.input!, this.cfg.cwd)
          toolResults.push({
            type: 'tool_result', tool_use_id: block.id,
            content: res.content, is_error: res.is_error,
          })
        }

        this.messages.push({ role: 'assistant', content: result.content })
        this.messages.push({ role: 'user', content: toolResults })
        continue
      }

      const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('')
      if (text) this.messages.push({ role: 'assistant', content: text })
      break
    }

    console.log(`\n  ${c.gray(`tokens: ${this.tokens.input}↑ ${this.tokens.output}↓`)}`)
  }

  // ── Stream and parse unified events ────────────────────────────
  private async streamResponse(): Promise<{ content: ContentBlock[]; stopReason: string }> {
    const spinner = new Spinner('Thinking').start()
    const content: ContentBlock[] = []
    let currentText = ''
    let currentToolId = ''
    let currentToolName = ''
    let toolJsonBuf = ''
    let stopReason = 'end_turn'
    let started = false

    try {
      const stream = streamChat(
        this.cfg.provider, this.messages, this.cfg.systemPrompt,
        TOOLS, this.cfg.maxTokens,
      )

      for await (const ev of stream) {
        switch (ev.type) {
          case 'text':
            if (!started) { spinner.stop(); started = true; process.stdout.write(`\n  ${sym.ai} `) }
            if (ev.text) process.stdout.write(ev.text)
            currentText += ev.text
            break
          case 'tool_start':
            if (!started) { spinner.stop(); started = true }
            if (currentText) { content.push({ type: 'text', text: currentText }); currentText = '' }
            currentToolId = ev.id; currentToolName = ev.name; toolJsonBuf = ''
            break
          case 'tool_input':
            toolJsonBuf += ev.partial
            break
          case 'tool_end':
            if (currentToolId) {
              let input = {}
              try { input = JSON.parse(toolJsonBuf) } catch {}
              content.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input })
              currentToolId = ''; toolJsonBuf = ''
            }
            break
          case 'usage':
            this.tokens.input += ev.input; this.tokens.output += ev.output
            break
          case 'done':
            stopReason = ev.stopReason
            break
        }
      }
    } catch (err: any) {
      spinner.stop(); errorLog(err.message)
      return { content: [], stopReason: 'error' }
    }

    if (currentText) { content.push({ type: 'text', text: currentText }); process.stdout.write('\n') }
    if (!started) spinner.stop()
    return { content, stopReason }
  }

  // ── Compact: summarize history to save tokens ──────────────────
  async compact(): Promise<void> {
    if (this.messages.length < 4) {
      console.log(`  ${sym.warn} Not enough messages to compact.`)
      return
    }

    const spinner = new Spinner('Compacting').start()
    try {
      // Build summary of conversation so far
      let textHistory = ''
      for (const m of this.messages) {
        if (typeof m.content === 'string') {
          textHistory += `${m.role}: ${m.content.slice(0, 500)}\n`
        } else {
          const texts = (m.content as ContentBlock[])
            .filter(b => b.type === 'text')
            .map(b => b.text?.slice(0, 300))
            .join(' ')
          if (texts) textHistory += `${m.role}: ${texts}\n`
          const tools = (m.content as ContentBlock[])
            .filter(b => b.type === 'tool_use')
            .map(b => `[tool: ${b.name}]`)
            .join(', ')
          if (tools) textHistory += `  tools: ${tools}\n`
        }
      }

      const oldCount = this.messages.length
      const summaryPrompt = `Summarize this conversation concisely. Keep key decisions, file changes, and current state. Be brief:\n\n${textHistory.slice(0, 6000)}`

      // Reset messages to just the summary
      this.messages = [
        { role: 'user', content: summaryPrompt },
        { role: 'assistant', content: `[Conversation compacted from ${oldCount} messages. Summary of what happened:]` },
      ]

      // Actually get a summary from the API
      const stream = streamChat(
        this.cfg.provider,
        [{ role: 'user', content: summaryPrompt }],
        'You are a conversation summarizer. Create a brief summary preserving key facts, decisions, and file changes.',
        [], this.cfg.maxTokens,
      )

      let summary = ''
      for await (const ev of stream) {
        if (ev.type === 'text' && ev.text) summary += ev.text
        if (ev.type === 'usage') { this.tokens.input += ev.input; this.tokens.output += ev.output }
      }

      this.messages = [
        { role: 'user', content: `[Previous conversation summary]\n${summary}` },
        { role: 'assistant', content: 'Understood. I have the context from our previous conversation. How can I continue helping you?' },
      ]

      spinner.stop()
      console.log(`  ${sym.ok} Compacted ${oldCount} messages → 2 ${c.gray(`(saved ~${Math.round(textHistory.length / 4)} tokens)`)}`)
    } catch (e: any) {
      spinner.stop()
      errorLog(`Compact failed: ${e.message}`)
    }
  }

  get stats() { return this.tokens }
  get messageCount() { return this.messages.length }

  clear() {
    this.messages = []
    this.tokens = { input: 0, output: 0 }
  }
}


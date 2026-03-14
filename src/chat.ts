import { streamChat, type Message, type ContentBlock, type ChatEvent } from './provider'
import { executeTool, TOOLS } from './tools'
import { c, sym, Spinner, toolLog, errorLog, readLine } from './ui'
import type { Config } from './config'

// Output events that can be relayed to WebSocket or TTY
export type SessionEvent =
  | { type: 'text'; text: string }       // AI response text (streaming)
  | { type: 'text_done' }                // AI finished responding
  | { type: 'tool'; name: string; detail: string }
  | { type: 'tool_result'; name: string; content: string; is_error: boolean }
  | { type: 'tokens'; input: number; output: number; messages: number }
  | { type: 'error'; message: string }
  | { type: 'confirm'; id: string; tool: string; preview: string } // ask mode: needs user approval

export class ChatSession {
  private messages: Message[] = []
  private tokens = { input: 0, output: 0 }
  cfg: Config
  autoMode = false
  onOutput?: (ev: SessionEvent) => void             // for WebSocket relay
  onConfirm?: (id: string, tool: string, preview: string) => Promise<string>  // for remote approval

  constructor(cfg: Config) { this.cfg = cfg }

  private emit(ev: SessionEvent) { this.onOutput?.(ev) }

  private write(text: string) {
    if (this.onOutput) this.emit({ type: 'text', text })
    else process.stdout.write(text)
  }

  private log(text: string) {
    if (this.onOutput) this.emit({ type: 'text', text: text + '\n' })
    else console.log(text)
  }

  async send(userText: string): Promise<void> {
    this.messages.push({ role: 'user', content: userText })
    await this.agentLoop()
  }

  // ── Agentic loop ───────────────────────────────────────────────
  private async agentLoop(): Promise<void> {
    while (true) {
      const result = await this.streamResponse()
      if (result.stopReason === 'error') break

      if (result.stopReason === 'tool_use') {
        const toolBlocks = result.content.filter(b => b.type === 'tool_use')
        const toolResults: ContentBlock[] = []

        for (const block of toolBlocks) {
          // Ask mode: confirm before executing write/exec tools
          if (!this.autoMode && (block.name === 'write_file' || block.name === 'exec_command')) {
            const inputPreview = block.name === 'write_file'
              ? block.input?.path
              : block.input?.command?.slice(0, 80)

            let answer = 'y'
            if (this.onConfirm) {
              // Remote mode: delegate to WebSocket
              answer = await this.onConfirm(block.id!, block.name!, inputPreview || '')
            } else {
              // TTY mode: ask locally
              this.log(`\n  ${sym.warn} ${c.yellow(block.name!)} ${c.gray(inputPreview || '')}`)
              const ans = await readLine(`  ${c.gray('allow?')} ${c.blue('[y/n/auto]')} `)
              answer = ans.trim().toLowerCase()
            }

            if (answer === 'auto') { this.autoMode = true }
            else if (answer !== 'y' && answer !== 'yes' && answer !== '') {
              toolResults.push({
                type: 'tool_result', tool_use_id: block.id,
                content: 'User denied this action.', is_error: true,
              })
              continue
            }
          }

          this.emit({ type: 'tool', name: block.name!, detail: JSON.stringify(block.input || {}).slice(0, 200) })
          const res = await executeTool(block.name!, block.input!, this.cfg.cwd)
          this.emit({ type: 'tool_result', name: block.name!, content: (res.content || '').slice(0, 500), is_error: !!res.is_error })

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

    this.emit({ type: 'tokens', input: this.tokens.input, output: this.tokens.output, messages: this.messages.length })
    if (!this.onOutput) {
      console.log(`\n  ${c.gray(`tokens: ${this.tokens.input}↑ ${this.tokens.output}↓`)}`)
    }
  }

  // ── Stream and parse unified events ────────────────────────────
  private async streamResponse(): Promise<{ content: ContentBlock[]; stopReason: string }> {
    const useTTY = !this.onOutput
    const spinner = useTTY ? new Spinner('Thinking').start() : null
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
            if (!started) {
              spinner?.stop(); started = true
              if (useTTY) process.stdout.write(`\n  ${sym.ai} `)
            }
            if (ev.text) this.write(ev.text)
            currentText += ev.text
            break
          case 'tool_start':
            if (!started) { spinner?.stop(); started = true }
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
      spinner?.stop()
      if (useTTY) console.log()
      const msg = err.message || String(err)
      this.emit({ type: 'error', message: msg })
      if (useTTY) errorLog(msg)
      return { content: [], stopReason: 'error' }
    }

    if (currentText) {
      content.push({ type: 'text', text: currentText })
      this.emit({ type: 'text_done' })
      if (useTTY) process.stdout.write('\n')
    }
    if (!started) spinner?.stop()
    return { content, stopReason }
  }

  // ── Compact: summarize history to save tokens ──────────────────
  async compact(): Promise<void> {
    if (this.messages.length < 4) {
      this.log(`  ${sym.warn} Not enough messages to compact.`)
      return
    }

    const spinner = !this.onOutput ? new Spinner('Compacting').start() : null
    try {
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

      this.messages = [
        { role: 'user', content: summaryPrompt },
        { role: 'assistant', content: `[Conversation compacted from ${oldCount} messages. Summary of what happened:]` },
      ]

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

      spinner?.stop()
      this.log(`  ${sym.ok} Compacted ${oldCount} messages → 2 ${c.gray(`(saved ~${Math.round(textHistory.length / 4)} tokens)`)}`)
    } catch (e: any) {
      spinner?.stop()
      const msg = `Compact failed: ${e.message}`
      this.emit({ type: 'error', message: msg })
      if (!this.onOutput) errorLog(msg)
    }
  }

  get stats() { return this.tokens }
  get messageCount() { return this.messages.length }

  clear() {
    this.messages = []
    this.tokens = { input: 0, output: 0 }
  }

  // Export state for persistence
  exportState(): { messages: any[]; tokens: { input: number; output: number }; autoMode: boolean } {
    return {
      messages: this.messages,
      tokens: { ...this.tokens },
      autoMode: this.autoMode,
    }
  }

  // Import state from persistence
  importState(state: { messages?: any[]; tokens?: { input: number; output: number }; autoMode?: boolean }) {
    if (state.messages) this.messages = state.messages
    if (state.tokens) this.tokens = state.tokens
    if (state.autoMode !== undefined) this.autoMode = state.autoMode
  }

  // Get first user message for title
  getTitle(): string {
    const first = this.messages.find(m => m.role === 'user' && typeof m.content === 'string')
    if (first) return (first.content as string).slice(0, 50)
    return 'New conversation'
  }
}

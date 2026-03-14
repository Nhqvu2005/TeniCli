import { streamChat, type Message, type ContentBlock, type ChatEvent } from './provider'
import { executeTool, TOOLS } from './tools'
import { c, sym, Spinner, toolLog, errorLog } from './ui'
import type { Config } from './config'

export class ChatSession {
  private messages: Message[] = []
  private tokens = { input: 0, output: 0 }
  cfg: Config

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
          const res = await executeTool(block.name!, block.input!, this.cfg.cwd)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: res.content,
            is_error: res.is_error,
          })
        }

        this.messages.push({ role: 'assistant', content: result.content })
        this.messages.push({ role: 'user', content: toolResults })
        continue
      }

      // Done — save assistant text
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
            // Flush any text block
            if (currentText) { content.push({ type: 'text', text: currentText }); currentText = '' }
            currentToolId = ev.id
            currentToolName = ev.name
            toolJsonBuf = ''
            break

          case 'tool_input':
            toolJsonBuf += ev.partial
            break

          case 'tool_end':
            if (currentToolId) {
              let input = {}
              try { input = JSON.parse(toolJsonBuf) } catch {}
              content.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input })
              currentToolId = ''
              toolJsonBuf = ''
            }
            break

          case 'usage':
            this.tokens.input += ev.input
            this.tokens.output += ev.output
            break

          case 'done':
            stopReason = ev.stopReason
            break
        }
      }
    } catch (err: any) {
      spinner.stop()
      errorLog(err.message)
      return { content: [], stopReason: 'error' }
    }

    // Flush remaining text
    if (currentText) {
      content.push({ type: 'text', text: currentText })
      process.stdout.write('\n')
    }

    if (!started) spinner.stop()
    return { content, stopReason }
  }

  get stats() { return this.tokens }
  get messageCount() { return this.messages.length }

  clear() {
    this.messages = []
    this.tokens = { input: 0, output: 0 }
  }
}

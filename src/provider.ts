import type { ProviderConfig, ProviderType } from './config'
import type { ToolDef } from './tools'

// ── Unified stream events (provider-agnostic) ────────────────────
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input'; partial: string }
  | { type: 'tool_end' }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string }

// ── Message types (internal, Anthropic-like) ─────────────────────
export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, any>
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

// ── Unified streaming entry point ────────────────────────────────
export async function* streamChat(
  cfg: ProviderConfig,
  messages: Message[],
  systemPrompt: string,
  tools: ToolDef[],
  maxTokens: number,
): AsyncGenerator<ChatEvent> {
  if (cfg.type === 'openai') {
    yield* streamOpenAI(cfg, messages, systemPrompt, tools, maxTokens)
  } else {
    yield* streamAnthropic(cfg, messages, systemPrompt, tools, maxTokens)
  }
}

// ══════════════════════════════════════════════════════════════════
//  ANTHROPIC STREAMING
// ══════════════════════════════════════════════════════════════════
async function* streamAnthropic(
  cfg: ProviderConfig, messages: Message[], system: string,
  tools: ToolDef[], maxTokens: number,
): AsyncGenerator<ChatEvent> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/messages`
  const body: any = { model: cfg.model, max_tokens: maxTokens, system, messages, stream: true }
  if (tools.length) body.tools = tools

  const res = await doFetch(url, body, {
    'anthropic-version': '2023-06-01',
    'x-api-key': cfg.apiKey,
    'authorization': `Bearer ${cfg.apiKey}`,
  })

  for await (const ev of parseSSE(res)) {
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.usage)
          yield { type: 'usage', input: ev.message.usage.input_tokens || 0, output: 0 }
        break
      case 'content_block_start':
        if (ev.content_block?.type === 'text')
          yield { type: 'text', text: '' }
        else if (ev.content_block?.type === 'tool_use')
          yield { type: 'tool_start', id: ev.content_block.id, name: ev.content_block.name }
        break
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta')
          yield { type: 'text', text: ev.delta.text }
        else if (ev.delta?.type === 'input_json_delta')
          yield { type: 'tool_input', partial: ev.delta.partial_json }
        break
      case 'content_block_stop':
        yield { type: 'tool_end' }
        break
      case 'message_delta':
        if (ev.usage)
          yield { type: 'usage', input: 0, output: ev.usage.output_tokens || 0 }
        yield { type: 'done', stopReason: ev.delta?.stop_reason || 'end_turn' }
        break
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  OPENAI STREAMING
// ══════════════════════════════════════════════════════════════════
async function* streamOpenAI(
  cfg: ProviderConfig, messages: Message[], system: string,
  tools: ToolDef[], maxTokens: number,
): AsyncGenerator<ChatEvent> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/chat/completions`

  // Convert messages to OpenAI format
  const oaiMessages = toOpenAIMessages(messages, system)
  const oaiTools = tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))

  const body: any = {
    model: cfg.model,
    max_tokens: maxTokens,
    messages: oaiMessages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (oaiTools.length) body.tools = oaiTools

  const res = await doFetch(url, body, { 'authorization': `Bearer ${cfg.apiKey}` })

  // Track active tool calls during stream
  const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map()

  for await (const ev of parseSSE(res)) {
    const choice = ev.choices?.[0]
    if (!choice) {
      // Usage event (comes at the end with stream_options)
      if (ev.usage) {
        yield { type: 'usage', input: ev.usage.prompt_tokens || 0, output: ev.usage.completion_tokens || 0 }
      }
      continue
    }

    const delta = choice.delta || {}

    // Text content
    if (delta.content) {
      yield { type: 'text', text: delta.content }
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.id) {
          // New tool call starting
          toolCalls.set(tc.index, { id: tc.id, name: tc.function?.name || '', args: '' })
          yield { type: 'tool_start', id: tc.id, name: tc.function?.name || '' }
        }
        if (tc.function?.arguments) {
          const existing = toolCalls.get(tc.index)
          if (existing) existing.args += tc.function.arguments
          yield { type: 'tool_input', partial: tc.function.arguments }
        }
      }
    }

    // Finish
    if (choice.finish_reason) {
      for (const [, _] of toolCalls) yield { type: 'tool_end' }
      yield { type: 'done', stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason }
    }
  }
}

// ── OpenAI message conversion ────────────────────────────────────
function toOpenAIMessages(messages: Message[], system: string): any[] {
  const out: any[] = [{ role: 'system', content: system }]

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content })
      } else {
        // Tool results
        const blocks = msg.content as ContentBlock[]
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content || '' })
          } else {
            out.push({ role: 'user', content: b.text || '' })
          }
        }
      }
    } else {
      // Assistant
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content })
      } else {
        const blocks = msg.content as ContentBlock[]
        const toolCalls = blocks.filter(b => b.type === 'tool_use')
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')

        if (toolCalls.length) {
          out.push({
            role: 'assistant',
            content: text || null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
            })),
          })
        } else {
          out.push({ role: 'assistant', content: text })
        }
      }
    }
  }
  return out
}

// ── Shared helpers ───────────────────────────────────────────────
async function doFetch(url: string, body: any, extraHeaders: Record<string, string>): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`API ${res.status}: ${t.slice(0, 300)}`)
  }
  return res
}

async function* parseSSE(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()!

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const d = line.slice(6).trim()
        if (d === '[DONE]') return
        try { yield JSON.parse(d) } catch {}
      }
    }
  }
}

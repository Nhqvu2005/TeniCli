import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

const MAX_HISTORY = 20  // keep last 20 conversations

function historyDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const dir = join(home, '.tenicli', 'history')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export interface ConversationRecord {
  id: string
  title: string       // first user message (truncated)
  model: string
  createdAt: string
  updatedAt: string
  messages: any[]     // Message[]
  tokens: { input: number; output: number }
}

// Generate short ID
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// Save a conversation
export function saveConversation(conv: ConversationRecord): void {
  const path = join(historyDir(), `${conv.id}.json`)
  writeFileSync(path, JSON.stringify(conv, null, 0), 'utf8')
  pruneOldConversations()
}

// Load a conversation by ID
export function loadConversation(id: string): ConversationRecord | null {
  const path = join(historyDir(), `${id}.json`)
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  return null
}

// List all conversations (sorted by updatedAt desc)
export function listConversations(): ConversationRecord[] {
  const dir = historyDir()
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as ConversationRecord }
        catch { return null }
      })
      .filter((c): c is ConversationRecord => c !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch { return [] }
}

// Keep only the latest MAX_HISTORY conversations
function pruneOldConversations(): void {
  const all = listConversations()
  if (all.length <= MAX_HISTORY) return
  const dir = historyDir()
  for (const conv of all.slice(MAX_HISTORY)) {
    try { unlinkSync(join(dir, `${conv.id}.json`)) } catch {}
  }
}

// Create a new conversation record
export function createConversation(model: string): ConversationRecord {
  const now = new Date().toISOString()
  return {
    id: genId(),
    title: 'New conversation',
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    tokens: { input: 0, output: 0 },
  }
}

// Save session state for auto-reload after update
export function saveSessionState(conv: ConversationRecord): string {
  const path = join(historyDir(), '__resume__.json')
  writeFileSync(path, JSON.stringify(conv, null, 0), 'utf8')
  return path
}

// Load and delete session state
export function loadSessionState(): ConversationRecord | null {
  const path = join(historyDir(), '__resume__.json')
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      unlinkSync(path)  // one-time use
      return data
    }
  } catch {}
  return null
}

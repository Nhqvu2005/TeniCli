import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// ── Types ────────────────────────────────────────────────────────
export type ProviderType = 'anthropic' | 'openai'

export interface ProviderConfig {
  type: ProviderType
  baseUrl: string
  apiKey: string
  model: string
}

export interface Config {
  provider: ProviderConfig
  maxTokens: number
  systemPrompt: string
  cwd: string
}

export interface ModelEntry {
  id: string
  name: string
  provider: ProviderType
  speed: 'fast' | 'normal' | 'slow'
}

// ── Available models ─────────────────────────────────────────────
export const MODELS: ModelEntry[] = [
  // Anthropic
  { id: 'claude-sonnet-4-20250514',  name: 'Claude Sonnet 4',  provider: 'anthropic', speed: 'fast' },
  { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', provider: 'anthropic', speed: 'fast' },
  { id: 'claude-opus-4-20250514',    name: 'Claude Opus 4',    provider: 'anthropic', speed: 'slow' },
  // OpenAI
  { id: 'gpt-4o',      name: 'GPT-4o',      provider: 'openai', speed: 'fast' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', speed: 'fast' },
  { id: 'o3-mini',     name: 'o3-mini',     provider: 'openai', speed: 'normal' },
]

// ── Persistent config path ───────────────────────────────────────
function configDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return join(home, '.tenicli')
}

function configPath(): string {
  return join(configDir(), 'config.json')
}

interface StoredConfig {
  keys?: Record<string, string>    // { anthropic: 'sk-ant-...', openai: 'sk-...' }
  baseUrls?: Record<string, string>
  activeModel?: string
}

export function loadStoredConfig(): StoredConfig {
  try {
    if (existsSync(configPath())) {
      return JSON.parse(readFileSync(configPath(), 'utf8'))
    }
  } catch {}
  return {}
}

export function saveStoredConfig(cfg: StoredConfig) {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // Merge with existing
  const existing = loadStoredConfig()
  const merged = {
    ...existing,
    ...cfg,
    keys: { ...existing.keys, ...cfg.keys },
    baseUrls: { ...existing.baseUrls, ...cfg.baseUrls },
  }
  writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8')
}

// ── Load full runtime config ─────────────────────────────────────
export function loadConfig(): Config {
  const cwd = process.cwd()

  // Load .env files
  loadEnvFile(join(cwd, '.tenicli.env'))
  loadEnvFile(join(cwd, '.env'))

  const stored = loadStoredConfig()
  const env = process.env

  // Determine active model
  const modelId = env.TENICLI_MODEL || stored.activeModel || MODELS[0].id
  const modelEntry = MODELS.find(m => m.id === modelId)
  const providerType: ProviderType = modelEntry?.provider || (env.TENICLI_PROVIDER as ProviderType) || 'anthropic'

  // Get API key for the provider
  const apiKey = getApiKey(providerType, stored, env)

  // Get base URL for the provider
  const defaultUrl = providerType === 'openai'
    ? 'https://api.openai.com'
    : 'https://api.anthropic.com'
  const baseUrl = env.TENICLI_BASE_URL || stored.baseUrls?.[providerType] || defaultUrl

  return {
    provider: { type: providerType, baseUrl, apiKey, model: modelId },
    maxTokens: parseInt(env.TENICLI_MAX_TOKENS || '8192'),
    systemPrompt: loadSystemPrompt(cwd),
    cwd,
  }
}

function getApiKey(type: ProviderType, stored: StoredConfig, env: NodeJS.ProcessEnv): string {
  if (type === 'anthropic') {
    return env.TENICLI_API_KEY || env.ANTHROPIC_API_KEY || stored.keys?.anthropic || ''
  }
  if (type === 'openai') {
    return env.TENICLI_API_KEY || env.OPENAI_API_KEY || stored.keys?.openai || ''
  }
  return env.TENICLI_API_KEY || ''
}

// ── .env loader ──────────────────────────────────────────────────
function loadEnvFile(path: string) {
  try {
    if (!existsSync(path)) return
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      const key = t.slice(0, eq).trim()
      let val = t.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1)
      if (!process.env[key]) process.env[key] = val
    }
  } catch {}
}

// ── System prompt ────────────────────────────────────────────────
function loadSystemPrompt(cwd: string): string {
  for (const p of [join(cwd, 'TENICLI.md'), join(configDir(), 'TENICLI.md')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8')
  }
  return DEFAULT_SYSTEM_PROMPT
}

const DEFAULT_SYSTEM_PROMPT = `You are TeniCLI, a fast AI coding assistant in the terminal.

TOOLS: read/write files, execute commands, search code, list directories.

RULES:
- Be concise. Show only what matters.
- Use tools proactively — read before edit, verify after changes.
- Ask before destructive operations (delete, overwrite).
- The user may write in Vietnamese — respond in the same language they use.
- Write production-quality code matching the project's style.`

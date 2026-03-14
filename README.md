<div align="center">
<div align="center">
<div align="center">
<div align="center">
<div align="center">
<div align="center">
<div align="center">
<pre>
  ██  ██                                                   
██████████    █████  ████   █  █   ███       ███  █     ███
██  ██  ██      █    █      ██ █    █       █     █      █ 
██ █ ██ █ ██    █    ███    █ ██    █       █     █      █ 
██████████      █    █      █  █    █       █     █      █ 
 ██ ██ ██       █    ████   █  █   ███       ███  ████  ███
</pre>

**⚡ Lightweight AI coding agent for your terminal — fast, compact, multi-provider.**

</div>

## Features

- **Zero dependencies** — Pure Bun + TypeScript, nothing else
- **Multi-provider** — Anthropic & OpenAI out of the box, BYOK (Bring Your Own Key)
- **Agentic** — Autonomous Plan → Execute → Verify loop with 5 built-in tools
- **Blazing fast** — Sub-200ms startup, compiles to single binary in <1s
- **Vietnamese-first** — Proper UTF-8 input that actually works (looking at you, Claude Code 👀)
- **Tokyo Night UI** — Beautiful 256-color terminal theme

## Quick Start

```bash
# Install & run (requires Bun)
npx teni

# Or clone and run
git clone https://github.com/Nhqvu2005/TeniCli.git
cd TeniCli
bun install
bun run dev
```

On first launch, run `/auth` to set your API key:

```
/auth
> 1. Anthropic
> API Key: sk-ant-xxxxx
✓ Saved to ~/.tenicli/config.json
```

## Usage

```bash
teni                     # Interactive chat
teni "fix the auth bug"  # Start with a prompt
teni -p "explain this"   # Non-interactive (print & exit)
teni -m gpt-4o           # Override model
```

### In-Chat Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch AI model (Anthropic / OpenAI) |
| `/auth` | Configure API key |
| `/mode` | Toggle ask/auto (confirm before write/exec) |
| `/compact` | Summarize conversation to save tokens |
| `/diff` | List all files changed this session |
| `/undo` | Revert last file write |
| `/init` | Create `TENICLI.md` project template |
| `/clear` | Start new conversation |
| `/cost` | Show token usage |
| `/help` | List commands |
| `\\` | Continue input on next line |

## Built-in Tools

The agent can autonomously use these tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents (with optional line range) |
| `write_file` | Create or overwrite files |
| `list_dir` | List directory tree |
| `search_files` | Grep/ripgrep search across codebase |
| `exec_command` | Execute shell commands (30s timeout) |

## Configuration

### Environment Variables

```bash
TENICLI_API_KEY       # API key (or ANTHROPIC_API_KEY / OPENAI_API_KEY)
TENICLI_BASE_URL      # Custom API endpoint (for proxies)
TENICLI_MODEL         # Default model
TENICLI_MAX_TOKENS    # Max output tokens (default: 8192)
```

### System Prompt

Create a `TENICLI.md` in your project root (like `CLAUDE.md`) to customize the AI's behavior per project.

### Persistent Config

API keys and preferences are stored in `~/.tenicli/config.json`.

## Build

```bash
# Compile to single binary
bun run build:win     # → teni.exe (Windows)
bun run build:linux   # → teni (Linux)
bun run build:mac     # → teni (macOS)
```

## Architecture

```
src/
├── index.ts      ← Entry point, CLI args, slash commands
├── ui.ts         ← Tokyo Night colors, mascot, UTF-8 input
├── config.ts     ← Multi-provider config, persistent storage
├── provider.ts   ← Unified streaming (Anthropic + OpenAI SSE)
├── tools.ts      ← 5 tools: read, write, list, search, exec
└── chat.ts       ← Agentic loop with tool execution cycle
```

**Total: 6 files, ~700 lines, 0 runtime dependencies.**

## Roadmap

- [ ] More providers (Gemini, Ollama/local models)
- [ ] Web UI for remote access
- [ ] MCP (Model Context Protocol) support
- [ ] Session history & replay
- [ ] Plugin system

## License

MIT © [Yan Tenica](https://github.com/Nhqvu2005)

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash, randomBytes } from 'crypto'
import { ChatSession, type SessionEvent } from './chat'
import { loadConfig, loadStoredConfig, MODELS } from './config'
import { c, sym } from './ui'
import pkg from '../package.json'

interface WsSession {
  id: string
  chat: ChatSession
  send: (data: any) => void
  alive: boolean
}

// ── Minimal WebSocket implementation (RFC 6455) ──────────────────
function parseWsFrame(buf: Buffer): { opcode: number; payload: Buffer } | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2

  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2); offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2)); offset = 10
  }

  if (masked) {
    const maskKey = buf.slice(offset, offset + 4); offset += 4
    const payload = buf.slice(offset, offset + len)
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    return { opcode, payload }
  }
  return { opcode, payload: buf.slice(offset, offset + len) }
}

function createWsFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8')
  const len = payload.length
  let header: Buffer

  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x81; header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81; header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

function sendPing(socket: any) {
  const frame = Buffer.alloc(2)
  frame[0] = 0x89; frame[1] = 0 // ping, no payload
  socket.write(frame)
}

// ── Web UI HTML ──────────────────────────────────────────────────
function getWebUI(version: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeniCLI Remote</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  :root {
    --bg: #1a1b26; --bg-dark: #16161e; --bg-lighter: #24283b;
    --fg: #a9b1d6; --fg-dim: #565f89; --blue: #7aa2f7;
    --purple: #bb9af7; --green: #9ece6a; --yellow: #e0af68;
    --pink: #f7768e; --cyan: #7dcfff; --orange: #ff9e64;
  }
  body { background:var(--bg); color:var(--fg); font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace; height:100vh; display:flex; }

  /* Sidebar */
  .sidebar { width:220px; background:var(--bg-dark); border-right:1px solid var(--bg-lighter); display:flex; flex-direction:column; flex-shrink:0; }
  .sidebar-header { padding:16px; border-bottom:1px solid var(--bg-lighter); display:flex; align-items:center; gap:8px; }
  .sidebar-header h1 { font-size:14px; color:var(--blue); font-weight:600; }
  .sidebar-header .dot { width:8px; height:8px; border-radius:50%; background:var(--green); animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }
  .session-list { flex:1; overflow-y:auto; padding:8px; }
  .session-item { padding:10px 12px; border-radius:8px; cursor:pointer; margin-bottom:4px; display:flex; align-items:center; justify-content:space-between; transition:background .15s; font-size:13px; }
  .session-item:hover { background:var(--bg-lighter); }
  .session-item.active { background:var(--bg-lighter); border-left:2px solid var(--blue); }
  .session-item .name { color:var(--fg); }
  .session-item .close { color:var(--fg-dim); cursor:pointer; opacity:0; transition:opacity .15s; font-size:16px; }
  .session-item:hover .close { opacity:1; }
  .session-item .close:hover { color:var(--pink); }
  .new-session { margin:8px; padding:10px; border-radius:8px; border:1px dashed var(--fg-dim); color:var(--fg-dim); text-align:center; cursor:pointer; font-size:13px; transition:all .15s; }
  .new-session:hover { border-color:var(--blue); color:var(--blue); background:rgba(122,162,247,.05); }
  .sidebar-footer { padding:12px 16px; border-top:1px solid var(--bg-lighter); font-size:11px; color:var(--fg-dim); }

  /* Main */
  .main { flex:1; display:flex; flex-direction:column; min-width:0; }
  .topbar { padding:12px 20px; border-bottom:1px solid var(--bg-lighter); display:flex; align-items:center; justify-content:space-between; font-size:13px; }
  .topbar .title { color:var(--fg); font-weight:500; }
  .topbar .info { color:var(--fg-dim); }

  .messages { flex:1; overflow-y:auto; padding:20px; }
  .msg { margin-bottom:16px; animation:fadeIn .2s ease; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none} }
  .msg.user { display:flex; justify-content:flex-end; }
  .msg.user .bubble { background:var(--bg-lighter); border:1px solid rgba(122,162,247,.2); border-radius:12px 12px 4px 12px; padding:10px 14px; max-width:70%; white-space:pre-wrap; word-break:break-word; }
  .msg.ai .bubble { background:transparent; padding:4px 0; max-width:90%; white-space:pre-wrap; word-break:break-word; line-height:1.6; }
  .msg.system .bubble { color:var(--fg-dim); font-size:12px; text-align:center; padding:4px 0; }
  .msg.tool .bubble { background:rgba(224,175,104,.05); border:1px solid rgba(224,175,104,.15); border-radius:8px; padding:8px 12px; font-size:12px; color:var(--yellow); max-width:80%; }
  .msg.error .bubble { color:var(--pink); font-size:12px; }
  .msg .tokens { color:var(--fg-dim); font-size:11px; margin-top:4px; }

  /* Confirm dialog */
  .confirm-bar { background:var(--bg-lighter); border:1px solid rgba(224,175,104,.3); border-radius:8px; padding:12px 16px; margin:8px 0; display:flex; align-items:center; gap:12px; font-size:13px; }
  .confirm-bar .label { color:var(--yellow); flex:1; }
  .confirm-bar button { padding:4px 14px; border-radius:6px; border:none; cursor:pointer; font-size:12px; font-family:inherit; }
  .btn-allow { background:var(--green); color:var(--bg); }
  .btn-deny { background:var(--pink); color:var(--bg); }
  .btn-auto { background:var(--blue); color:var(--bg); }

  /* Input */
  .input-area { padding:16px 20px; border-top:1px solid var(--bg-lighter); }
  .input-wrap { display:flex; gap:8px; align-items:flex-end; }
  .input-wrap textarea { flex:1; background:var(--bg-lighter); border:1px solid transparent; border-radius:10px; padding:10px 14px; color:var(--fg); font-family:inherit; font-size:14px; resize:none; outline:none; min-height:44px; max-height:200px; transition:border-color .15s; }
  .input-wrap textarea:focus { border-color:var(--blue); }
  .input-wrap textarea::placeholder { color:var(--fg-dim); }
  .send-btn { width:40px; height:40px; border-radius:10px; border:none; background:var(--blue); color:var(--bg); cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:18px; transition:background .15s; flex-shrink:0; }
  .send-btn:hover { background:#8ab4f8; }
  .send-btn:disabled { opacity:.3; cursor:default; }

  .typing { color:var(--fg-dim); font-size:12px; padding:4px 0; display:none; }
  .typing.show { display:block; animation:blink 1s infinite; }
  @keyframes blink { 0%,100%{opacity:1}50%{opacity:.3} }

  /* Mobile */
  @media(max-width:768px) {
    .sidebar { display:none; } /* TODO: hamburger */
    .msg.user .bubble { max-width:85%; }
  }
</style>
</head>
<body>

<div class="sidebar">
  <div class="sidebar-header">
    <div class="dot"></div>
    <h1>TeniCLI v${version}</h1>
  </div>
  <div class="session-list" id="sessionList"></div>
  <div class="new-session" onclick="newSession()">+ New Session</div>
  <div class="sidebar-footer">Remote Terminal</div>
</div>

<div class="main">
  <div class="topbar">
    <span class="title" id="topTitle">Session 1</span>
    <span class="info" id="topInfo">ready</span>
  </div>
  <div class="messages" id="messages"></div>
  <div class="typing" id="typing">◆ thinking...</div>
  <div class="input-area">
    <div class="input-wrap">
      <textarea id="input" placeholder="Type a message or /command..." rows="1" autofocus></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()">↑</button>
    </div>
  </div>
</div>

<script>
const WS_URL = location.protocol === 'https:' ? 'wss://' : 'ws://'
let ws, sessions = {}, activeId = null, sessionCounter = 0

function connect() {
  const token = localStorage.getItem('teni_token')
  if (!token) { promptToken(); return }

  ws = new WebSocket(WS_URL + location.host + '/ws?token=' + encodeURIComponent(token))
  ws.onopen = () => {
    document.querySelector('.dot').style.background = 'var(--green)'
    document.getElementById('topInfo').textContent = 'connected'
    if (Object.keys(sessions).length === 0) newSession()
  }
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data))
  ws.onclose = () => {
    document.querySelector('.dot').style.background = 'var(--pink)'
    document.getElementById('topInfo').textContent = 'disconnected'
    setTimeout(connect, 3000)
  }
  ws.onerror = () => ws.close()
}

function promptToken() {
  const token = prompt('Enter access password:')
  if (token) { localStorage.setItem('teni_token', token); connect() }
}

function newSession() {
  sessionCounter++
  const id = 'session_' + sessionCounter
  sessions[id] = { name: 'Session ' + sessionCounter, messages: [], streaming: '', busy: false }
  ws.send(JSON.stringify({ type: 'new_session', sessionId: id }))
  renderSidebar()
  switchSession(id)
}

function switchSession(id) {
  activeId = id
  renderSidebar()
  renderMessages()
  document.getElementById('topTitle').textContent = sessions[id].name
}

function renderSidebar() {
  const list = document.getElementById('sessionList')
  list.innerHTML = Object.entries(sessions).map(([id, s]) =>
    '<div class="session-item ' + (id === activeId ? 'active' : '') + '" onclick="switchSession(\\'' + id + '\\')">' +
    '<span class="name">' + s.name + '</span>' +
    '<span class="close" onclick="event.stopPropagation();closeSession(\\'' + id + '\\')">&times;</span>' +
    '</div>'
  ).join('')
}

function closeSession(id) {
  ws.send(JSON.stringify({ type: 'close_session', sessionId: id }))
  delete sessions[id]
  if (activeId === id) {
    const keys = Object.keys(sessions)
    activeId = keys.length ? keys[0] : null
  }
  renderSidebar()
  if (activeId) switchSession(activeId)
}

function sendMessage() {
  const input = document.getElementById('input')
  const text = input.value.trim()
  if (!text || !activeId) return
  input.value = ''; autoResize(input)

  const s = sessions[activeId]
  s.messages.push({ type: 'user', text })
  s.busy = true
  renderMessages()
  document.getElementById('typing').classList.add('show')

  ws.send(JSON.stringify({ type: 'message', sessionId: activeId, text }))
}

function handleMessage(msg) {
  const s = sessions[msg.sessionId]
  if (!s) return

  switch (msg.type) {
    case 'text':
      s.streaming += msg.text
      if (msg.sessionId === activeId) renderMessages()
      break
    case 'text_done':
      if (s.streaming) { s.messages.push({ type: 'ai', text: s.streaming }); s.streaming = '' }
      s.busy = false
      document.getElementById('typing').classList.remove('show')
      if (msg.sessionId === activeId) renderMessages()
      break
    case 'tokens':
      s.messages.push({ type: 'system', text: msg.input + '↑ ' + msg.output + '↓ tokens • ' + msg.messages + ' msgs' })
      s.busy = false
      document.getElementById('typing').classList.remove('show')
      if (msg.sessionId === activeId) renderMessages()
      break
    case 'tool':
      s.messages.push({ type: 'tool', text: '⚙ ' + msg.name + ' ' + (msg.detail || '') })
      if (msg.sessionId === activeId) renderMessages()
      break
    case 'tool_result':
      s.messages.push({ type: msg.is_error ? 'error' : 'system', text: (msg.is_error ? '✗ ':'✓ ') + msg.name + ': ' + msg.content.slice(0,200) })
      if (msg.sessionId === activeId) renderMessages()
      break
    case 'error':
      s.messages.push({ type: 'error', text: '✗ ' + msg.message })
      s.busy = false
      document.getElementById('typing').classList.remove('show')
      if (msg.sessionId === activeId) renderMessages()
      break
    case 'confirm':
      s.messages.push({ type: 'confirm', id: msg.id, tool: msg.tool, preview: msg.preview })
      if (msg.sessionId === activeId) renderMessages()
      break
  }
}

function respondConfirm(confirmId, answer) {
  ws.send(JSON.stringify({ type: 'confirm_response', sessionId: activeId, id: confirmId, answer }))
  // Remove the confirm bar
  const s = sessions[activeId]
  s.messages = s.messages.filter(m => !(m.type === 'confirm' && m.id === confirmId))
  renderMessages()
}

function renderMessages() {
  const s = sessions[activeId]
  if (!s) return
  const el = document.getElementById('messages')
  const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40

  let html = ''
  for (const m of s.messages) {
    if (m.type === 'confirm') {
      html += '<div class="confirm-bar"><span class="label">⚠ ' + m.tool + ' ' + escHtml(m.preview) + '</span>' +
        '<button class="btn-allow" onclick="respondConfirm(\\'' + m.id + '\\',\\'y\\')">Allow</button>' +
        '<button class="btn-deny" onclick="respondConfirm(\\'' + m.id + '\\',\\'n\\')">Deny</button>' +
        '<button class="btn-auto" onclick="respondConfirm(\\'' + m.id + '\\',\\'auto\\')">Auto</button></div>'
    } else {
      html += '<div class="msg ' + m.type + '"><div class="bubble">' + escHtml(m.text) + '</div></div>'
    }
  }
  // Streaming text
  if (s.streaming) {
    html += '<div class="msg ai"><div class="bubble">' + escHtml(s.streaming) + '</div></div>'
  }
  el.innerHTML = html
  if (wasAtBottom) el.scrollTop = el.scrollHeight
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// Auto-resize textarea
const input = document.getElementById('input')
input.addEventListener('input', () => autoResize(input))
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
})
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px' }

connect()
</script>
</body>
</html>`
}

// ── Start Server ─────────────────────────────────────────────────
export function startServer(port: number, password: string) {
  const cfg = loadConfig()
  const sessions = new Map<string, WsSession>()
  const pendingConfirms = new Map<string, (answer: string) => void>()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', sessions: sessions.size, version: pkg.version }))
      return
    }

    // Serve web UI
    res.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'no-cache',
    })
    res.end(getWebUI(pkg.version))
  })

  // ── WebSocket upgrade ────────────────────────────────────────
  server.on('upgrade', (req: IncomingMessage, socket: any) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')

    // Auth check
    if (token !== password) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // WebSocket handshake
    const key = req.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5ABB5C0A2C15')
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    )

    // Message handling
    let buf = Buffer.alloc(0)

    const send = (data: any) => {
      try { socket.write(createWsFrame(JSON.stringify(data))) } catch {}
    }

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])

      while (buf.length > 0) {
        const frame = parseWsFrame(buf)
        if (!frame) break

        // Calculate consumed bytes to advance buffer
        let frameSize = 2
        const rawLen = buf[1] & 0x7f
        if (rawLen === 126) frameSize = 4
        else if (rawLen === 127) frameSize = 10
        if (buf[1] & 0x80) frameSize += 4
        frameSize += frame.payload.length
        buf = buf.slice(frameSize)

        // Handle opcodes
        if (frame.opcode === 0x08) { socket.end(); return } // close
        if (frame.opcode === 0x09) { // ping → pong
          const pong = Buffer.alloc(2 + frame.payload.length)
          pong[0] = 0x8a; pong[1] = frame.payload.length
          frame.payload.copy(pong, 2)
          socket.write(pong)
          continue
        }
        if (frame.opcode === 0x0a) continue // pong

        try {
          const msg = JSON.parse(frame.payload.toString('utf8'))
          handleWsMessage(msg, send, sessions, pendingConfirms, cfg)
        } catch {}
      }
    })

    // Keepalive ping every 30s
    const pingInterval = setInterval(() => {
      try { sendPing(socket) } catch { clearInterval(pingInterval) }
    }, 30000)

    socket.on('close', () => {
      clearInterval(pingInterval)
      // Clean up sessions owned by this socket
      for (const [id, s] of sessions) {
        if (s.send === send) sessions.delete(id)
      }
    })

    socket.on('error', () => socket.destroy())
  })

  server.listen(port, () => {
    console.log()
    console.log(`  ${c.green('●')} ${c.bold('TeniCLI Remote Server')}`)
    console.log()
    console.log(`  ${c.gray('URL:')}      ${c.cyan(`http://localhost:${port}`)}`)
    console.log(`  ${c.gray('Password:')} ${c.yellow(password)}`)
    console.log(`  ${c.gray('Version:')}  v${pkg.version}`)
    console.log()
    console.log(`  ${c.gray('Tip: Use VS Code Port Forward to make it public')}`)
    console.log(`  ${c.gray('Press Ctrl+C to stop')}`)
    console.log()
  })
}

// ── Handle incoming WebSocket messages ───────────────────────────
function handleWsMessage(
  msg: any,
  send: (data: any) => void,
  sessions: Map<string, WsSession>,
  pendingConfirms: Map<string, (answer: string) => void>,
  baseCfg: any,
) {
  switch (msg.type) {
    case 'new_session': {
      const cfg = { ...baseCfg, provider: { ...baseCfg.provider } }
      const chat = new ChatSession(cfg)
      chat.autoMode = true  // default to auto in web mode

      // Wire up output events
      chat.onOutput = (ev: SessionEvent) => {
        send({ ...ev, sessionId: msg.sessionId })
      }

      // Wire up tool confirmation for remote
      chat.onConfirm = (id, tool, preview) => {
        return new Promise<string>((resolve) => {
          send({ type: 'confirm', sessionId: msg.sessionId, id, tool, preview })
          pendingConfirms.set(id, resolve)
          // Auto-approve after 60s timeout
          setTimeout(() => {
            if (pendingConfirms.has(id)) {
              pendingConfirms.delete(id)
              resolve('y')
            }
          }, 60000)
        })
      }

      sessions.set(msg.sessionId, { id: msg.sessionId, chat, send, alive: true })
      break
    }

    case 'close_session':
      sessions.delete(msg.sessionId)
      break

    case 'message': {
      const session = sessions.get(msg.sessionId)
      if (!session) return
      // Handle commands locally
      const text = msg.text?.trim()
      if (!text) return

      if (text === '/clear') {
        session.chat.clear()
        send({ type: 'system', sessionId: msg.sessionId, text: 'Conversation cleared' })
        return
      }
      if (text === '/compact') {
        session.chat.compact()
        return
      }
      if (text === '/cost') {
        const s = session.chat.stats
        send({ type: 'tokens', sessionId: msg.sessionId, input: s.input, output: s.output, messages: session.chat.messageCount })
        return
      }

      // Send to AI
      session.chat.send(text).catch((err: any) => {
        send({ type: 'error', sessionId: msg.sessionId, message: err.message })
      })
      break
    }

    case 'confirm_response': {
      const cb = pendingConfirms.get(msg.id)
      if (cb) { pendingConfirms.delete(msg.id); cb(msg.answer) }
      break
    }
  }
}

<div align="center">
<pre>
  ██  ██                                                   
██████████    █████  ████   █  █   ███       ███  █     ███
██  ██  ██      █    █      ██ █    █       █     █      █ 
██ ███ ███      █    ███    █ ██    █       █     █      █ 
██████████      █    █      █  █    █       █     █      █ 
 ██ ██ ██       █    ████   █  █   ███       ███  ████  ███
</pre>

**⚡ Trợ lý AI lập trình siêu nhẹ cho terminal — nhanh, đa nền tảng, tự chủ.**

</div>

## Tính Năng

- **Không phụ thuộc** — Chỉ Bun + TypeScript thuần, không cần cài thêm gì
- **Đa nhà cung cấp** — Anthropic & OpenAI có sẵn, dùng API key của bạn (BYOK)
- **Tự động hóa** — Vòng lặp Plan → Execute → Verify với 5 tool tích hợp
- **Cực nhanh** — Khởi động <200ms, compile thành binary đơn trong <1s
- **Hỗ trợ tiếng Việt** — Input UTF-8 chuẩn, không bị lỗi mất chữ như Claude Code
- **Giao diện Tokyo Night** — Theme 256-color đẹp mắt, dễ chịu

## Bắt Đầu Nhanh

```bash
# Clone và chạy
git clone https://github.com/Nhqvu2005/TeniCli.git
cd TeniCli
bun install
bun run dev
```

Lần đầu chạy, dùng `/auth` để cài API key:

```
/auth
> 1. Anthropic
> API Key: sk-ant-xxxxx
✓ Đã lưu vào ~/.tenicli/config.json
```

## Cách Dùng

```bash
teni                        # Chat tương tác
teni "sửa lỗi đăng nhập"   # Bắt đầu với prompt
teni -p "giải thích code"   # Chế độ non-interactive
teni -m gpt-4o              # Chọn model khác
```

### Lệnh Trong Chat

| Lệnh | Mô tả |
|-------|-------|
| `/model` | Chuyển đổi model AI (Anthropic / OpenAI) |
| `/auth` | Cấu hình API key |
| `/mode` | Bật/tắt chế độ ask/auto (hỏi trước khi ghi/chạy lệnh) |
| `/compact` | Tóm tắt hội thoại bằng AI để tiết kiệm token |
| `/diff` | Xem danh sách file đã thay đổi trong session |
| `/undo` | Hoàn tác file vừa ghi |
| `/init` | Tạo file `TENICLI.md` template cho project |
| `/clear` | Bắt đầu cuộc trò chuyện mới |
| `/cost` | Xem token đã dùng |
| `/help` | Danh sách lệnh |
| `\\\\` | Xuống dòng tiếp tục nhập |

## Tool Tích Hợp

Agent có thể tự động sử dụng các tool sau:

| Tool | Mô tả |
|------|-------|
| `read_file` | Đọc nội dung file (hỗ trợ chọn dòng) |
| `write_file` | Tạo hoặc ghi đè file |
| `list_dir` | Liệt kê cây thư mục |
| `search_files` | Tìm kiếm text trong codebase (grep/ripgrep) |
| `exec_command` | Chạy lệnh shell (timeout 30s) |

## Cấu Hình

### Biến Môi Trường

```bash
TENICLI_API_KEY       # API key (hoặc ANTHROPIC_API_KEY / OPENAI_API_KEY)
TENICLI_BASE_URL      # Endpoint API tuỳ chỉnh (cho proxy)
TENICLI_MODEL         # Model mặc định
TENICLI_MAX_TOKENS    # Số token output tối đa (mặc định: 8192)
```

### System Prompt

Tạo file `TENICLI.md` trong thư mục gốc dự án (giống `CLAUDE.md`) để tuỳ chỉnh hành vi AI cho từng project.

### Cấu Hình Bền Vững

API keys và tuỳ chọn được lưu tại `~/.tenicli/config.json`.

## Build

```bash
# Compile thành binary đơn
bun run build:win     # → teni.exe (Windows)
bun run build:linux   # → teni (Linux)
bun run build:mac     # → teni (macOS)
```

## Kiến Trúc

```
src/
├── index.ts      ← Entry point, phân tích args, lệnh slash
├── ui.ts         ← Màu Tokyo Night, mascot, input UTF-8
├── config.ts     ← Config đa provider, lưu trữ bền vững
├── provider.ts   ← Streaming thống nhất (Anthropic + OpenAI SSE)
├── tools.ts      ← 5 tools: đọc, ghi, liệt kê, tìm, thực thi
└── chat.ts       ← Vòng lặp agentic với tool execution
```

**Tổng cộng: 6 files, ~700 dòng, 0 phụ thuộc runtime.**

## Lộ Trình

- [ ] Thêm provider (Gemini, Ollama/local models)
- [ ] Giao diện web để truy cập từ xa
- [ ] Hỗ trợ MCP (Model Context Protocol)
- [ ] Lịch sử session & replay
- [ ] Hệ thống plugin

## Giấy Phép

MIT © [Yan Tenica](https://github.com/Nhqvu2005)

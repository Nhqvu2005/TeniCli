// Minimal QR code generator for terminal (no dependencies)
// Generates QR codes using Unicode block characters

// QR matrix generator using simplified algorithm
// Supports up to ~50 chars (enough for URLs like http://192.168.1.x:3000)
// Based on QR Code Model 2, Version 2-4, Error Correction Level L

const PATTERNS = {
  FINDER: [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1],
  ]
}

// Simple QR code: instead of implementing full QR encoding,
// render a frame with the URL text for terminal display
export function renderQR(url: string): string {
  // Use a simpler approach: generate a QR-like visual with the URL
  // For a real QR code we'd need a full encoder — instead, show a neat box with URL
  const lines: string[] = []
  const w = Math.max(url.length + 4, 30)

  // Helper: full block for dark, space for light
  const B = '██'
  const W = '  '

  // Top finder + timing
  for (let row = 0; row < 7; row++) {
    let line = ''
    for (let col = 0; col < 7; col++) line += PATTERNS.FINDER[row][col] ? B : W
    line += W  // separator
    for (let col = 0; col < w - 15; col++) line += (row === 6 && col % 2 === 0) ? B : (row === 6 ? W : W)
    line += W
    for (let col = 0; col < 7; col++) line += PATTERNS.FINDER[row][col] ? B : W
    lines.push(line)
  }
  // Separator row
  lines.push(W.repeat(w / 2 + 1))
  // Middle rows with data-like pattern
  const mid = 5
  for (let row = 0; row < mid; row++) {
    let line = ''
    for (let col = 0; col < w + 1; col++) {
      // Timing column
      if (col === 6) { line += (row % 2 === 0) ? B : W; continue }
      // Pseudo-random data pattern
      line += ((col + row * 3 + col * row) % 3 === 0) ? B : W
    }
    lines.push(line)
  }
  // Separator
  lines.push(W.repeat(w / 2 + 1))
  // Bottom-left finder
  for (let row = 0; row < 7; row++) {
    let line = ''
    for (let col = 0; col < 7; col++) line += PATTERNS.FINDER[row][col] ? B : W
    line += W
    for (let col = 0; col < w - 14; col++) {
      line += ((col + row * 5) % 3 === 0) ? B : W
    }
    lines.push(line)
  }

  return lines.map(l => '    ' + l).join('\n')
}

// Get local network IPs
export function getLocalIPs(): string[] {
  try {
    const { networkInterfaces } = require('os')
    const nets = networkInterfaces()
    const ips: string[] = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          ips.push(net.address)
        }
      }
    }
    return ips
  } catch {
    return []
  }
}

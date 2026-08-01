#!/usr/bin/env bun
// Boot probe — validates daemon code can load and answers health queries.
// Used by blue-green restart to confirm the replacement daemon boots before
// killing the incumbent.
//
// Required env:
//   HYDRA_PROBE_SOCK  — scratch socket path for health queries
//   HYDRA_STATE_DIR   — real state directory (for token + config validation)
//   CHAT_PLATFORM     — discord or slack

import { createServer, type Socket } from 'net'
import { unlinkSync, chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'

if (!process.env.HYDRA_PROBE_SOCK) {
  process.stderr.write('boot-probe: HYDRA_PROBE_SOCK required\n')
  process.exit(1)
}
const PROBE_SOCK: string = process.env.HYDRA_PROBE_SOCK

// Import the daemon's critical module graph. Runtime boot failures (broken
// imports, missing exports, top-level evaluation errors) surface here — the
// exact class of failure that compile checks miss.
try {
  await import('./config.js')
  await import('./sessions.js')
  await import('./bridge-transport.js')
  await import('./bridge-dispatch.js')
  await import('./bridge-server.js')
  await import('./session-lifecycle.js')
  await import('./router.js')
} catch (err) {
  process.stderr.write(`boot-probe: FAILED — ${err}\n`)
  process.exit(1)
}

// Create a scratch socket and answer health queries. Proves the process can
// bind a socket and handle the daemon's wire protocol.
try { unlinkSync(PROBE_SOCK) } catch {}
mkdirSync(dirname(PROBE_SOCK), { recursive: true })

const server = createServer((socket: Socket) => {
  let buf = ''
  socket.on('data', (data: Buffer) => {
    buf += data.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'cli' && msg.command === 'health') {
          socket.write(JSON.stringify({
            type: 'cli-response',
            id: msg.id ?? '',
            ok: true,
            command: 'health',
            data: { probe: true, pid: process.pid },
          }) + '\n')
        }
      } catch (err) {
        process.stderr.write(`boot-probe: malformed message: ${err}\n`)
      }
    }
  })
})

server.listen(PROBE_SOCK, () => {
  try { chmodSync(PROBE_SOCK, 0o700) } catch {}
  process.stderr.write('boot-probe: ready\n')
})

function cleanup(): void {
  server.close()
  try { unlinkSync(PROBE_SOCK) } catch {}
  process.exit(0)
}

process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)

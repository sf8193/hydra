// UDS heartbeat — inject periodic messages to CC's internal UDS socket
// to keep headless protocol guest sessions alive between turns.
//
// CC listens on /tmp/cc-socks/<pid>.sock for injected messages.
// Messages sent here are treated as user input, resetting CC's idle timer.

import { connect, type Socket } from 'net'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { registry } from './sessions.js'

const HEARTBEAT_INTERVAL_MS = 30_000
const DISCOVERY_RETRY_MS = 5_000
const MAX_DISCOVERY_RETRIES = 6

const heartbeats = new Map<string, ReturnType<typeof setInterval>>()
const discoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function discoverUdsPath(tmuxName: string): string | null {
  try {
    const pid = execFileSync('tmux', ['display-message', '-t', tmuxName, '-p', '#{pane_pid}'], { stdio: 'pipe' }).toString().trim()
    if (!pid) return null
    const children = execFileSync('pgrep', ['-P', pid], { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean)
    for (const childPid of children) {
      const sockPath = `/tmp/cc-socks/${childPid}.sock`
      if (existsSync(sockPath)) return sockPath
      try {
        const grandchildren = execFileSync('pgrep', ['-P', childPid], { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean)
        for (const gcPid of grandchildren) {
          const gcSockPath = `/tmp/cc-socks/${gcPid}.sock`
          if (existsSync(gcSockPath)) return gcSockPath
        }
      } catch {}
    }
    return null
  } catch {
    return null
  }
}

function sendHeartbeat(sockPath: string, sessionId: string): void {
  const msg = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: '[system] Protocol heartbeat — you are in a multi-round protocol. Stay alive and wait for your next turn notification. Do not exit.',
    },
  }) + '\n'

  const sock: Socket = connect(sockPath)
  sock.on('connect', () => {
    sock.write(msg)
    sock.end()
  })
  sock.on('error', (err: Error) => {
    process.stderr.write(`daemon: uds-heartbeat: send failed for ${sessionId}: ${err.message}\n`)
    stopHeartbeat(sessionId)
  })
  sock.setTimeout(2000)
  sock.on('timeout', () => { sock.destroy() })
}

export function startHeartbeat(sessionId: string): void {
  if (heartbeats.has(sessionId)) return

  const info = registry.get(sessionId)
  if (!info) return

  let retries = 0

  function tryDiscover(): void {
    const sockPath = discoverUdsPath(info!.tmuxName)
    if (sockPath) {
      process.stderr.write(`daemon: uds-heartbeat: discovered ${sockPath} for ${info!.tmuxName}\n`)
      const interval = setInterval(() => {
        const currentInfo = registry.get(sessionId)
        if (!currentInfo || currentInfo.deadAt) {
          stopHeartbeat(sessionId)
          return
        }
        sendHeartbeat(sockPath, sessionId)
      }, HEARTBEAT_INTERVAL_MS)
      heartbeats.set(sessionId, interval)
      discoveryTimers.delete(sessionId)
    } else {
      retries++
      if (retries >= MAX_DISCOVERY_RETRIES) {
        process.stderr.write(`daemon: uds-heartbeat: gave up discovering UDS socket for ${info!.tmuxName} after ${retries} retries\n`)
        discoveryTimers.delete(sessionId)
        return
      }
      discoveryTimers.set(sessionId, setTimeout(tryDiscover, DISCOVERY_RETRY_MS))
    }
  }

  discoveryTimers.set(sessionId, setTimeout(tryDiscover, DISCOVERY_RETRY_MS))
}

export function stopHeartbeat(sessionId: string): void {
  const interval = heartbeats.get(sessionId)
  if (interval) {
    clearInterval(interval)
    heartbeats.delete(sessionId)
  }
  const timer = discoveryTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    discoveryTimers.delete(sessionId)
  }
}

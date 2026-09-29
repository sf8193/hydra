#!/usr/bin/env bun

import { randomUUID } from 'crypto'
import { resolveSocket, sendRequest, printResponse } from './helpers.js'
import {
  lifecycleUp, lifecycleDown, lifecycleRestart,
  lifecycleWatchdog, lifecyclePreflight,
  lifecycleInstall, lifecycleUninstall,
  type InstallOpts,
} from './lifecycle.js'
import { peek } from './peek.js'
import { MODEL_ALIASES } from '../shared/constants.js'

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const USAGE = `hydra — manage hydra daemons and sessions

Setup:
  hydra install <platform>             Generate launchd watchdog + run preflight
    --cwd <path>                       Working directory for spawned sessions
    --config-dir <path>                Claude config dir (default: ~/.claude)
  hydra uninstall <platform>           Remove launchd watchdog

Lifecycle:
  hydra up <platform>                  Start daemon + byte
  hydra down <platform>                Stop byte + daemon
  hydra restart <platform>             Restart with module validation (validates before kill)
  hydra restart <platform> --fast      Skip module validation (compile check only)
  hydra watchdog <platform>            Single watchdog tick (for launchd)
  hydra preflight <platform>           Verify deployment is ready

Session management:
  hydra spawn <prompt>                 Spawn a new session
  hydra list                           List active sessions
  hydra status <name>                  Session details
  hydra kill <name>                    Kill a session
  hydra peek [name]                    Read-only view of live sessions
  hydra attach <name>                  Attach to a running session's tmux surface
  hydra health                         Daemon diagnostics
  hydra clear-key <key>                Clear a stuck idempotency key
  hydra check-key <key>                Check if an idempotency key exists

Deliver (whisper channel — message to session context, not thread):
  hydra deliver --session <name> --message "..."
  hydra deliver --thread <id> --message "..."
    --session <name>                   Target session by name (primary)
    --thread <id>                      Target session by thread ID (alternative)
    --message <text>                   Message to deliver (required)
    --initiator <who>                  Who sent this (default: $USER)
    --idempotency-key <key>            Prevent duplicate delivery (optional, 15min TTL)
    --queue                            Queue if bridge disconnected (default: fail)

Factory:
  hydra factory list                   List all active factory builds
  hydra factory status <ticket>        Show a build's phase, spec, retries
  hydra factory accept <ticket>        Accept a build (--allow-unreviewed to bypass review gate)
  hydra factory abandon <ticket>       Abandon a build

Platform: slack | discord (required for lifecycle commands)

Spawn options:
  --initiator <name>                   Who triggered this spawn (required)
  --idempotency-key <key>              Prevent duplicate spawns (required)
  --model <id|alias>                   Model ID or alias (see below)
  --channel <id>                       Target channel for the spawned thread
  --message <id>                       Create thread on this message (requires --channel)
  --read-thread [limit] [thread-id]    Read thread history first (default: 50 msgs from --channel, max 200)
  --quiet                              Suppress spawn announcement in chat
  --ephemeral                          Auto-kill on [done], skip death visuals
  --force-cleanup                      Remove worktree + branch on kill even with uncommitted/unpushed work (unpushed commits become unreachable)

Model aliases:
${Object.entries(MODEL_ALIASES).map(([k, v]) => `  ${k.padEnd(16)} → ${v}`).join('\n')}

Global options:
  --daemon <name>                      Target a specific daemon
  --json                               Output raw JSON
  -h, --help                           Show this help
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(USAGE)
    process.exit(0)
  }

  let daemonName: string | undefined
  let json = false
  const filtered: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--daemon' && i + 1 < args.length) {
      daemonName = args[++i]
    } else if (args[i] === '--json') {
      json = true
    } else {
      filtered.push(args[i])
    }
  }

  const command = filtered[0]

  // Lifecycle commands
  if (['install', 'uninstall', 'up', 'down', 'restart', 'watchdog', 'preflight'].includes(command)) {
    const platform = filtered[1]
    if (!platform) {
      console.error('error: platform is required (e.g. discord, slack)')
      process.exit(1)
    }
    switch (command) {
      case 'install': {
        const installOpts: InstallOpts = {}
        for (let i = 2; i < filtered.length; i++) {
          if (filtered[i] === '--cwd' && i + 1 < filtered.length) {
            installOpts.cwd = filtered[++i]
          } else if (filtered[i] === '--config-dir' && i + 1 < filtered.length) {
            installOpts.configDir = filtered[++i]
          }
        }
        await lifecycleInstall(platform, installOpts)
        break
      }
      case 'uninstall': lifecycleUninstall(platform); break
      case 'up': await lifecycleUp(platform); break
      case 'down': await lifecycleDown(platform); break
      case 'restart': await lifecycleRestart(platform, { validate: !filtered.includes('--fast') }); break
      case 'watchdog': await lifecycleWatchdog(platform); break
      case 'preflight': await lifecyclePreflight(platform); break
    }
    process.exit(0)
  }

  // Lazy: resolved on first actual use, so a command's own argument validation runs first.
  let resolvedSocketPath: string | undefined
  const socketPath = () => resolvedSocketPath ??= resolveSocket(daemonName)

  switch (command) {
    case 'spawn': {
      let idempotencyKey: string | undefined
      let initiator: string | undefined
      let channel: string | undefined
      let message: string | undefined
      let quiet = false
      let ephemeral = false
      let forceWorktreeCleanup = false
      let readThreadLimit = 0  // 0 = disabled
      let model: string | undefined
      const promptParts: string[] = []

      for (let i = 1; i < filtered.length; i++) {
        if (filtered[i] === '--idempotency-key' && i + 1 < filtered.length) {
          idempotencyKey = filtered[++i]
        } else if (filtered[i] === '--initiator' && i + 1 < filtered.length) {
          initiator = filtered[++i]
        } else if (filtered[i] === '--channel' && i + 1 < filtered.length) {
          channel = filtered[++i]
        } else if (filtered[i] === '--message' && i + 1 < filtered.length) {
          message = filtered[++i]
        } else if (filtered[i] === '--quiet') {
          quiet = true
        } else if (filtered[i] === '--ephemeral') {
          ephemeral = true
        } else if (filtered[i] === '--force-cleanup') {
          forceWorktreeCleanup = true
        } else if (filtered[i] === '--read-thread') {
          readThreadLimit = 50  // default
          // peek at next arg — if it's a number, use it as the limit
          if (i + 1 < filtered.length && /^\d+$/.test(filtered[i + 1])) {
            readThreadLimit = Math.min(parseInt(filtered[++i], 10), 200)
          }
        } else if (filtered[i] === '--model' && i + 1 < filtered.length) {
          model = filtered[++i]
        } else if (filtered[i].startsWith('--')) {
          console.error(`error: unknown flag ${filtered[i]}`)
          process.exit(1)
        } else {
          promptParts.push(filtered[i])
        }
      }

      let prompt = promptParts.join(' ')
      if (!prompt) {
        console.error('error: prompt is required')
        process.exit(1)
      }
      if (!idempotencyKey) {
        console.error('error: --idempotency-key is required')
        process.exit(1)
      }
      if (!initiator) {
        console.error('error: --initiator is required')
        process.exit(1)
      }
      if (message && !channel) {
        console.error('error: --message requires --channel')
        process.exit(1)
      }
      if (readThreadLimit > 0 && !channel) {
        console.error('error: --read-thread requires --channel (the thread/channel to read)')
        process.exit(1)
      }
      if (readThreadLimit > 0 && channel) {
        prompt = `Read the recent history in this channel for context: fetch_messages(channel="${channel}", limit=${readThreadLimit}). Then continue with the task below.\n\n${prompt}`
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli',
        command: 'spawn',
        id: randomUUID(),
        params: { prompt, idempotencyKey, initiator, model, ...(channel && { channel }), ...(message && { message }), ...(quiet && { quiet }), ...(ephemeral && { ephemeral }), ...(forceWorktreeCleanup && { forceWorktreeCleanup }) },
      })
      printResponse(response, json)
      break
    }

    case 'list': {
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'list', id: randomUUID(), params: {},
      })
      printResponse(response, json)
      break
    }

    case 'status': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'status', id: randomUUID(), params: { name },
      })
      printResponse(response, json)
      break
    }

    case 'kill': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'kill', id: randomUUID(), params: { name },
      })
      printResponse(response, json)
      break
    }

    case 'health': {
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'health', id: randomUUID(), params: {},
      })
      printResponse(response, json)
      break
    }

    case 'clear-key': {
      const key = filtered[1]
      if (!key) {
        console.error('error: idempotency key required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'clear-key', id: randomUUID(), params: { key },
      })
      printResponse(response, json)
      break
    }

    case 'check-key': {
      const key = filtered[1]
      if (!key) {
        console.error('error: idempotency key required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'check-key', id: randomUUID(), params: { key },
      })
      printResponse(response, json)
      break
    }

    case 'factory': {
      const sub = filtered[1]
      // First non-flag arg after the subcommand is the ticket (order-independent vs flags).
      const ticket = filtered.slice(2).find(a => !a.startsWith('--'))
      const validSubs = ['list', 'status', 'accept', 'abandon']
      if (!sub || !validSubs.includes(sub)) {
        console.error('error: usage: hydra factory <list|status|accept|abandon> [ticket]')
        process.exit(1)
      }
      if (sub !== 'list' && !ticket) {
        console.error(`error: hydra factory ${sub} requires a ticket`)
        process.exit(1)
      }
      const allowUnreviewed = filtered.includes('--allow-unreviewed')
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'factory', id: randomUUID(),
        params: { sub, ...(ticket && { ticket }), ...(allowUnreviewed && { allowUnreviewed }) },
      })
      printResponse(response, json)
      break
    }

    case 'deliver': {
      let thread: string | undefined
      let session: string | undefined
      let message: string | undefined
      let initiator: string | undefined
      let idempotencyKey: string | undefined
      let queue = false

      for (let i = 1; i < filtered.length; i++) {
        if (filtered[i] === '--thread' && i + 1 < filtered.length) {
          thread = filtered[++i]
        } else if (filtered[i] === '--session' && i + 1 < filtered.length) {
          session = filtered[++i]
        } else if (filtered[i] === '--message' && i + 1 < filtered.length) {
          message = filtered[++i]
        } else if (filtered[i] === '--initiator' && i + 1 < filtered.length) {
          initiator = filtered[++i]
        } else if (filtered[i] === '--idempotency-key' && i + 1 < filtered.length) {
          idempotencyKey = filtered[++i]
        } else if (filtered[i] === '--queue') {
          queue = true
        }
      }

      if (!message) {
        console.error('error: --message is required')
        process.exit(1)
      }
      if (!thread && !session) {
        console.error('error: --session or --thread is required')
        process.exit(1)
      }

      if (!initiator) initiator = process.env.USER ?? 'unknown'

      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'deliver', id: randomUUID(),
        params: {
          ...(thread && { thread }),
          ...(session && { session }),
          message,
          initiator,
          ...(idempotencyKey && { idempotencyKey }),
          ...(queue && { queue }),
        },
      })
      printResponse(response, json)
      break
    }

    case 'peek': {
      await peek(filtered.slice(1), daemonName)
      break
    }

    case 'attach': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required. Usage: hydra attach <name>')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'status', id: randomUUID(), params: { name, attach: true },
      })
      if (!response.ok) {
        console.error(`error: ${response.error}`)
        process.exit(typeof response.exitCode === 'number' ? response.exitCode : 1)
      }
      const target = (response.data as { attachTarget?: string | null } | undefined)?.attachTarget
      if (!target) {
        console.error(`error: session "${name}" has no attachable surface — is it still running?`)
        process.exit(1)
      }
      const { spawnSync } = await import('child_process')
      process.exit(spawnSync('tmux', ['attach', '-t', target], { stdio: 'inherit' }).status ?? 1)
    }

    default:
      console.error(`error: unknown command "${command}"`)
      console.error(USAGE)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`fatal: ${err.message}`)
  process.exit(1)
})

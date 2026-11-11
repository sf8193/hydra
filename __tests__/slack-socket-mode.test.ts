// Both Slack connections build their Socket Mode receiver themselves, so the client's ping timeout has headroom.
// Bolt's App is faked (a real one calls auth.test the moment it is built); the receiver and its client are the
// SDK's own, so what the supervisor hooks is exactly what runs.
import { describe, test, expect, mock } from 'bun:test'
import * as bolt from '@slack/bolt'
import { EventEmitter } from 'events'
import { WebSocketServer } from 'ws'
import { LogLevel } from '@slack/socket-mode'
import { SlackWebSocket } from '@slack/socket-mode/dist/src/SlackWebSocket.js'
import { SLACK_CLIENT_PING_TIMEOUT_MS, SLACK_SOCKET_SAFE_BLOCK_MS } from '../shared/constants.js'

/** Bolt's App, reduced to what the two connections touch, keeping its one rule about a custom receiver. */
class FakeApp {
  static built: FakeApp[] = []
  receiver: unknown
  client = { auth: { test: async () => ({ ok: true, user_id: 'U1', bot_id: 'B1', team_id: 'T1', url: 'https://t.slack.com/' }) } }
  constructor(readonly opts: { token?: string; appToken?: string; receiver?: unknown; socketMode?: boolean }) {
    // App.js initReceiver: with socketMode, a custom receiver must be a SocketModeReceiver; without one, Bolt builds its own.
    if (opts.socketMode && opts.receiver && !(opts.receiver instanceof bolt.SocketModeReceiver)) throw new Error('You cannot supply a custom receiver when socketMode is set to true.')
    this.receiver = opts.receiver ?? new bolt.SocketModeReceiver({ appToken: opts.appToken! })
    FakeApp.built.push(this)
  }
  message() {}
  event() {}
  action() {}
  async start() {}
  async stop() {}
}
mock.module('@slack/bolt', () => ({ ...bolt, App: FakeApp }))

const { boltApp } = await import('../connectors/slack/listener.js')
const { SlackGateway } = await import('../slack-gateway.js')

/** The SDK client's ping timeout; it pings every third of it (SlackWebSocket.monitorPingToSlack). */
const pingTimeout = (client: unknown) => (client as { clientPingTimeoutMS: number }).clientPingTimeoutMS

describe('Socket Mode keepalive headroom', () => {
  test('the listener builds its receiver with the headroom, and its emitter is that receiver\'s client', () => {
    const app = boltApp({ app: 'xapp-test', bot: 'xoxb-test' })
    const built = FakeApp.built.at(-1)!
    expect(built.opts.socketMode).toBe(true)
    expect(built.opts.receiver).toBeInstanceOf(bolt.SocketModeReceiver)
    const client = app.emitter()
    expect(client).toBe((built.opts.receiver as { client: unknown }).client)
    expect(pingTimeout(client)).toBe(SLACK_CLIENT_PING_TIMEOUT_MS)
  })

  test('the gateway builds its receiver with the headroom, and its supervisor hooks that receiver\'s client', async () => {
    const gateway = new SlackGateway('xapp-test')
    await gateway.start('xoxb-test')
    try {
      const built = FakeApp.built.at(-1)!
      expect(built.opts.receiver).toBeInstanceOf(bolt.SocketModeReceiver)
      expect(pingTimeout((built.opts.receiver as { client: unknown }).client)).toBe(SLACK_CLIENT_PING_TIMEOUT_MS)
      expect((gateway as unknown as { sup: { state: { hooked: boolean } } }).sup.state.hooked).toBe(true)
    } finally {
      await gateway.stop()
    }
  })
})

/**
 * The SDK's own ping monitor against a local server, at a tenth of real time. Waits for the first pong, lets most of
 * a ping interval pass (the pong is then as old as it gets before the next ping), holds the loop for `blockMs`, and
 * reports whether the socket outlived two more ping checks.
 */
async function outlivesBlock(clientPingTimeoutMS: number, blockMs: number): Promise<boolean> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(r => server.once('listening', r))
  const client = new EventEmitter()
  let closed = false
  client.on('close', () => { closed = true })
  client.on('error', () => {})
  const socket = new SlackWebSocket({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, client, clientPingTimeoutMS, logLevel: LogLevel.ERROR }) as unknown as { connect(): void; disconnect(): void; lastPongReceivedTimestamp?: number }
  try {
    socket.connect()
    while (socket.lastPongReceivedTimestamp === undefined) await sleep(5)
    await sleep(clientPingTimeoutMS / 3 - 50)
    const until = Date.now() + blockMs
    while (Date.now() < until) {} // the daemon's loop, held
    await sleep(clientPingTimeoutMS * 2 / 3)
    return !closed
  } finally {
    socket.disconnect()
    server.close()
  }
}

describe('Socket Mode keepalive: what a held loop does to the socket (a tenth of real time)', () => {
  const tenth = (ms: number) => ms / 10

  test('a 7 s block drops the socket at the SDK default of 5 s, and not at the headroom', async () => {
    expect(7_000).toBeLessThan(SLACK_SOCKET_SAFE_BLOCK_MS) // inside it, with room for timer jitter
    expect(await outlivesBlock(tenth(5_000), tenth(7_000))).toBe(false)
    expect(await outlivesBlock(tenth(SLACK_CLIENT_PING_TIMEOUT_MS), tenth(7_000))).toBe(true)
  }, 10_000)
})

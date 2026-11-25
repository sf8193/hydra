import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHydraConfig } from '../../config/load.js'
import { systemEnv } from '../../infra/load-env.js'
import { parseEnvLine } from '../../shared/env-parse.js'
import { SESSION_NAMES } from '../../shared/session-catalog.js'
import {
  discordInviteUrl, envFile, expandHome, generatePairingCode, hydraToml,
  initPlatform, pairDiscordOperator, pairSlackOperator,
  slackGatewayManifest, slackManifestUrl, verifyDiscordToken, verifySlackTokens,
  type FetchLike, type InitIO, type PairingSocket,
} from '../init.js'

const load = (text: string, platform: 'discord' | 'slack') =>
  loadHydraConfig(text, systemEnv(SESSION_NAMES, '/s', platform, '/c'))

/** In-memory fake WebSocket for driving Discord Gateway and Slack Socket Mode pairing tests. */
class FakeSocket implements PairingSocket {
  sent: string[] = []
  closed = false
  private listeners: Record<string, Array<(ev: any) => void>> = { message: [], close: [], error: [] }
  send(data: string) { this.sent.push(data) }
  close() { this.closed = true }
  addEventListener(type: string, fn: (ev: any) => void) { this.listeners[type].push(fn) }
  emit(type: 'message' | 'close' | 'error', ev: any) { for (const fn of this.listeners[type]) fn(ev) }
}

describe('hydra init pure generators', () => {
  test('envFile single-quotes paths, includes optional CLAUDE_CONFIG_DIR, and survives both parseEnvLine and bash sourcing with spaces and $', () => {
    expect(envFile('slack', { bot: 'xoxb-1', app: 'xapp-2' }, '/w')).toBe(
      "CHAT_PLATFORM=slack\nSLACK_BOT_TOKEN=xoxb-1\nSLACK_APP_TOKEN=xapp-2\nSPAWN_CWD='/w'\n",
    )
    expect(envFile('discord', { bot: 'tok' }, '/w', '/c')).toBe(
      "CHAT_PLATFORM=discord\nDISCORD_BOT_TOKEN=tok\nSPAWN_CWD='/w'\nCLAUDE_CONFIG_DIR='/c'\n",
    )
    const trickyCwd = '/tmp/My $Proj `dir`'
    const trickyCfg = '/tmp/cfg $dir'
    const body = envFile('discord', { bot: 'tok' }, trickyCwd, trickyCfg)
    const parsed = Object.fromEntries(body.split('\n').map(parseEnvLine).filter((x): x is [string, string] => x !== null))
    expect(parsed.SPAWN_CWD).toBe(trickyCwd)
    expect(parsed.CLAUDE_CONFIG_DIR).toBe(trickyCfg)
    const dir = mkdtempSync(join(tmpdir(), 'hydra-env-sh-'))
    try {
      const f = join(dir, '.env')
      writeFileSync(f, body)
      const sh = Bun.spawnSync(['bash', '-c', `set -e; set -a; . "$1"; set +a; printf '%s\\n%s' "$SPAWN_CWD" "$CLAUDE_CONFIG_DIR"`, '--', f])
      expect(sh.exitCode).toBe(0)
      expect(sh.stdout.toString()).toBe(`${trickyCwd}\n${trickyCfg}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('hydraToml produces current-schema config that loads cleanly on both platforms and rejects bad IDs', () => {
    const s = load(hydraToml('slack', 'U0123456789'), 'slack')
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(s.config.operator).toBe('operator')
      expect(s.config.people.operator.addresses).toEqual(['slack:U0123456789'])
      expect(s.warnings).toEqual([])
    }
    const d = load(hydraToml('discord', '123456789012345678'), 'discord')
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.config.operator).toBe('operator')
      expect(d.config.people.operator.addresses).toEqual(['discord:123456789012345678'])
      expect(d.warnings).toEqual([])
    }
    expect(load(hydraToml('slack', 'not-an-id'), 'slack').ok).toBe(false)
    expect(load(hydraToml('discord', 'not-a-snowflake'), 'discord').ok).toBe(false)
  })

  test('discordInviteUrl encodes the application ID and the six docs/discord.md permissions', () => {
    const url = new URL(discordInviteUrl('9988776655'))
    expect(url.searchParams.get('client_id')).toBe('9988776655')
    expect(url.searchParams.get('scope')).toBe('bot')
    const p = BigInt(url.searchParams.get('permissions')!)
    expect(p).toBe([10, 11, 38, 16, 15, 6].map(b => 1n << BigInt(b)).reduce((a, b) => a | b))
  })

  test('slackGatewayManifest parses as YAML, matches docs/slack.md scopes/events exactly, and encodes into a 1-click Slack URL', () => {
    const yaml = slackGatewayManifest('My "Bot"')
    const parsed = Bun.YAML.parse(yaml) as any
    expect(parsed.display_information.name).toBe('My "Bot"')
    expect(parsed.features.app_home.home_tab_enabled).toBe(true)
    expect(parsed.features.app_home.messages_tab_read_only_enabled).toBe(false)
    expect(parsed.features.agent_view.agent_description).toBeTruthy()
    expect(parsed.settings.socket_mode_enabled).toBe(true)
    expect(parsed.settings.interactivity.is_enabled).toBe(true)

    const slackDoc = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'slack.md'), 'utf8')
    const jsonBlock = /```json\n([\s\S]*?)\n```/.exec(slackDoc)
    expect(jsonBlock).toBeTruthy()
    const docManifest = JSON.parse(jsonBlock![1])
    expect([...parsed.oauth_config.scopes.bot].sort()).toEqual([...docManifest.oauth_config.scopes.bot].sort())
    expect([...parsed.settings.event_subscriptions.bot_events].sort()).toEqual([...docManifest.settings.event_subscriptions.bot_events].sort())

    const u = new URL(slackManifestUrl(yaml))
    expect(u.origin + u.pathname).toBe('https://api.slack.com/apps')
    expect(u.searchParams.get('new_app')).toBe('1')
    expect(u.searchParams.get('manifest_yaml')).toBe(yaml)
  })

  test('expandHome resolves ~ and ~/subpath against the provided home directory', () => {
    expect(expandHome('~', '/Users/alice')).toBe('/Users/alice')
    expect(expandHome('~/work/repo', '/Users/alice')).toBe('/Users/alice/work/repo')
    expect(expandHome('/tmp/proj', '/Users/alice')).toBe('/tmp/proj')
  })

  test('generatePairingCode produces a 6-digit numeric string', () => {
    for (let i = 0; i < 20; i++) {
      expect(generatePairingCode()).toMatch(/^\d{6}$/)
    }
  })
})

describe('live token verification', () => {
  test('verifyDiscordToken extracts applicationId and bot username from oauth2/applications/@me and surfaces 401', async () => {
    const okFetch: FetchLike = async (url, init) => {
      expect(url).toBe('https://discord.com/api/v10/oauth2/applications/@me')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bot tok-123')
      return new Response(JSON.stringify({ id: '445566', name: 'AppName', bot: { username: 'HydraBot' } }), { status: 200 })
    }
    expect(await verifyDiscordToken('tok-123', okFetch)).toEqual({ ok: true, applicationId: '445566', botUsername: 'HydraBot' })

    const badFetch: FetchLike = async () => new Response('nope', { status: 401 })
    const bad = await verifyDiscordToken('bad-tok', badFetch)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('401')
  })

  test('verifySlackTokens checks token prefixes, calls auth.test and apps.connections.open, and rejects bad tokens', async () => {
    expect((await verifySlackTokens('bad', 'xapp-1')).ok).toBe(false)
    expect((await verifySlackTokens('xoxb-1', 'bad')).ok).toBe(false)

    const calls: string[] = []
    const okFetch: FetchLike = async url => {
      calls.push(url)
      if (url.endsWith('/auth.test')) return new Response(JSON.stringify({ ok: true, user: 'hydra', team: 'Acme' }))
      return new Response(JSON.stringify({ ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=1' }))
    }
    const r = await verifySlackTokens('xoxb-good', 'xapp-good', okFetch)
    expect(r).toEqual({ ok: true, botName: 'hydra', teamName: 'Acme' })
    expect(calls).toEqual(['https://slack.com/api/auth.test', 'https://slack.com/api/apps.connections.open'])

    const badAppFetch: FetchLike = async url => {
      if (url.endsWith('/auth.test')) return new Response(JSON.stringify({ ok: true, user: 'hydra', team: 'Acme' }))
      return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))
    }
    const badApp = await verifySlackTokens('xoxb-good', 'xapp-bad', badAppFetch)
    expect(badApp.ok).toBe(false)
    if (!badApp.ok) expect(badApp.error).toContain('invalid_auth')

    const noUrlFetch: FetchLike = async url => {
      if (url.endsWith('/auth.test')) return new Response(JSON.stringify({ ok: true, user: 'hydra', team: 'Acme' }))
      return new Response(JSON.stringify({ ok: true }))
    }
    const noUrl = await verifySlackTokens('xoxb-good', 'xapp-nourl', noUrlFetch)
    expect(noUrl.ok).toBe(false)
    if (!noUrl.ok) expect(noUrl.error).toContain('missing socket URL')
  })
})

describe('DM operator pairing', () => {
  test('pairDiscordOperator sends Identify with DM+MessageContent intents, ignores guild/bot/wrong-code messages, and captures DM sender', async () => {
    const sock = new FakeSocket()
    const promise = pairDiscordOperator('tok-1', '654321', { timeoutMs: 2_000, createSocket: () => sock })
    sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) })
    expect(sock.sent.length).toBe(1)
    const identify = JSON.parse(sock.sent[0])
    expect(identify.op).toBe(2)
    expect(identify.d.intents).toBe((1 << 12) | (1 << 15))

    // Ignored messages: guild channel, bot author, wrong code
    sock.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { guild_id: 'g1', content: '654321', author: { id: '111' } } }) })
    sock.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { content: '654321', author: { id: '222', bot: true } } }) })
    sock.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { content: '000000', author: { id: '333' } } }) })
    // Matching DM
    sock.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { content: ' 654321 ', author: { id: '790820896523681792', username: 'sam' } } }) })

    expect(await promise).toEqual({ ok: true, userId: '790820896523681792', username: 'sam' })
    expect(sock.closed).toBe(true)
  })

  test('pairDiscordOperator explains close code 4014 (Message Content Intent disabled) and times out cleanly', async () => {
    const sock4014 = new FakeSocket()
    const p1 = pairDiscordOperator('tok', '111111', { timeoutMs: 2_000, createSocket: () => sock4014 })
    sock4014.emit('close', { code: 4014 })
    const r1 = await p1
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toContain('Message Content Intent')

    const sockTimeout = new FakeSocket()
    const r2 = await pairDiscordOperator('tok', '111111', { timeoutMs: 30, createSocket: () => sockTimeout })
    expect(r2.ok).toBe(false)
    expect(sockTimeout.closed).toBe(true)
  })

  test('pairSlackOperator acks envelopes, ignores non-IM/bot/wrong-code messages, and captures DM sender', async () => {
    const sock = new FakeSocket()
    const promise = pairSlackOperator('wss://slack.test', '987654', { timeoutMs: 2_000, createSocket: () => sock })

    sock.emit('message', { data: JSON.stringify({ envelope_id: 'e1', payload: { event: { type: 'message', channel_type: 'channel', user: 'U1', text: '987654' } } }) })
    sock.emit('message', { data: JSON.stringify({ envelope_id: 'e2', payload: { event: { type: 'message', channel_type: 'im', bot_id: 'B1', user: 'U2', text: '987654' } } }) })
    sock.emit('message', { data: JSON.stringify({ envelope_id: 'e3', payload: { event: { type: 'message', channel_type: 'im', user: 'U3', text: 'wrong' } } }) })
    sock.emit('message', { data: JSON.stringify({ envelope_id: 'e4', payload: { event: { type: 'message', channel_type: 'im', user: 'U0999999999', text: ' 987654 ' } } }) })

    expect(await promise).toEqual({ ok: true, userId: 'U0999999999' })
    expect(sock.sent.map(s => JSON.parse(s).envelope_id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(sock.closed).toBe(true)
  })
})

describe('initPlatform end-to-end flow', () => {
  function withTempHome(fn: (home: string, workdir: string) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'hydra-init-'))
    const workdir = join(home, 'work')
    mkdirSync(workdir, { recursive: true })
    return fn(home, workdir).finally(() => rmSync(home, { recursive: true, force: true }))
  }

  function makeIO(home: string, platform: 'discord' | 'slack', answers: string[], overrides: Partial<InitIO> = {}): {
    io: InitIO; logs: string[]; errors: string[]; installed: Array<{ platform: string; cwd?: string; configDir?: string }>; askCalls: Array<{ prompt: string; secret?: boolean }>
  } {
    let idx = 0
    const logs: string[] = []
    const errors: string[] = []
    const installed: Array<{ platform: string; cwd?: string; configDir?: string }> = []
    const askCalls: Array<{ prompt: string; secret?: boolean }> = []
    const io: InitIO = {
      ask: async (prompt, opts) => {
        askCalls.push({ prompt, secret: opts?.secret })
        return answers[idx++] ?? ''
      },
      close: () => {},
      log: l => logs.push(l),
      error: l => errors.push(l),
      fetch: async () => new Response('{}', { status: 500 }),
      createSocket: () => new FakeSocket(),
      generateCode: () => '246810',
      installPlugin: () => true,
      installWatchdog: async (p, opts) => { installed.push({ platform: p, cwd: opts.cwd, ...(opts.configDir ? { configDir: opts.configDir } : {}) }) },
      stateDir: join(home, '.claude', 'channels', platform),
      configDir: join(home, '.claude'),
      home,
      plistPath: join(home, 'Library', 'LaunchAgents', `com.hydra.watchdog.${platform}.plist`),
      daemonRunning: () => false,
      ...overrides,
    }
    return { io, logs, errors, installed, askCalls }
  }

  test('refuses to overwrite an existing .env, hydra.toml, dangling symlink, launchd plist, or running daemon before asking anything', async () => {
    for (const file of ['.env', 'hydra.toml']) {
      await withTempHome(async home => {
        const dir = join(home, '.claude', 'channels', 'discord')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, file), 'keep-me\n')
        let asked = false
        const { io, errors } = makeIO(home, 'discord', [], { ask: async () => { asked = true; return '' } })
        expect(await initPlatform('discord', {}, io)).toBe(1)
        expect(asked).toBe(false)
        expect(errors.join('\n')).toContain(`${file} already exists`)
        expect(readFileSync(join(dir, file), 'utf8')).toBe('keep-me\n')
      })
    }
    await withTempHome(async home => {
      const dir = join(home, '.claude', 'channels', 'discord')
      mkdirSync(dir, { recursive: true })
      symlinkSync(join(home, 'no-such-target'), join(dir, '.env'))
      const { io, errors } = makeIO(home, 'discord', [])
      expect(await initPlatform('discord', {}, io)).toBe(1)
      expect(errors.join('\n')).toContain('.env already exists')
    })
    await withTempHome(async home => {
      const plist = join(home, 'Library', 'LaunchAgents', 'com.hydra.watchdog.slack.plist')
      mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
      writeFileSync(plist, '<plist/>')
      let asked = false
      const { io, errors } = makeIO(home, 'slack', [], { ask: async () => { asked = true; return '' } })
      expect(await initPlatform('slack', {}, io)).toBe(1)
      expect(asked).toBe(false)
      expect(errors.join('\n')).toContain('already exists')
      expect(errors.join('\n')).toContain('hydra uninstall slack')
    })
    await withTempHome(async home => {
      let asked = false
      const { io, errors } = makeIO(home, 'slack', [], {
        ask: async () => { asked = true; return '' },
        daemonRunning: () => true,
      })
      expect(await initPlatform('slack', {}, io)).toBe(1)
      expect(asked).toBe(false)
      expect(errors.join('\n')).toContain('slack-daemon is already running')
      expect(errors.join('\n')).toContain('hydra down slack')
    })
  })

  test('discord flow verifies token (muted), pairs via DM code, writes 0600 .env and valid hydra.toml, and passes config check', async () => {
    await withTempHome(async (home, workdir) => {
      const sock = new FakeSocket()
      const { io, logs, installed, askCalls } = makeIO(home, 'discord', ['discord-tok', '', '', workdir], {
        fetch: async () => new Response(JSON.stringify({ id: '555666777', bot: { username: 'Byte' } })),
        createSocket: () => {
          setTimeout(() => {
            sock.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) })
            sock.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { content: '246810', author: { id: '123456789012345678', username: 'sam' } } }) })
          }, 10)
          return sock
        },
      })
      expect(await initPlatform('discord', {}, io)).toBe(0)
      const dir = join(home, '.claude', 'channels', 'discord')
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`CHAT_PLATFORM=discord\nDISCORD_BOT_TOKEN=discord-tok\nSPAWN_CWD='${workdir}'\n`)
      expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(dir, 'hydra.toml'), 'utf8')).toBe('operator = "operator"\n\n[people.operator]\naddresses = ["discord:123456789012345678"]\n')
      expect(logs.join('\n')).toContain(discordInviteUrl('555666777'))
      expect(installed).toEqual([{ platform: 'discord', cwd: workdir }])
      expect(askCalls[0].secret).toBe(true)
      expect(askCalls.slice(1).every(c => !c.secret)).toBe(true)

      const cli = join(import.meta.dir, '..', 'hydra.ts')
      const check = Bun.spawnSync(['bun', cli, '--state-dir', dir, 'config', 'check', 'discord'], {
        env: { ...process.env, HOME: home },
        timeout: 10_000,
      })
      expect(check.exitCode).toBe(0)
    })
  })

  test('slack flow verifies tokens (muted), writes --config-dir into .env, accepts manual member ID, and passes config check', async () => {
    await withTempHome(async (home, workdir) => {
      const customCfg = join(home, 'custom claude')
      mkdirSync(customCfg, { recursive: true })
      const { io, logs, installed, askCalls } = makeIO(home, 'slack', ['MyBot', 'xapp-1', 'xoxb-1', 'U0123456789', workdir], {
        fetch: async url => url.endsWith('/auth.test')
          ? new Response(JSON.stringify({ ok: true, user: 'mybot', team: 'Acme' }))
          : new Response(JSON.stringify({ ok: true, url: 'wss://slack.test' })),
      })
      expect(await initPlatform('slack', { configDir: customCfg }, io)).toBe(0)
      const dir = join(home, '.claude', 'channels', 'slack')
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`CHAT_PLATFORM=slack\nSLACK_BOT_TOKEN=xoxb-1\nSLACK_APP_TOKEN=xapp-1\nSPAWN_CWD='${workdir}'\nCLAUDE_CONFIG_DIR='${customCfg}'\n`)
      expect(readFileSync(join(dir, 'hydra.toml'), 'utf8')).toBe('operator = "operator"\n\n[people.operator]\naddresses = ["slack:U0123456789"]\n')
      expect(logs.join('\n')).toContain('https://api.slack.com/apps?new_app=1&manifest_yaml=')
      expect(installed).toEqual([{ platform: 'slack', cwd: workdir, configDir: customCfg }])
      expect(askCalls.filter(c => c.secret).map(c => c.prompt)).toEqual(['App-level token (xapp-…): ', 'Bot token (xoxb-…): '])

      const cli = join(import.meta.dir, '..', 'hydra.ts')
      const check = Bun.spawnSync(['bun', cli, '--state-dir', dir, 'config', 'check', 'slack'], {
        env: { ...process.env, HOME: home },
        timeout: 10_000,
      })
      expect(check.exitCode).toBe(0)
    })
  })

  test('slack flow rejects nonexistent, newline, or single-quote workdir / configDir without writing .env or hydra.toml', async () => {
    const okSlack: FetchLike = async url => url.endsWith('/auth.test')
      ? new Response(JSON.stringify({ ok: true, user: 'mybot', team: 'Acme' }))
      : new Response(JSON.stringify({ ok: true, url: 'wss://slack.test' }))
    await withTempHome(async home => {
      const { io, errors, installed } = makeIO(home, 'slack', ['MyBot', 'xapp-1', 'xoxb-1', 'U0123456789', join(home, 'missing-dir')], { fetch: okSlack })
      expect(await initPlatform('slack', {}, io)).toBe(1)
      expect(errors.join('\n')).toContain('does not exist')
      expect(installed).toEqual([])
      expect(() => statSync(join(home, '.claude', 'channels', 'slack', '.env'))).toThrow()
    })
    await withTempHome(async home => {
      const { io, errors } = makeIO(home, 'slack', ['MyBot', 'xapp-1', 'xoxb-1', 'U0123456789', '/tmp/a\nSLACK_BOT_TOKEN=evil'], { fetch: okSlack })
      expect(await initPlatform('slack', {}, io)).toBe(1)
      expect(errors.join('\n')).toContain('single-line')
      expect(() => statSync(join(home, '.claude', 'channels', 'slack', '.env'))).toThrow()
    })
    await withTempHome(async home => {
      const { io, errors } = makeIO(home, 'slack', ['MyBot', 'xapp-1', 'xoxb-1', 'U0123456789', "/tmp/O'Reilly"], { fetch: okSlack })
      expect(await initPlatform('slack', {}, io)).toBe(1)
      expect(errors.join('\n')).toContain('without single quotes')
      expect(() => statSync(join(home, '.claude', 'channels', 'slack', '.env'))).toThrow()
    })
    await withTempHome(async home => {
      const { io, errors } = makeIO(home, 'slack', [], { fetch: okSlack })
      expect(await initPlatform('slack', { configDir: "/tmp/O'Reilly" }, io)).toBe(1)
      expect(errors.join('\n')).toContain('without single quotes')
    })
  })

  test('CLI wiring rejects invalid platform, --state-dir, duplicate flags, prototype keys, and flag-like option values', () => {
    const cli = join(import.meta.dir, '..', 'hydra.ts')
    const badPlat = Bun.spawnSync(['bun', cli, 'init', 'teams'], { timeout: 10_000 })
    expect(badPlat.exitCode).toBe(1)
    expect(badPlat.stderr.toString()).toContain('platform must be discord or slack')

    const badDir = Bun.spawnSync(['bun', cli, '--state-dir', '/tmp/s', 'init', 'discord'], { timeout: 10_000 })
    expect(badDir.exitCode).toBe(1)
    expect(badDir.stderr.toString()).toContain('--state-dir cannot apply')

    const badDaemon = Bun.spawnSync(['bun', cli, '--daemon', 'foo', 'init', 'discord'], { timeout: 10_000 })
    expect(badDaemon.exitCode).toBe(1)
    expect(badDaemon.stderr.toString()).toContain('--daemon cannot apply')

    const dup = Bun.spawnSync(['bun', cli, 'init', 'discord', '--operator', '111', '--operator', '222'], { timeout: 10_000 })
    expect(dup.exitCode).toBe(1)
    expect(dup.stderr.toString()).toContain('may only be given once')

    const protoKey = Bun.spawnSync(['bun', cli, 'init', 'discord', 'constructor', 'x'], { timeout: 10_000 })
    expect(protoKey.exitCode).toBe(1)
    expect(protoKey.stderr.toString()).toContain('unknown option "constructor"')

    const flagVal = Bun.spawnSync(['bun', cli, 'init', 'discord', '--cwd', '--operator'], { timeout: 10_000 })
    expect(flagVal.exitCode).toBe(1)
    expect(flagVal.stderr.toString()).toContain('--cwd requires a value')
  })

  test('exits non-zero without writing anything when stdin hits EOF (no TTY) and queues piped multi-line answers', async () => {
    await withTempHome(async home => {
      const cli = join(import.meta.dir, '..', 'hydra.ts')
      const { HYDRA_STATE_DIR: _a, DISCORD_STATE_DIR: _b, ...baseEnv } = process.env
      const r = Bun.spawnSync(['bun', cli, 'init', 'discord'], {
        stdin: new Uint8Array(),
        env: { ...baseEnv, HOME: home, TMUX_TMPDIR: home },
        timeout: 10_000,
      })
      expect(r.exitCode).toBe(1)
      expect(r.stdout.toString()).toEndWith('\n')
      expect(r.stderr.toString()).toContain('input closed before setup finished')
      expect(() => statSync(join(home, '.claude', 'channels', 'discord', '.env'))).toThrow()

      // Piped multi-line answers must all be read in order AND reach the network step (piped EOF must not abort fetch).
      const piped = Bun.spawnSync(['bun', cli, 'init', 'slack'], {
        stdin: new TextEncoder().encode('Hydra\nxapp-1-AAA\nxoxb-111\n'),
        env: { ...baseEnv, HOME: home, TMUX_TMPDIR: home, HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1' },
        timeout: 10_000,
      })
      expect(piped.exitCode).toBe(1)
      expect(piped.stdout.toString()).toContain('Verifying Slack tokens...')
      expect(piped.stderr.toString()).toContain('could not reach Slack API')
      expect(piped.stderr.toString()).not.toContain('input closed')
    })
  })

  test('refuses to overwrite a file created during the prompt window and rolls back .env if hydra.toml already exists', async () => {
    await withTempHome(async (home, workdir) => {
      const dir = join(home, '.claude', 'channels', 'discord')
      let step = 0
      const { io, errors } = makeIO(home, 'discord', [], {
        ask: async () => {
          step++
          if (step === 1) return 'tok-1'
          if (step === 2) return ''
          if (step === 3) return '123456789012345678'
          // Race: hydra.toml appears right before final write
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'hydra.toml'), 'raced\n')
          return workdir
        },
        fetch: async () => new Response(JSON.stringify({ id: '555666777', bot: { username: 'Byte' } })),
      })
      expect(await initPlatform('discord', {}, io)).toBe(1)
      expect(errors.join('\n')).toContain('rolled back')
      expect(readFileSync(join(dir, 'hydra.toml'), 'utf8')).toBe('raced\n')
      expect(() => statSync(join(dir, '.env'))).toThrow()
    })
  })

  test('slack pairing opens a fresh Socket Mode URL right before pairing and logs next-step guidance before installWatchdog', async () => {
    await withTempHome(async (home, workdir) => {
      let openCount = 0
      const seenUrls: string[] = []
      const sock = new FakeSocket()
      let guidanceLoggedBeforeInstall = false
      const { io, logs } = makeIO(home, 'slack', ['MyBot', 'xapp-1', 'xoxb-1', '', workdir], {
        fetch: async url => {
          if (url.endsWith('/auth.test')) return new Response(JSON.stringify({ ok: true, user: 'mybot', team: 'Acme' }))
          openCount++
          return new Response(JSON.stringify({ ok: true, url: `wss://slack.test/ticket-${openCount}` }))
        },
        createSocket: url => {
          seenUrls.push(url)
          setTimeout(() => {
            sock.emit('message', { data: JSON.stringify({ envelope_id: 'e1', payload: { event: { type: 'message', channel_type: 'im', user: 'U0123456789', text: '246810' } } }) })
          }, 10)
          return sock
        },
        installWatchdog: async () => {
          guidanceLoggedBeforeInstall = logs.some(l => l.includes('hydra preflight slack') && l.includes('hydra up slack'))
        },
      })
      expect(await initPlatform('slack', {}, io)).toBe(0)
      expect(openCount).toBe(2)
      expect(seenUrls).toEqual(['wss://slack.test/ticket-2'])
      expect(guidanceLoggedBeforeInstall).toBe(true)
    })
  })

  test('aborting io.signal (Ctrl-C) cancels an in-flight network/pairing wait immediately and writes nothing even when --cwd is set', async () => {
    await withTempHome(async (home, workdir) => {
      const ac = new AbortController()
      const sock = new FakeSocket()
      const { io, errors } = makeIO(home, 'discord', ['tok-1', '', ''], {
        signal: ac.signal,
        fetch: async () => new Response(JSON.stringify({ id: '555666777', bot: { username: 'Byte' } })),
        createSocket: () => {
          setTimeout(() => ac.abort(), 10)
          return sock
        },
      })
      expect(await initPlatform('discord', { cwd: workdir }, io)).toBe(1)
      expect(sock.closed).toBe(true)
      expect(errors.join('\n')).toContain('input closed before setup finished')
      expect(() => statSync(join(home, '.claude', 'channels', 'discord', '.env'))).toThrow()
    })

    // Already-aborted AbortSignal passed directly to exported pairing functions must resolve cleanly (no TDZ error).
    const preAborted = AbortSignal.abort()
    expect(await pairDiscordOperator('tok', '123456', { signal: preAborted })).toEqual({ ok: false, error: 'input closed before setup finished' })
    expect(await pairSlackOperator('wss://slack.test', '123456', { signal: preAborted })).toEqual({ ok: false, error: 'input closed before setup finished' })
  })
})

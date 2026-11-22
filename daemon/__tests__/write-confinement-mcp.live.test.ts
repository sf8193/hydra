// What Claude Code's `allowedMcpServers` does with the entries hydra writes for a write-confined session, proven against the real `claude -p` (a stub API, no login, a fake HOME and
// config folder, as write-confinement-socket.live.test.ts): a server by name, a plugin's server by the exact command it runs (with `${CLAUDE_PLUGIN_ROOT}` substituted or not),
// one matching neither, the colon-named entry that stopped every start, and the connectors-off line. Off unless asked:
//   HYDRA_LIVE_CLAUDE=1 scripts/test.sh --isolate daemon/__tests__/write-confinement-mcp.live.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readLoaded } from '../../engines/claude-verify.js'

const LIVE = process.env.HYDRA_LIVE_CLAUDE === '1' && process.platform === 'darwin' && !!Bun.which('claude') && !!Bun.which('bun')

describe.skipIf(!LIVE)('the server allowlist of a write-confined session, against the real Claude Code', () => {
  const fake = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-live-')))
  const home = join(fake, 'home'), workdir = join(home, 'work'), configDir = join(fake, 'claude-config')
  let api: ReturnType<typeof Bun.serve>
  const BUN = Bun.which('bun')!

  // A stdio MCP server in a few lines: initialize and an empty tool list.
  const serverJs = join(fake, 'tiny-mcp.js')
  const SERVER = `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;let r={};if(m.method==='initialize')r={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'tiny',version:'1'}};else if(m.method==='tools/list')r={tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n')}})`

  beforeAll(() => {
    for (const d of [workdir, configDir]) mkdirSync(d, { recursive: true })
    writeFileSync(serverJs, SERVER)
    api = Bun.serve({ port: 0, fetch: async req => {
      const body: any = await req.json().catch(() => ({}))
      await Bun.sleep(3000)   // a plugin's server started through `bun run … start` needs a moment to connect before the run ends
      const m = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
      if (!new URL(req.url).pathname.includes('/messages')) return Response.json({})
      if (!body.stream) return Response.json(m)
      const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`
      return new Response(ev('message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null } }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) + ev('message_stop', { type: 'message_stop' }), { headers: { 'content-type': 'text/event-stream' } })
    } })
  })
  afterAll(() => { api?.stop(true); rmSync(fake, { recursive: true, force: true }) })

  /** One `claude -p` run: the settings' allowlist, servers by `--mcp-config` and plugins by `--plugin-dir`. Returns the debug file's lines about MCP and settings. */
  async function run(allow: unknown[], opts: { mcp?: Record<string, unknown>; plugin?: { dir: string }; env?: Record<string, string>; extraArgs?: string[] } = {}): Promise<{ log: string; lines: string[]; code: number; out: string }> {
    const id = Math.random().toString(36).slice(2)
    const settings = join(fake, `settings-${id}.json`), debug = join(fake, `debug-${id}.log`)
    writeFileSync(settings, JSON.stringify({ allowedMcpServers: allow, disableClaudeAiConnectors: true }))
    const args = ['-p', 'go', '--output-format', 'json', '--dangerously-skip-permissions', '--settings', settings, '--debug-file', debug]
    if (opts.mcp) { const f = join(fake, `mcp-${id}.json`); writeFileSync(f, JSON.stringify({ mcpServers: opts.mcp })); args.push('--mcp-config', f) }
    if (opts.plugin) args.push('--plugin-dir', opts.plugin.dir)
    if (opts.extraArgs) args.push(...opts.extraArgs)
    const p = Bun.spawn(['claude', ...args], { cwd: workdir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { PATH: process.env.PATH!, USER: process.env.USER ?? 'user', HOME: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: 'sk-ant-fake', CLAUDE_CONFIG_DIR: configDir, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ...opts.env } })
    const timer = setTimeout(() => p.kill(), 90_000)   // only the process this test started, by its own handle
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    clearTimeout(timer)
    let log = ''
    try { log = readFileSync(debug, 'utf8') } catch { /* no file */ }
    const lines = log.split('\n').filter(l => /MCP server|Server stderr|claudeai-mcp|plugin\\.register|cachedbridge|Skipped|skipping plugin|Plugin .* (not|failed)|\[STARTUP\] (Loading|MCP configs)|allowedMcpServers|Settings (Warning|Error)|not allowed|blocked|denied by|allowlist/i.test(l)).map(l => l.replace(/^\S+ \[\w+\] /, ''))
    return { log, lines, code, out }
  }
  const say = (title: string, r: { lines: string[] }) => process.stdout.write(`\n## ${title}\n${r.lines.map(l => `  ${l.slice(0, 220)}`).join('\n')}\n`)

  // A plugin whose MCP server is declared through the plugin's own manifest, as hydra's bridge is, with `${CLAUDE_PLUGIN_ROOT}` in its command.
  function plugin(name: string): { dir: string; command: string[] } {
    const dir = join(fake, `plugin-${name}`)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    const args = [serverJs.replace(fake, '${CLAUDE_PLUGIN_ROOT}/..')]
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.0.1', description: 'probe', mcpServers: { [name]: { command: BUN, args } } }))
    return { dir, command: [BUN, ...args.map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', dir))] }
  }

  test('a server by name is admitted; one not listed is not; connectors are off by the environment variable', async () => {
    const r = await run([{ serverName: 'alpha' }], { mcp: { alpha: { type: 'stdio', command: BUN, args: [serverJs] }, beta: { type: 'stdio', command: BUN, args: [serverJs] } } })
    say('serverName alpha allowed; alpha and beta declared', r)
    const got = readLoaded(r.log)
    expect(got.connected).toContain('alpha')
    expect([...got.servers, ...got.connected]).not.toContain('beta')
    expect(got.connectorsOff).toBe(true)
    expect(r.log).not.toMatch(/Settings Warning/i)
  }, 120_000)

  test('a plugin\'s server is admitted by the exact command it runs (substituted), and refused when the entry matches nothing', async () => {
    const p = plugin('probebridge')
    const ok = await run([{ serverCommand: p.command }], { plugin: p })
    say('serverCommand = the substituted command', ok)
    const no = await run([{ serverName: 'alpha' }, { serverCommand: [...p.command].reverse() }], { plugin: p })
    say('serverCommand with the arguments reversed', no)
    expect(readLoaded(ok.log).connected.join()).toContain('probebridge')
    expect(readLoaded(no.log).connected.join()).not.toContain('probebridge')
  }, 120_000)

  // #772: once any serverCommand entry exists (the bridge's), a stdio server is matched by its full command and a serverName entry no longer admits it.
  test('beside a serverCommand entry, a stdio server is admitted by its own command and not by its name', async () => {
    const p = plugin('probebridge3')
    const mcp = { alpha: { type: 'stdio', command: BUN, args: [serverJs] } }
    const byName = await run([{ serverName: 'alpha' }, { serverCommand: p.command }], { plugin: p, mcp })
    say('serverName alpha + the bridge by command', byName)
    const byCommand = await run([{ serverCommand: [BUN, serverJs] }, { serverCommand: p.command }], { plugin: p, mcp })
    say('serverCommand for alpha + the bridge by command', byCommand)
    expect(readLoaded(byName.log).connected).not.toContain('alpha')
    expect(readLoaded(byName.log).connected.join()).toContain('probebridge3')
    expect(readLoaded(byCommand.log).connected).toContain('alpha')
    expect(readLoaded(byCommand.log).connected.join()).toContain('probebridge3')
  }, 120_000)

  // #774: an operator's own server of the listed name but another command is not admitted by the listed command's entry, and does not take the listed one's place, whichever
  // file declares it. The two servers tell themselves apart by the name they report on initialize ("tiny" is hydra's, "operator-tiny" the operator's).
  test('an operator server of the same name and another command does not start or take the place of the listed one; with the same command it is the same server', async () => {
    const operatorJs = join(fake, 'operator-tiny-mcp.js')
    writeFileSync(operatorJs, SERVER.replace("name:'tiny'", "name:'operator-tiny'"))
    const listed = { type: 'stdio', command: BUN, args: [serverJs] }
    const theirs = { type: 'stdio', command: BUN, args: [operatorJs] }
    const who = (log: string) => ['"name":"tiny"', '"name":"operator-tiny"'].filter(n => log.includes(n)).map(n => n.slice(8, -1))
    const declare = (where: 'user' | 'project' | 'local', server: object) => {
      for (const f of [join(home, '.claude.json'), join(configDir, '.claude.json')]) rmSync(f, { force: true })
      rmSync(join(workdir, '.mcp.json'), { force: true })
      const cj: any = { hasCompletedOnboarding: true, projects: { [workdir]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['alpha'], ...(where === 'local' ? { mcpServers: { alpha: server } } : {}) } } }
      if (where === 'user') cj.mcpServers = { alpha: server }
      for (const f of [join(home, '.claude.json'), join(configDir, '.claude.json')]) writeFileSync(f, JSON.stringify(cj))
      if (where === 'project') writeFileSync(join(workdir, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: server } }))
    }
    const results: Record<string, string[]> = {}
    for (const where of ['user', 'project', 'local'] as const) {
      declare(where, theirs)
      const r = await run([{ serverCommand: [BUN, serverJs] }], { mcp: { alpha: listed } })
      say(`${where}-scope alpha with another command; hydra's allowlist = the listed command; hydra's alpha by --mcp-config`, r)
      results[where] = who(r.log)
      expect(readLoaded(r.log).connected).toEqual(['alpha'])
    }
    // control: the operator's own command allowed (and not the listed one's): the operator's runs, so the first results are the allowlist's doing and the declaration is read
    declare('user', theirs)
    const control = await run([{ serverCommand: [BUN, operatorJs] }], { mcp: { alpha: listed } })
    say('control: allowlist = the operator\'s command only', control)
    // the same command in both: one server, the listed one's command
    declare('user', listed)
    const same = await run([{ serverCommand: [BUN, serverJs] }], { mcp: { alpha: listed } })
    say('the operator declares the same command', same)
    process.stdout.write(`\n  RESULT ${JSON.stringify({ ...results, control: who(control.log), same: who(same.log), sameConnected: readLoaded(same.log).connected })}\n`)
    expect(results).toEqual({ user: ['tiny'], project: ['tiny'], local: ['tiny'] })
    expect(who(control.log)).toEqual(['operator-tiny'])
    expect(who(same.log)).toEqual(['tiny'])
    expect(readLoaded(same.log).connected).toEqual(['alpha'])
  }, 300_000)

  test('the `${CLAUDE_PLUGIN_ROOT}` form of the entry (what the manifest literally holds)', async () => {
    const p = plugin('probebridge2')
    const literal = [BUN, serverJs.replace(fake, '${CLAUDE_PLUGIN_ROOT}/..')]
    const r = await run([{ serverCommand: literal }], { plugin: p })
    say('serverCommand with the variable left in', r)
    process.stdout.write(`  connected under the variable form: ${readLoaded(r.log).connected.join() || '(none)'}\n`)
  }, 120_000)

  // The way hydra's real bridge is loaded: a plugin in <config>/plugins/cache/<marketplace>/<plugin>/<version>/, installed_plugins.json naming it, enabledPlugins turning it on, its
  // manifest's server command the BARE string `bun` with `${CLAUDE_PLUGIN_ROOT}` in its args (infra/plugin-manifest.ts), run through `start`.
  function cachedPlugin(name: string): { dir: string; bare: string[]; absolute: string[]; literal: string[]; bareMarket: string[]; absoluteMarket: string[] } {
    const market = 'probe-market', version = '0.0.1'
    const dir = join(configDir, 'plugins', 'cache', market, name, version)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, 'server.js'), SERVER)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, scripts: { start: 'bun server.js' } }))
    const args = ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', '--shell=bun', '--silent', 'start']
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version, description: 'probe', mcpServers: { [name]: { command: 'bun', args } } }))
    const id = `${name}@${market}`
    // the marketplace Claude Code resolves the plugin through: a local one, recorded in known_marketplaces.json
    const mp = join(configDir, 'plugins', 'marketplaces', market)
    mkdirSync(join(mp, '.claude-plugin'), { recursive: true })
    const mfile = join(mp, '.claude-plugin', 'marketplace.json')
    let m: any = { name: market, owner: { name: 'probe' }, plugins: [] }
    try { m = JSON.parse(readFileSync(mfile, 'utf8')) } catch { /* new */ }
    if (!m.plugins.some((x: any) => x.name === name)) m.plugins.push({ name, source: `./plugins/${name}`, description: 'probe', version })
    mkdirSync(join(mp, 'plugins', name, '.claude-plugin'), { recursive: true })
    writeFileSync(join(mp, 'plugins', name, '.claude-plugin', 'plugin.json'), readFileSync(join(dir, '.claude-plugin', 'plugin.json')))
    writeFileSync(join(mp, 'plugins', name, 'server.js'), SERVER)
    writeFileSync(join(mp, 'plugins', name, 'package.json'), readFileSync(join(dir, 'package.json')))
    writeFileSync(mfile, JSON.stringify(m))
    const kfile = join(configDir, 'plugins', 'known_marketplaces.json')
    let k: any = {}
    try { k = JSON.parse(readFileSync(kfile, 'utf8')) } catch { /* new */ }
    k[market] = { source: { source: 'directory', path: mp }, installLocation: mp, lastUpdated: '2026-01-01T00:00:00.000Z' }
    writeFileSync(kfile, JSON.stringify(k))
    const file = join(configDir, 'plugins', 'installed_plugins.json')
    let cur: any = { version: 2, plugins: {} }
    try { cur = JSON.parse(readFileSync(file, 'utf8')) } catch { /* new */ }
    cur.plugins[id] = [{ scope: 'user', installPath: dir, version, installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' }]
    writeFileSync(file, JSON.stringify(cur))
    const sf = join(configDir, 'settings.json')
    let st: any = {}
    try { st = JSON.parse(readFileSync(sf, 'utf8')) } catch { /* new */ }
    st.enabledPlugins = { ...(st.enabledPlugins ?? {}), [id]: true }
    writeFileSync(sf, JSON.stringify(st))
    const resolved = args.map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', dir))
    const mdir = join(mp, 'plugins', name), mres = args.map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', mdir))
    return { dir, bare: ['bun', ...resolved], absolute: [BUN, ...resolved], literal: ['bun', ...args], bareMarket: ['bun', ...mres], absoluteMarket: [BUN, ...mres] }
  }

  test('the real bridge\'s shape: a cached, installed, enabled plugin whose command is the bare string `bun`: which entry form admits it', async () => {
    const p = cachedPlugin('cachedbridge')
    const out: Record<string, string[]> = {}
    const control = await run(undefined as any)   // no allowlist at all: does the plugin load and its server start?
    say('cached plugin, NO allowlist (control)', control)
    out.control = readLoaded(control.log).connected
    const strict = await run(undefined as any, { extraArgs: ['--strict-mcp-config'] })   // does --strict-mcp-config drop a plugin's server?
    say('cached plugin, NO allowlist, with --strict-mcp-config', strict)
    out.strict = readLoaded(strict.log).connected
    for (const [form, command] of [['bare bun, cache dir', p.bare], ['absolute bun, cache dir', p.absolute], ['bare bun, marketplace dir', p.bareMarket], ['absolute bun, marketplace dir', p.absoluteMarket], ['bare bun, ${CLAUDE_PLUGIN_ROOT} left in', p.literal]] as const) {
      const r = await run([{ serverCommand: command }])
      say(`cached plugin, entry = ${form}`, r)
      out[form] = readLoaded(r.log).connected
    }
    process.stdout.write(`\n  RESULT ${JSON.stringify(out)}\n`)
    // proven against the real Claude Code: the plugin starts with no allowlist; the entry holding the manifest's own command string (bare `bun`) and the plugin root Claude Code used is admitted; an absolute bun path, another root and a left-in variable are not
    expect(out.control).toEqual(['plugin:cachedbridge:cachedbridge'])
    expect(out.strict).toEqual([])   // --strict-mcp-config drops a plugin's server, the bridge's kind: why hydra does not use it for the bridge
    expect(out['bare bun, marketplace dir']).toEqual(['plugin:cachedbridge:cachedbridge'])
    for (const f of ['absolute bun, cache dir', 'absolute bun, marketplace dir', 'bare bun, cache dir', 'bare bun, ${CLAUDE_PLUGIN_ROOT} left in']) expect(out[f]).toEqual([])
  }, 120_000)

  test('the colon-named entry of the regression: what Claude Code does with it', async () => {
    const r = await run([{ serverName: 'plugin:probe:probe' }], { mcp: { alpha: { type: 'stdio', command: BUN, args: [serverJs] } } })
    say('serverName with colons', r)
    process.stdout.write(`  exit ${r.code}; settings warning in the debug file: ${/Settings (Warning|Error)|Invalid entry/i.test(r.log)}\n`)
  }, 120_000)
})

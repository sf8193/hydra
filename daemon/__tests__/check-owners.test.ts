import { describe, test, expect } from 'bun:test'
import { violations } from '../../scripts/check-owners.js'

const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') })
const hits = (path: string, ...lines: string[]) => violations([file(path, ...lines)])

describe('check-owners: kill-server needs -S (no exemption, tests included)', () => {
  // This rule's hits only: these fixtures' raw sync execs are the raw-sync rule's to catch.
  const hits = (path: string, ...lines: string[]) => violations([file(path, ...lines)]).filter(v => v.includes('kill-server without -S'))
  test("the line that killed every live session (Sep 28), in the real file it was in", () => {
    const v = hits('test-setup.ts', "  try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: join(stateDir, 'tmux'), TMUX: '' } }) } catch {}")
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('kill-server without -S')
  })

  test('caught in tests too, in shell scripts, in shell strings and double quotes', () => {
    expect(hits('daemon/__tests__/a.test.ts', "execFileSync('tmux', ['kill-server'])")).toHaveLength(1)
    expect(hits('stop-byte.sh', 'tmux kill-server')).toHaveLength(1)
    expect(hits('daemon/x.ts', 'execSync(`tmux kill-server`)')).toHaveLength(1)
    expect(hits('daemon/x.ts', 'execFileSync("tmux", ["kill-server"])')).toHaveLength(1)
  })

  test('a -S in an earlier tmux call does not count (hydra has no semicolons)', () => {
    expect(hits('daemon/x.ts', "x('-S'); execFileSync('tmux', ['kill-server'])")).toHaveLength(1)
    expect(hits('daemon/x.ts', "const has = execFileSync('tmux', ['-S', sock, 'ls'])", "execFileSync('tmux', ['kill-server'], { env })")).toHaveLength(1)
    expect(hits('daemon/x.ts', "tmux(['-S', sock, 'list-sessions'])", "tmux(['kill-server'])")).toHaveLength(1)
  })

  test('a socket path containing "tmux-" does not end the call; a tmuxBin variable counts as tmux', () => {
    expect(hits('daemon/x.ts', "execFileSync('tmux', ['-S', join(dir, `tmux-${uid}`, 'default'), 'kill-server'])")).toEqual([])
    expect(hits('scripts/x.ts', "execFileSync(tmuxBin, ['-S', socket, 'kill-server'])")).toEqual([])
    expect(hits('daemon/x.ts', "const args = ['kill-server']")).toHaveLength(1)
  })

  test('by exact socket is fine — same line, wrapped, double-quoted, or in a shell string', () => {
    expect(hits('daemon/x.ts', "execFileSync('tmux', ['-S', socket, 'kill-server'])")).toEqual([])
    expect(hits('daemon/x.ts', "execFileSync('tmux', ['-S', socket,", "  'kill-server'])")).toEqual([])
    expect(hits('daemon/x.ts', 'execFileSync("tmux", ["-S", socket, "kill-server"])')).toEqual([])
    expect(hits('x.sh', 'tmux -S "$sock" kill-server')).toEqual([])
  })

  test('comments are ignored', () => {
    expect(hits('daemon/x.ts', '// never run tmux kill-server without a socket')).toEqual([])
  })
})

describe('check-owners: deleting work only in worktree-manager', () => {
  const spellings = [
    "await execAsync('git', ['-C', repo, 'branch', '-D', b])",
    "await execAsync('git', ['-C', repo, 'branch', '-d', b])",
    'await execAsync("git", ["-C", repo, "branch", "--delete", b])',
    'execSync(`git branch -D ${b}`)',
    "execAsync('git', ['-C', repo, 'worktree', 'remove', p])",
    "execAsync('git', ['-C', repo, 'worktree', 'prune'])",
  ]
  for (const line of spellings) {
    test(`caught outside the owner: ${line}`, () => { expect(hits('daemon/factory.ts', line)).toHaveLength(1) })
  }
  test('split across lines is caught', () => {
    expect(hits('daemon/factory.ts', "execAsync('git', ['-C', repo,", "  'branch', '-D', b])")).toHaveLength(1)
  })
  test('an unrelated -d near the word branch is not a git delete', () => {
    expect(hits('daemon/x.ts', 'const branch = pick()', "execFileSync('curl', ['-d', body])")).toEqual([])
  })

  test('in shell scripts too; allowed in worktree-manager', () => {
    expect(hits('cleanup.sh', 'git worktree remove "$wt"')).toHaveLength(1)
    expect(hits('infra/worktree-manager.ts', ...spellings)).toEqual([])
  })
})

describe('check-owners: raw tmux liveness and exec only in owners', () => {
  test('a new raw tmux liveness gate is caught (with or without a space); owners, imports and the definition pass', () => {
    expect(hits('connectors/github/pr-watch.ts', "if (tmuxSessionState(n) === 'dead') continue")).toHaveLength(1)
    expect(hits('connectors/github/pr-watch.ts', 'if (owner && tmuxHasSession(owner.tmuxName)) continue')).toHaveLength(1)
    expect(hits('connectors/github/pr-watch.ts', 'if (tmuxHasSession (n)) continue')).toHaveLength(1)
    expect(hits('connectors/github/pr-watch.ts', "import { tmuxHasSession as t } from './tmux.js'")).toEqual([])
    expect(hits('infra/tmux.ts', 'return tmuxHasSession(info.tmuxName)')).toEqual([])
    expect(hits('daemon/x.ts', 'export function tmuxHasSession(name: string): boolean {')).toEqual([])
  })

  test('has-session is asked only in infra/tmux.ts: any form, anywhere else, is caught', () => {
    const asked = (path: string, line: string) => hits(path, line).filter(v => v.includes('tmux has-session outside infra/tmux.ts'))
    expect(asked('app/router.ts', "execFileSync('tmux', ['has-session', '-t', n])")).toHaveLength(1)
    expect(asked('app/router.ts', 'execSync(`tmux has-session -t ${n}`)')).toHaveLength(1)
    expect(asked('engines/claude-engine.ts', "tmuxSync(['has-session', '-t', n], { ignoreHold: true })")).toHaveLength(1)
    expect(asked('infra/tmux.ts', "tmuxSync(['has-session', '-t', name], opts)")).toEqual([])
    expect(asked('infra/util.ts', "tmuxSync(['has-session', '-t', name], opts)")).toHaveLength(1)
    expect(asked('cli/helpers.ts', "execFileSync('tmux', ['has-session', '-t', name])")).toEqual([])
  })

  test('a raw kill-session/window/pane exec is caught, in any quoting; infra/tmux.ts and tmuxSync pass', () => {
    const kills = (path: string, line: string) => hits(path, line).filter(v => v.includes('raw tmux kill-session'))
    expect(kills('app/router.ts', 'execFileSync("tmux", ["kill-window", "-t", n])')).toHaveLength(1)
    expect(kills('sessions/registry.ts', "execFileSync('tmux', ['kill-session', '-t', n])")).toHaveLength(1)
    expect(kills('sessions/registry.ts', "tmuxSync(['kill-session', '-t', n])")).toEqual([])
    expect(kills('infra/tmux.ts', "execFileSync('tmux', ['kill-session', '-t', n])")).toEqual([])
  })

  test('a raw sync tmux exec is caught in the daemon, wrapped or in a shell string; infra/tmux.ts, the CLI and tmuxSync pass', () => {
    const raw = (path: string, ...lines: string[]) => hits(path, ...lines).filter(v => v.includes('raw sync tmux exec'))
    expect(raw('daemon/foo.ts', "execFileSync('tmux', ['list-panes'], { timeout: 2000 })")).toHaveLength(1)
    expect(raw('app/reply-guard.ts', 'return execSync(', '  `tmux capture-pane -t ${t} -p`,', ')')).toHaveLength(1)
    expect(raw('app/cli-handler.ts', "Bun.spawnSync(['tmux', 'list-sessions'])")).toHaveLength(1)
    expect(raw('daemon/foo.ts', "tmuxSync(['list-panes'])")).toEqual([])
    expect(raw('infra/tmux.ts', "execFileSync('tmux', args)")).toEqual([])
    expect(raw('cli/lifecycle.ts', "execFileSync('tmux', ['capture-pane'])")).toEqual([])
  })

  test('tests are exempt from the liveness/exec rules (both test-file shapes)', () => {
    expect(hits('daemon/__tests__/a.test.ts', "execFileSync('tmux', ['has-session', '-t', n])")).toEqual([])
    expect(hits('daemon/__tests__/fake-tmux.ts', 'tmuxHasSession(n)')).toEqual([])
    expect(hits('cli/x.test.ts', 'tmuxHasSession(n)')).toEqual([])
  })
})

describe('check-owners: raw gateway.send() outside safeSend', () => {
  const raw = (path: string, ...lines: string[]) => hits(path, ...lines).filter(v => v.includes('raw gateway.send() outside safeSend'))

  test('caught in non-owner daemon files (same line, spaced, optional-chained, cast, or wrapped)', () => {
    expect(raw('app/router.ts', "void gateway.send(msg.channelId, 'hi')")).toHaveLength(1)
    expect(raw('app/commands/global.ts', "await gateway.send (ch, 'hi')")).toHaveLength(1)
    expect(raw('app/router.ts', "await gateway?.send(ch, 'hi')")).toHaveLength(1)
    expect(raw('app/router.ts', "await (gateway as any).send(ch, 'hi')")).toHaveLength(1)
    expect(raw('app/commands/thread.ts', 'await gateway.send(', "  ch, 'hi',", ')')).toHaveLength(1)
  })

  test('capped files pass up to their limit and fail when a new raw send is added', () => {
    expect(raw('app/bridge-dispatch.ts', 'gateway.send(a, b)', 'gateway.send(a, b)', 'gateway.send(a, b)')).toEqual([])
    expect(raw('app/bridge-dispatch.ts', 'gateway.send(a, b)', 'gateway.send(a, b)', 'gateway.send(a, b)', 'gateway.send(a, b)')).toHaveLength(1)
    expect(raw('app/session-lifecycle.ts', 'gateway.send(a, b)')).toEqual([])
    expect(raw('app/session-lifecycle.ts', 'gateway.send(a, b)', 'gateway.send(a, b)')).toHaveLength(1)
  })

  test('allowed in safeSend and tests; gateway.sendDM and comments pass', () => {
    expect(raw('infra/util.ts', "await gateway.send(channelId, chunks[i], opts)")).toEqual([])
    expect(raw('daemon/__tests__/a.test.ts', "spyOn(gateway, 'send'); await gateway.send('t1', 'hi')")).toEqual([])
    expect(raw('app/router.ts', "await gateway.sendDM(userId, 'hi')")).toEqual([])
    expect(raw('app/router.ts', '// never call gateway.send directly')).toEqual([])
  })
})

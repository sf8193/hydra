// Vitals against a real tmux server and real processes: the pane root tmux reports for a session,
// and the RSS summed over a three-level tree, each checked against the per-process reads
// (`list-panes -t`, `pgrep -P`, `ps -o rss= -p`) the snapshot replaced.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { PANE_ROOTS_FORMAT, parsePaneRoots, vitalsSnapshot } from '../vitals-snapshot.js'
import { tmuxNewSession } from '../../shared/spawn-env.js'

const available = Bun.spawnSync(['tmux', '-V']).exitCode === 0
let dir = ''
let socket = ''
const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX }
// Explicitly this test's own server: TMUX would point tmux at the server the suite runs inside.
const tmuxEnv = () => { const { TMUX: _, ...env } = process.env; return { ...env, TMUX_TMPDIR: dir } }
const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8', env: tmuxEnv() }).trim()
const sh = (cmd: string, ...args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim() } catch { return '' } }

beforeAll(() => {
  if (!available) return
  dir = mkdtempSync('/tmp/hvt-')
  process.env.TMUX_TMPDIR = dir
  delete process.env.TMUX
  socket = join(dir, `tmux-${process.getuid!()}`, 'default')
})

afterAll(() => {
  if (!available) return
  try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'pipe' }) } catch {}
  rmSync(dir, { recursive: true, force: true })
  if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR
  if (saved.TMUX) process.env.TMUX = saved.TMUX
})

test.if(available)('the pane root is what `list-panes -t <session>` lists first: the active window\'s first pane', () => {
  tmuxNewSession(['-d', '-s', 'multi', 'sleep 300'])
  const second = tmux('new-window', '-P', '-F', '#{pane_id}', '-t', 'multi', 'sleep 300')
  // -b puts the new pane first, so the first pane is neither the oldest nor (after select-pane) the active one.
  const first = tmux('split-window', '-b', '-P', '-F', '#{pane_id}', '-t', second, 'sleep 300')
  tmux('select-pane', '-t', second)
  const roots = parsePaneRoots(tmux('list-panes', '-a', '-F', PANE_ROOTS_FORMAT))
  const before = Number(tmux('list-panes', '-t', 'multi', '-F', '#{pane_pid}').split('\n')[0])
  expect(roots.get('multi')).toBe(before)
  expect(roots.get('multi')).toBe(Number(tmux('display-message', '-p', '-t', first, '#{pane_pid}')))
})

test.if(available)('RSS sums a three-level pane tree, as the per-process walk did', async () => {
  // pane shell → sh → bun holding 64 MB, so a sum that stopped at the root or its children would be far off.
  const hold = `"${process.execPath}" -e "globalThis.b = Buffer.alloc(64 << 20, 1); setInterval(() => {}, 1e6)"`
  tmuxNewSession(['-d', '-s', 'vit-rss', `sh -c '${hold} & wait' & wait`])
  const root = Number(tmux('list-panes', '-t', 'vit-rss', '-F', '#{pane_pid}').split('\n')[0])

  const walkAsBefore = () => {
    const subtree: number[] = []
    for (const queue = [root]; queue.length;) {
      for (const kid of sh('pgrep', '-P', String(queue.shift()!)).split('\n').filter(Boolean).map(Number)) { subtree.push(kid); queue.push(kid) }
    }
    const rssKb = [root, ...subtree].reduce((n, p) => n + (Number(sh('ps', '-o', 'rss=', '-p', String(p))) || 0), 0)
    return { subtree, pid: subtree[0] ?? root, rssMB: Math.round(rssKb / 1024) }
  }
  let before = walkAsBefore()
  for (let i = 0; i < 100 && (before.subtree.length < 2 || before.rssMB < 64); i++) { await Bun.sleep(100); before = walkAsBefore() }
  expect(before.subtree.length).toBe(2)
  expect(before.rssMB).toBeGreaterThanOrEqual(64)

  const v = (await vitalsSnapshot()).pane('vit-rss')
  expect(v.panePid).toBe(root)
  expect(v.pid).toBe(before.pid)
  // Separate reads a moment apart: allow a little drift, far less than the 64 MB leaf.
  expect(Math.abs(v.rssMB! - before.rssMB)).toBeLessThanOrEqual(2)
}, 20_000)

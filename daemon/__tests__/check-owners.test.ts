import { describe, test, expect } from 'bun:test'
import { violations } from '../../scripts/check-owners.js'

const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') })

describe('check-owners', () => {
  test("the line that killed every live session (Sep 28) is caught anywhere", () => {
    const v = violations([file('test-setup.x.ts', "execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: dir } })")])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('kill-server without -S')
  })

  test('kill-server by exact socket is fine', () => {
    expect(violations([file('daemon/x.ts', "execFileSync('tmux', ['-S', socket, 'kill-server'])")])).toEqual([])
  })

  test('deleting branches/worktrees outside worktree-manager is caught; inside is fine', () => {
    const line = "await execAsync('git', ['-C', repo, 'branch', '-D', b])"
    expect(violations([file('daemon/factory.ts', line)])).toHaveLength(1)
    expect(violations([file('daemon/worktree-manager.ts', line)])).toEqual([])
    expect(violations([file('daemon/factory.ts', "execAsync('git', ['-C', r, 'worktree', 'remove', p])")])).toHaveLength(1)
  })

  test('a new raw tmux liveness gate is caught; existing owners pass', () => {
    expect(violations([file('daemon/pr-watch.ts', 'if (owner && tmuxHasSession(owner.tmuxName)) continue')])).toHaveLength(1)
    expect(violations([file('daemon/util.ts', 'return tmuxHasSession(info.tmuxName)')])).toEqual([])
    expect(violations([file('daemon/router.ts', "execFileSync('tmux', ['has-session', '-t', n])")])).toHaveLength(1)
  })

  test('tests are exempt', () => {
    expect(violations([file('daemon/__tests__/a.test.ts', "execFileSync('tmux', ['kill-server'])")])).toEqual([])
  })
})

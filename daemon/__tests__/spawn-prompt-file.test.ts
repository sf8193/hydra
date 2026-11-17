// The spawn prompt reaches a pane by file: no part of it is on a command line the daemon builds, and what the session receives
// is the prompt byte for byte. The wrapper is run for real (tmux shimmed to `sh -c` the command, `claude` and `omp` stubbed to
// write their argv and environment out), so the proof is what a process would see, not what a string contains.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { OmpEngine } from '../engines/omp-engine.js'
import { STATE_DIR } from '../config.js'
import { removeLaunchFiles, spawnPromptDir } from '../launch-files.js'
import { PolicyRefusal, policyIdFor, type ConfinedPolicy } from '../restricted.js'
import { _setLoadEnvForTesting } from '../hydra-config.js'
import { macLike } from './sandbox-host.js'

process.stderr.write = (() => true) as any

const MARKER = 'distinctive-marker-7f3a9c'
const SID = '11111111-1111-4111-8111-111111111111'
const base = { sessionId: SID, tmuxName: 'sp-t', model: 'claude-opus-4-1' }

// Prompts a shell would mangle if the text were ever interpreted.
const HARD: Record<string, string> = {
  'single quote': `it's ${MARKER}`,
  'double quote and backslash': `say "hi" \\ \\n ${MARKER}`,
  'newlines, trailing ones kept': `line one\n\nline three ${MARKER}\n\n`,
  'dollar and backticks': 'cost $HOME ${PATH} `echo pwned` $(echo pwned) ' + MARKER,
  'leading dash': `--dangerously-bad ${MARKER}`,
  'unicode': `naive café 日本語 🚀 ${MARKER}`,
  'only spaces': '   ',
  // Linux caps a single argument or environment string at 128 KB (MAX_ARG_STRLEN), a limit the prompt as an argument always met;
  // macOS has none. 100 KB is the largest size that runs on both.
  'very long (100 KB)': `${MARKER} ` + 'x'.repeat(100_000) + '\nend',
}

let dir: string
let argvOut: string
const saved = { PATH: process.env.PATH, TMUX: process.env.TMUX }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hydra-spf-'))
  argvOut = join(dir, 'argv')
  // tmux: new-session runs its command the way tmux does (sh -c), synchronously; has-session says yes; every call is logged.
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\0' "$@" >> ${join(dir, 'tmux-argv')}\nprintf '\\n' >> ${join(dir, 'tmux-argv')}\ncase "$1" in new-session) sh -c "$5" ;; has-session) exit 0 ;; esac\n`)
  // claude and omp: record the argv (NUL-separated) and the environment's prompt variable.
  for (const bin of ['claude', 'omp']) {
    writeFileSync(join(dir, bin), `#!/bin/sh\n: > ${argvOut}.${bin}\nfor a in "$@"; do printf '%s\\0' "$a" >> ${argvOut}.${bin}; done\nprintf '%s' "$HYDRA_SPAWN_PROMPT" > ${argvOut}.${bin}.env\n`)
  }
  for (const f of ['tmux', 'claude', 'omp']) chmodSync(join(dir, f), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  delete process.env.TMUX
  process.env.HYDRA_OMP_BIN = join(dir, 'omp')
  rmSync(spawnPromptDir(), { recursive: true, force: true })
  mkdirSync(join(STATE_DIR, 'mods', 'hydra'), { recursive: true }); writeFileSync(join(STATE_DIR, 'mods', 'hydra', 'plugin.json'), '{}')
  mkdirSync(join(STATE_DIR, 'spawn-logs'), { recursive: true })
})
afterEach(() => {
  process.env.PATH = saved.PATH
  if (saved.TMUX !== undefined) process.env.TMUX = saved.TMUX
  delete process.env.HYDRA_OMP_BIN
  _setLoadEnvForTesting(undefined)
  rmSync(dir, { recursive: true, force: true })
})

const tmuxCalls = () => (existsSync(join(dir, 'tmux-argv')) ? readFileSync(join(dir, 'tmux-argv'), 'utf8') : '')
const claudeArgv = () => readFileSync(`${argvOut}.claude`, 'utf8').split('\0').slice(0, -1)
const launchClaude = (extra: object) => new ClaudeEngine({} as any).launch({ ...base, cwd: dir, originalCwd: dir, ...extra } as any)
const launchOmp = (extra: object) => new OmpEngine({} as any).launch({ ...base, cwd: dir, originalCwd: dir, ...extra } as any)

describe('Claude: the prompt is absent from every command line, and arrives unchanged', () => {
  for (const [name, prompt] of Object.entries(HARD)) {
    test.each([['fresh', {}], ['fork', { forkFrom: { claudeSessionId: 'C-parent' } }]] as [string, { forkFrom?: { claudeSessionId: string } }][])(`${name}, %s`, async (_shape, extra) => {
      await launchClaude({ prompt, ...extra })
      expect(tmuxCalls()).not.toContain(MARKER)
      expect(tmuxCalls()).not.toContain('pwned')
      const argv = claudeArgv()
      expect(argv).toContain(prompt)                       // one word, every byte as given
      expect(argv.filter(a => a === prompt)).toHaveLength(1)
      // Nothing around it moved: the first word of a fresh start is the session id flag, of a fork the parent.
      expect(argv[0]).toBe(extra.forkFrom ? '--resume' : '--session-id')
    })
  }

  test('with a tool list, a disallow list and a worktree note the prompt is the one word after the permission flag', async () => {
    await launchClaude({ prompt: HARD['single quote'], tools: ['Read'], disallowedTools: ['Bash'] })
    const argv = claudeArgv()
    expect(argv[argv.indexOf('--dangerously-skip-permissions') + 1]).toBe(HARD['single quote'])
    expect(tmuxCalls()).not.toContain(MARKER)
  })

  test('a resume takes no prompt: no file, no read step', async () => {
    await launchClaude({ prompt: `resume ${MARKER}`, resumeFrom: 'C-old' })
    expect(existsSync(spawnPromptDir()) ? readdirSync(spawnPromptDir()) : []).toEqual([])
    expect(tmuxCalls()).not.toContain('_hydra_prompt')
    expect(claudeArgv()).toEqual(['--resume', 'C-old', '--model', 'claude-opus-4-1', '--channels', expect.any(String), '--dangerously-skip-permissions', '--debug-file', expect.any(String)])
  })

  test('a restricted kickoff (preamble + prompt) arrives whole, and the command line holds none of it', async () => {
    const servers: ConfinedPolicy['servers'] = []
    const policy: ConfinedPolicy = { specialist: 'ops', restricted: true, workdir: dir, tools: ['Read'], servers, id: policyIdFor(dir, ['Read'], servers) }
    _setLoadEnvForTesting(macLike())
    await launchClaude({ prompt: `ops ${MARKER}`, policy, sessionType: 'thread_owner' })
    expect(tmuxCalls()).not.toContain(MARKER)
    const word = claudeArgv().find(a => a.includes(MARKER))!
    expect(word.endsWith(`ops ${MARKER}`)).toBe(true)
    expect(word.length).toBeGreaterThan(`ops ${MARKER}`.length)   // the fixed preamble leads it
  })

  test('an unreadable prompt file stops the chain: claude does not start with an empty prompt', async () => {
    // The file is gone by the time the pane's shell reads it.
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\ncase "$1" in new-session) rm -f '${join(spawnPromptDir(), `sp-t-${SID}.prompt`)}'; sh -c "$5" ;; has-session) exit 0 ;; esac\n`)
    // (Real tmux reports a pane's exit as a dead session; the shim lets the shell's failure through as the command's.)
    await expect(launchClaude({ prompt: 'x' })).rejects.toThrow(/No such file/)
    expect(existsSync(`${argvOut}.claude`)).toBe(false)
  })
})

describe('omp: the prompt is in the environment, read from the file, and absent from the command line', () => {
  for (const [name, prompt] of Object.entries(HARD)) {
    test(name, async () => {
      await launchOmp({ prompt })
      expect(tmuxCalls()).not.toContain(MARKER)
      expect(readFileSync(`${argvOut}.omp.env`, 'utf8')).toBe(prompt)
    })
  }
  test('no prompt, no file', async () => {
    await launchOmp({ prompt: '' })
    expect(existsSync(spawnPromptDir()) ? readdirSync(spawnPromptDir()) : []).toEqual([])
  })
})

describe('the file: private, replaced by the next launch of the name, removed with the session or a failed launch', () => {
  const files = () => (existsSync(spawnPromptDir()) ? readdirSync(spawnPromptDir()).sort() : [])

  test('0600 in a 0700 folder, whatever the umask, and the content is the prompt as given', async () => {
    const before = process.umask(0o000)
    try { await launchClaude({ prompt: `it's ${MARKER}\n` }) } finally { process.umask(before) }
    expect(files()).toEqual([`sp-t-${SID}.prompt`])
    expect(statSync(join(spawnPromptDir(), files()[0])).mode & 0o777).toBe(0o600)
    expect(statSync(spawnPromptDir()).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(spawnPromptDir(), files()[0]), 'utf8')).toBe(`it's ${MARKER}\n`)
  })

  test("a launch replaces its session name's earlier file, and leaves other names (a prefix included) alone", async () => {
    const other = '33333333-3333-4333-8333-333333333333', second = '22222222-2222-4222-8222-222222222222'
    await launchClaude({ prompt: 'a' })
    await launchClaude({ prompt: 'b', tmuxName: 'sp-t-eu', sessionId: other })
    await launchClaude({ prompt: 'c', sessionId: second })
    expect(files()).toEqual([`sp-t-${second}.prompt`, `sp-t-eu-${other}.prompt`])
  })

  test('removeLaunchFiles removes exactly one session\'s file, and is quiet when there is none', async () => {
    const second = '22222222-2222-4222-8222-222222222222'
    await launchClaude({ prompt: 'a' })
    await launchClaude({ prompt: 'b', tmuxName: 'other', sessionId: second })
    removeLaunchFiles({ tmuxName: 'sp-t', sessionId: SID })
    removeLaunchFiles({ tmuxName: 'sp-t', sessionId: SID })
    expect(files()).toEqual([`other-${second}.prompt`])
  })

  test('removeLaunchFiles is a no-op in a process that does not own the state dir', async () => {
    await launchClaude({ prompt: 'a' })
    removeLaunchFiles({ tmuxName: 'sp-t', sessionId: SID }, false)
    expect(files()).toHaveLength(1)
  })

  // One engine per test, and different session ids: the two engines would otherwise write and remove the same path.
  const tmuxRefuses = () => writeFileSync(join(dir, 'tmux'), '#!/bin/sh\ncase "$1" in new-session) echo "no server" >&2; exit 1;; esac\n')

  test('a Claude launch tmux refuses leaves no file', async () => {
    tmuxRefuses()
    await expect(launchClaude({ prompt: 'a', sessionId: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow(/failed to spawn tmux session/)
    expect(files()).toEqual([])
  })

  test('an omp launch tmux refuses leaves no file', async () => {
    tmuxRefuses()
    await expect(launchOmp({ prompt: 'a', sessionId: '33333333-3333-4333-8333-333333333333' })).rejects.toThrow()
    expect(files()).toEqual([])
  })

  test('a prompt holding a NUL byte is refused, loudly, on both engines, and leaves no file and starts nothing', async () => {
    await expect(launchClaude({ prompt: 'a\0b' })).rejects.toThrow(/NUL byte/)
    await expect(launchOmp({ prompt: 'a\0b' })).rejects.toThrow(/NUL byte/)
    expect(files()).toEqual([])
    expect(tmuxCalls()).not.toContain('new-session')
  })

  test('a restricted launch the policy refuses leaves no file', async () => {
    const policy: ConfinedPolicy = { specialist: 'ops', restricted: true, workdir: undefined as any, tools: ['Read'], servers: [], id: 'x' }
    await expect(launchClaude({ prompt: 'a', policy })).rejects.toThrow(PolicyRefusal)
    expect(files()).toEqual([])
  })
})

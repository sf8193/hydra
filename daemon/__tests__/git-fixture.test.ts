import { afterAll, describe, test, expect } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { applyHermeticGit } from '../../test-setup.js'
import { fixtureRoot, git, gitCommit, gitInit } from './git-fixture.js'

const LOCKED_SIGNER = '[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tprogram = /bin/false\n[user]\n\tsigningkey = ssh-ed25519 AAAA\n'

const { path: ROOT, cleanup } = fixtureRoot('gf')
afterAll(cleanup)

function write(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

function withEnv(key: string, value: string, body: () => void): void {
  const saved = process.env[key]
  process.env[key] = value
  try { body() } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

function newRepo(name: string): string {
  const repo = join(ROOT, name)
  gitInit(repo)
  return repo
}

describe('applyHermeticGit', () => {
  test('drops inherited GIT_* — they beat any config file — and keeps the rest', () => {
    const env: Record<string, string | undefined> = {
      GIT_DIR: '/someone/elses/.git',
      GIT_WORK_TREE: '/someone/elses',
      GIT_CONFIG_PARAMETERS: "'commit.gpgsign=true'",
      GIT_COMMITTER_NAME: 'Leaked',
      PATH: '/usr/bin',
    }
    applyHermeticGit(env)
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined()
    expect(env.GIT_COMMITTER_NAME).toBe('hydra-test')
    expect(env.PATH, 'a non-git variable must survive').toBe('/usr/bin')
  })

  test('the preload applied it, so the daemon git the tests drive is covered too', () => {
    const want: Record<string, string | undefined> = {}
    applyHermeticGit(want)
    for (const [k, v] of Object.entries(want)) expect(process.env[k]).toBe(v)
    const survivors = Object.keys(process.env).filter(k => k.startsWith('GIT_')).sort()
    expect(survivors).toEqual(Object.keys(want).sort())
  })
})

describe('git fixtures ignore the developer ambient state', () => {
  test('a commit ignores a global config whose signer cannot run', () => {
    const home = join(ROOT, 'hostile-home')
    write(join(home, '.gitconfig'), LOCKED_SIGNER)
    withEnv('HOME', home, () => {
      expect(() => gitCommit(newRepo('home-repo'), 'init', '--allow-empty')).not.toThrow()
    })
  })

  test('a system config cannot reach a fixture either', () => {
    const systemConfig = join(ROOT, 'systemconfig')
    write(systemConfig, LOCKED_SIGNER)
    withEnv('GIT_CONFIG_SYSTEM', systemConfig, () => {
      expect(() => gitCommit(newRepo('system-repo'), 'init', '--allow-empty')).not.toThrow()
    })
  })

  test('neither half of the developer ~/.config/git reaches a fixture', () => {
    const xdg = join(ROOT, 'xdg')
    write(join(xdg, 'git', 'ignore'), '*.txt\n')
    write(join(xdg, 'git', 'attributes'), '* text=auto\n')
    withEnv('XDG_CONFIG_HOME', xdg, () => {
      const repo = newRepo('xdg-repo')
      writeFileSync(join(repo, 'wip.txt'), 'x')
      expect(git(repo, 'status', '--porcelain'), 'a global ignore must not hide a change').toContain('wip.txt')
      expect(git(repo, 'check-attr', 'text', '--', 'wip.txt'), 'a global attribute must not reach the fixture')
        .toBe('wip.txt: text: unspecified')
    })
  })

  test('the git a fixture runs reads the hermetic settings, not the developer machine', () => {
    const repo = newRepo('effective')
    expect(git(repo, 'var', 'GIT_COMMITTER_IDENT')).toMatch(/^hydra-test <hydra-test@invalid> /)
    expect(git(repo, 'var', 'GIT_AUTHOR_IDENT')).toMatch(/^hydra-test <hydra-test@invalid> /)
  })

  test('a failing command throws naming itself and git exit code, not a later assertion', () => {
    const bare = join(ROOT, 'not-a-repo')
    mkdirSync(bare, { recursive: true })
    expect(() => git(bare, 'rev-parse', '--git-dir')).toThrow(/rev-parse --git-dir exited 128: .+/)
  })

  test('a failure that explains itself on stdout still reaches the message', () => {
    const repo = newRepo('stdout')
    gitCommit(repo, 'init', '--allow-empty')
    // Locale-independent: git localises this message onto stdout with stderr empty, so only the tail's existence can be asserted.
    expect(() => gitCommit(repo, 'nothing staged')).toThrow(/commit .*exited 1: .+/)
  })
})

// The Bash layer of a write-confined specialist (`can_only_write_to`): one Seatbelt profile and the wrapper Claude Code runs every shell command
// through (config/bash-sandbox.ts). Most of this runs the real `sandbox-exec`, and the keychain test runs the real `security` against a throwaway
// keychain made in a temp folder: a profile text that merely looks right proves nothing, and the operator's own keychain is never opened.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { SANDBOX_EXEC, sandboxProfile } from '../server-sandbox.js'
import { BASH_KEYCHAIN_DENIES, bashProfile, bashWrapper } from '../bash-sandbox.js'

const SECURITY = '/usr/bin/security'
const HAVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && existsSync(SECURITY)
const same = { realpath: (p: string) => p }
const realEnv = { realpath: (p: string) => { try { return realpathSync(p) } catch { return p } } }

describe('the profile text', () => {
  const text = bashProfile(same, { cannotRead: ['/home/op/.ssh', '/home/op/state'], writable: ['/work/gem', '/var/tmp/T'] })
  test('denies the keychain\'s Mach services by name: the legacy daemon `security` and the credential helpers reach, and the rest of the keychain family', () => {
    for (const d of ['(deny mach-lookup (global-name "com.apple.SecurityServer"))', '(deny mach-lookup (global-name-prefix "com.apple.securityd"))', '(deny mach-lookup (global-name "com.apple.secd"))']) expect(text).toContain(d)
    expect(BASH_KEYCHAIN_DENIES.length).toBeGreaterThan(5)
    for (const d of BASH_KEYCHAIN_DENIES) expect(text).toContain(d)
  })
  test('denies every write except the workdir, the temp folder, the two devices and Claude Code\'s own working-directory marker', () => {
    expect(text).toContain('(deny file-write*)\n(allow file-write*\n  (subpath "/work/gem")\n  (subpath "/var/tmp/T")\n  (literal "/dev/null")\n  (literal "/dev/dtracehelper")\n  (regex #"^/(private/)?tmp/claude-[0-9a-f]+-cwd$"))')
    expect(text.indexOf('(deny file-write*)')).toBeLessThan(text.indexOf('(allow file-write*'))
  })
  test('denies reading and writing the credential places and the state folder it is given', () => {
    expect(text).toMatch(/\(deny file-read\* file-write\*\n  \(subpath "\/home\/op\/\.ssh"\)\n  \(subpath "\/home\/op\/state"\)\)/)
  })
  test('carries over what Claude Code\'s own sandbox denied: unix sockets but name lookup, other processes\' environment and signals, LaunchServices, preferences, the pasteboard, terminal ioctl', () => {
    for (const d of ['(deny network-outbound (remote unix-socket))', '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))', '(deny process-info*)', '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))', '(deny signal)', '(deny mach-lookup (global-name-prefix "com.apple.coreservices."))', '(deny mach-lookup (global-name-prefix "com.apple.cfprefsd."))', '(deny mach-lookup (global-name-prefix "com.apple.pasteboard."))', '(deny file-ioctl (regex #"^/dev/(tty|ttys[0-9]+)$"))']) expect(text).toContain(d)
  })
  test('leaves the network open: no deny of outbound TCP or UDP', () => {
    expect(text).not.toMatch(/deny network-outbound(?! \(remote unix-socket\))/)
    expect(text).not.toContain('(deny network*')
  })
  test('is the servers\' profile\'s text, not a second one: every line of it that does not concern where it writes, a hidden parent or the keychain is also in the servers\'', () => {
    const servers = sandboxProfile(same, [{ label: 'x', path: '/home/op/.ssh' }], { root: '/srv/tmp', dir: '/srv/tmp/dd' }).split('\n')
    const shared = servers.filter(l => /^\((deny|allow) (network-outbound|process-info|sysctl-read|signal|mach-lookup|file-ioctl)/.test(l))
    expect(shared.length).toBeGreaterThan(10)
    for (const l of shared) expect(text).toContain(l)
  })
  test('the servers\' own profile does not gain the keychain rule (a change to what the servers reach is its own change)', () => {
    expect(sandboxProfile(same, [{ label: 'x', path: '/home/op/.ssh' }], { root: '/srv/tmp', dir: '/srv/tmp/dd' })).not.toContain('SecurityServer')
  })
  test('refuses an empty list of places to deny, and a path with a control character', () => {
    expect(() => bashProfile(same, { cannotRead: [], writable: ['/w'] })).toThrow('no off-limits places')
    expect(() => bashProfile(same, { cannotRead: ['/x'], writable: ['/w\nb'] })).toThrow('control character')
    expect(() => bashProfile(same, { cannotRead: ['/x'], writable: [] })).toThrow('no folder to write in')
  })
})

describe('the wrapper', () => {
  test('proves the profile applies once (a probe under it, then a marker), then runs the command under it by the shell Claude Code uses', () => {
    const w = bashWrapper({ profile: '/state/s.sb', marker: '/state/s.applied' })
    expect(w.startsWith('#!/bin/bash\n')).toBe(true)
    expect(w).toContain(`[ -e '/state/s.applied' ] || { ${SANDBOX_EXEC} -f '/state/s.sb' /usr/bin/true && : > '/state/s.applied'; } || exit 126`)
    expect(w).toContain(`exec ${SANDBOX_EXEC} -f '/state/s.sb' "$sh" -c "$1"`)
  })
  test('quotes a path with a quote in it', () => {
    expect(bashWrapper({ profile: "/state/it's.sb", marker: '/m' })).toContain(`-f '/state/it'\\''s.sb'`)
  })
  test('with no shell named, or a relative one, runs bash', () => {
    const w = bashWrapper({ profile: '/p', marker: '/m' })
    expect(w).toContain('sh="${SHELL:-/bin/bash}"')
    expect(w).toContain('case "$sh" in /*) ;; *) sh=/bin/bash ;; esac')
  })
})

describe.skipIf(!HAVE)('under the real sandbox-exec', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bash-sbx-')))
  const home = join(dir, 'home')
  const work = join(dir, 'work')
  const tmp = join(dir, 'tmp')
  const ssh = join(home, '.ssh')
  const state = join(home, 'state')
  const keychain = join(dir, 'throwaway.keychain-db')
  const SERVICE = `hydra-probe-${process.pid}`
  const sock = join(dir, 'daemon.sock')
  const clean = { PATH: process.env.PATH!, HOME: process.env.HOME! }
  const profile = () => bashProfile(realEnv, { cannotRead: [ssh, state], writable: [work, tmp] })
  let unixServer: Server
  let accepted = 0

  async function run(argv: string[], boxed = true, env: Record<string, string> = clean): Promise<{ code: number; out: string; err: string }> {
    const p = Bun.spawn(boxed ? [SANDBOX_EXEC, '-p', profile(), ...argv] : argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out, err }
  }
  /** The keychain locks itself after a while: unlocked right before each read, so "not found" cannot be a locked keychain. */
  const unlock = () => Bun.spawnSync([SECURITY, 'unlock-keychain', '-p', 'pw', keychain])
  const find = (boxed: boolean) => { unlock(); return run([SECURITY, 'find-generic-password', '-s', SERVICE, '-w', keychain], boxed) }

  beforeAll(async () => {
    for (const d of [home, work, tmp, ssh, state]) mkdirSync(d, { recursive: true })
    writeFileSync(join(ssh, 'key'), 'ssh-secret'); writeFileSync(join(state, 'token'), 'state-secret'); writeFileSync(join(home, 'readable'), 'readable')
    // A throwaway keychain in this suite's own temp folder: the operator's login keychain is never named, searched or unlocked here.
    expect(Bun.spawnSync([SECURITY, 'create-keychain', '-p', 'pw', keychain]).exitCode).toBe(0)
    expect(unlock().exitCode).toBe(0)
    expect(Bun.spawnSync([SECURITY, 'add-generic-password', '-a', 'me', '-s', SERVICE, '-w', 'keychain-secret', keychain]).exitCode).toBe(0)
    unixServer = createServer(s => { accepted++; s.end() })
    await new Promise<void>(res => unixServer.listen(sock, res))
  })
  afterAll(() => {
    unixServer?.close()
    Bun.spawnSync([SECURITY, 'delete-keychain', keychain])   // the throwaway one, by its exact path (also takes it out of the search list)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the keychain: `security find-generic-password` reads the secret outside the profile and fails under it', async () => {
    const control = await find(false)
    expect([control.code, control.out.trim()]).toEqual([0, 'keychain-secret'])   // so the failure below is the profile, not a locked or empty keychain
    const boxed = await find(true)
    expect(boxed.code).not.toBe(0)
    expect(boxed.out).not.toContain('keychain-secret')
    expect(boxed.err).toMatch(/SecKeychain|keychain/i)
  })
  test('MUTATION: the same profile without the keychain rules lets the secret through (the denial is those rules)', async () => {
    const weak = profile().split('\n').filter(l => !BASH_KEYCHAIN_DENIES.includes(l)).join('\n')
    expect(weak).not.toBe(profile())
    unlock()
    const p = Bun.spawnSync([SANDBOX_EXEC, '-p', weak, SECURITY, 'find-generic-password', '-s', SERVICE, '-w', keychain], { env: clean })
    expect(p.stdout.toString().trim()).toBe('keychain-secret')
  })
  test('a file-read rule on the keychain FILE also stops it (the `security` process reads the file itself), and a write or metadata rule does not', async () => {
    const denying = (rule: string) => { unlock(); return Bun.spawnSync([SANDBOX_EXEC, '-p', `(version 1)\n(allow default)\n(deny ${rule} (subpath ${JSON.stringify(keychain)}))\n`, SECURITY, 'find-generic-password', '-s', SERVICE, '-w', keychain], { env: clean }).stdout.toString().trim() }
    expect(denying('file-read-data')).toBe('')
    expect(denying('file-write*')).toBe('keychain-secret')
    expect(denying('file-read-metadata')).toBe('keychain-secret')
  })
  test('the nested case that forces a single layer: a second sandbox-exec inside a sandboxed process is refused by macOS, so Claude Code\'s own Bash sandbox cannot run under this one', async () => {
    const r = await run([SANDBOX_EXEC, '-p', '(version 1)(allow default)', '/usr/bin/true'])
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/sandbox_apply: Operation not permitted/)
  })

  test('writes: the workdir and the temp folder are writable, Claude Code\'s marker file too; anywhere else, /tmp included, is not', async () => {
    const mark = `/tmp/claude-${process.pid.toString(16)}-cwd`
    try {
      for (const d of [work, tmp]) expect((await run(['sh', '-c', `echo x > ${JSON.stringify(join(d, 'f'))} && cat ${JSON.stringify(join(d, 'f'))}`])).out.trim()).toBe('x')
      expect((await run(['sh', '-c', `pwd -P >| ${mark} && cat ${mark}`])).code).toBe(0)
      for (const f of [join(home, 'planted'), join(dir, 'planted'), `/tmp/hydra-bash-sbx-${process.pid}`, '/tmp/claude-nothex-cwd']) {
        const r = await run(['sh', '-c', `echo x > ${JSON.stringify(f)}`])
        expect([f, r.code === 0, existsSync(f)]).toEqual([f, false, false])
      }
    } finally { rmSync(mark, { force: true }) }
  })
  test('the credential places and the state folder are refused for reading and writing; a folder not on the list is readable (the control reads all of them)', async () => {
    for (const [f, secret] of [[join(ssh, 'key'), 'ssh-secret'], [join(state, 'token'), 'state-secret']]) {
      expect((await run(['cat', f], false)).out).toBe(secret)
      const r = await run(['cat', f])
      expect([r.code === 0, r.out]).toEqual([false, ''])
      expect((await run(['sh', '-c', `echo x >> ${JSON.stringify(f)}`])).code).not.toBe(0)
    }
    expect((await run(['cat', join(home, 'readable')])).out).toBe('readable')
  })
  test('a connect to the daemon\'s socket is refused under the profile and succeeds without it (the way into other sessions and the daemon)', async () => {
    const script = `import {connect} from 'net'; const c = connect(${JSON.stringify(sock)}); c.on('connect',()=>{console.log('connected'); c.end(); process.exit(0)}); c.on('error',e=>{console.log('refused '+e.code); process.exit(3)})`
    expect((await run(['bun', '-e', script], false)).out.trim()).toBe('connected')
    const before = accepted
    expect((await run(['bun', '-e', script])).out.trim()).toMatch(/^refused/)
    expect(accepted).toBe(before)
  })
  test('the network stays open: loopback TCP and name lookup work', async () => {
    const tcp = createServer(s => s.end('hello'))
    await new Promise<void>(res => tcp.listen(0, '127.0.0.1', res))
    const port = (tcp.address() as any).port
    try {
      const script = `import {lookup} from 'dns/promises'; const a = await lookup('localhost'); const s = await Bun.connect({hostname:'127.0.0.1',port:${port},socket:{data(s,d){console.log('tcp '+d.toString()); s.end()},open(){}}}); await Bun.sleep(300); console.log('lookup '+a.address)`
      const r = await run(['bun', '-e', script])
      expect(r.out).toMatch(/tcp hello/)
      expect(r.out).toMatch(/lookup (127\.0\.0\.1|::1)/)
    } finally { tcp.close() }
  })
  test.skipIf(process.env.HYDRA_LIVE_NETWORK !== '1')('a real HTTPS request still works with the keychain denied (HYDRA_LIVE_NETWORK=1: needs the internet)', async () => {
    expect((await run(['curl', '-s', '-o', '/dev/null', '-m', '10', '-w', '%{http_code}', 'https://example.com'])).out).toBe('200')
  })

  describe('the wrapper, as Claude Code runs it: the command text as its one argument', () => {
    const wrapper = join(dir, 'wrap.sh')
    const prof = join(dir, 'wrap.sb')
    const marker = join(dir, 'wrap.applied')
    beforeAll(() => {
      writeFileSync(prof, profile())
      writeFileSync(wrapper, bashWrapper({ profile: prof, marker }), { mode: 0o755 })
    })
    const wrapped = (cmd: string) => Bun.spawnSync([wrapper, cmd], { env: { ...clean, SHELL: '/bin/zsh' } })

    test('runs the text under the profile (the keychain read fails, the workdir write works), leaving the marker', () => {
      expect(existsSync(marker)).toBe(false)
      unlock()
      const r = wrapped(`security find-generic-password -s ${SERVICE} -w ${JSON.stringify(keychain)}; echo ok > ${JSON.stringify(join(work, 'w'))} && cat ${JSON.stringify(join(work, 'w'))}`)
      expect(r.stdout.toString()).not.toContain('keychain-secret')
      expect(r.stdout.toString().trim()).toBe('ok')
      expect(existsSync(marker)).toBe(true)
    })
    test('`dangerouslyDisableSandbox` is not a thing the wrapper knows: the text it is given is all it has, and it is always under the profile', () => {
      unlock()
      expect(wrapped(`security find-generic-password -s ${SERVICE} -w ${JSON.stringify(keychain)}`).stdout.toString()).not.toContain('keychain-secret')
    })
    test('a command that is not under the profile cannot write the marker (the shell has no write there)', async () => {
      rmSync(marker)
      const r = await run(['sh', '-c', `: > ${JSON.stringify(marker)}`])
      expect([r.code === 0, existsSync(marker)]).toEqual([false, false])
    })
    test('refuses (126) and runs nothing when the profile cannot be applied', () => {
      rmSync(marker, { force: true })
      writeFileSync(prof, '(version 1)(nonsense')
      const r = wrapped(`echo should-not-run`)
      expect([r.exitCode, r.stdout.toString()]).toEqual([126, ''])
      expect(existsSync(marker)).toBe(false)
      writeFileSync(prof, profile())
    })
  })
})

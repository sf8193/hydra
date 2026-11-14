// The sandbox a listed [mcp.*] server runs under (config/server-sandbox.ts). Most of this runs the real `sandbox-exec` with the
// generated profile: a profile text that merely looks right proves nothing. Home folders are temp dirs standing in for the
// real ones (the roots are a parameter), so no test reads or touches the operator's ~/.ssh and the rest.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { createServer as createTcpServer, createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { offLimitRoots, type PrivateRoot } from '../workdir-scope.js'
import { nearestRealpath, systemEnv } from '../load.js'
import { SANDBOX_EXEC, sandboxIssues, sandboxProfile, sandboxedServer, unquotablePath, type ServerFolders } from '../server-sandbox.js'

const HAVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
const same = { realpath: (p: string) => p }
const realEnv = { realpath: (p: string) => { try { return realpathSync(p) } catch { return p } } }
const F = (dir: string): ServerFolders => ({ root: dirname(dir), dir })
const placesOf = (home: string, operator: string[] = []): PrivateRoot[] => offLimitRoots({ home, stateDir: join(home, 'state'), claudeConfigDir: join(home, '.claude') }, operator)

describe('the profile text', () => {
  const roots = placesOf('/home/op', ['/home/op/Notes'])
  const text = sandboxProfile(same, roots, F('/srv/tmp/ops/dd'))
  test('denies reads and writes of every place offLimitRoots lists: the same list the workdir check refuses', () => {
    for (const r of roots) expect(text).toContain(`(subpath "${r.path}")`)
    for (const d of ['.claude.json', '.ssh', '.aws', '.kube', '.config', '.claude', '.gnupg', 'Library/Keychains', '.netrc', '.npmrc', '.docker', '.git-credentials', '.pgpass', '.zsh_history', '.bash_history', 'Library/Cookies', 'Library/Safari', 'Library/Application Support/Google', 'Library/Application Support/Firefox']) expect(text).toContain(`(subpath "/home/op/${d}")`)
    expect(text).toContain('(subpath "/home/op/state")')
    expect(text).toContain('(subpath "/home/op/state/hydra.toml")')
    expect(text).toContain('(subpath "/home/op/Notes")')
    expect(text).toMatch(/\(deny file-read\* file-write\*\n[\s\S]*\/home\/op\/\.ssh/)
  })
  test('denies every unix-socket connect except name lookup', () => {
    expect(text).toContain('(deny network-outbound (remote unix-socket))')
    expect(text).toContain('(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))')
    expect(text.indexOf('(deny network-outbound')).toBeLessThan(text.indexOf('(allow network-outbound'))
  })
  test('denies reading another process\'s environment (both rules: each alone left it readable) and signalling anything but itself and its children', () => {
    expect(text).toMatch(/\(deny process-info\*\)\n\(allow process-info\* \(target self\)\)\n\(allow process-info\* \(target children\)\)/)
    expect(text).toContain('(deny sysctl-read (sysctl-name-prefix "kern.procargs"))')
    expect(text).toMatch(/\(deny signal\)\n\(allow signal \(target self\)\)\n\(allow signal \(target children\)\)/)
  })
  test('denies every write except its own temp folder and two devices (persistence: shell rc files, LaunchAgents, ~/.claude.json); /dev/tty is not one', () => {
    expect(text).toContain('(deny file-write*)\n(allow file-write*\n  (subpath "/srv/tmp/ops/dd")\n  (literal "/dev/null")\n  (literal "/dev/dtracehelper"))')
    expect(text.indexOf('(deny file-write*)')).toBeLessThan(text.indexOf('(allow file-write*'))
    expect(text).not.toContain('/dev/tty"')
  })
  test('denies reading the contents of the other servers\' folders (the shared parent) and allows its own, in that order (a later rule wins)', () => {
    expect(text).toContain('(deny file-read-data\n  (subpath "/srv/tmp/ops"))\n(allow file-read-data\n  (subpath "/srv/tmp/ops/dd"))')
  })
  test('denies the LaunchServices and CoreServices, preferences and pasteboard mach names and the system monitor, and ioctl on terminals', () => {
    expect(text).toContain('(deny mach-lookup (global-name-prefix "com.apple.coreservices."))')
    expect(text).toContain('(deny mach-lookup (global-name-prefix "com.apple.cfprefsd."))')
    expect(text).toContain('(deny mach-lookup (global-name "com.apple.sysmond"))')
    expect(text).toContain('(deny mach-lookup (global-name-prefix "com.apple.pasteboard."))')
    expect(text).toContain('(deny file-ioctl (regex #"^/dev/(tty|ttys[0-9]+)$"))')
  })
  test('is the same shape for every operator: only the paths differ', () => {
    const other = sandboxProfile(same, placesOf('/Users/z'), F('/Users/z/tmp'))
    expect(other.replaceAll('/Users/z', '/home/op').split('\n')).toEqual(sandboxProfile(same, placesOf('/home/op'), F('/home/op/tmp')).split('\n'))
  })
  test('names a path by its resolved path too (a symlinked state dir, or a symlinked hydra.toml, is the same file)', () => {
    const t = sandboxProfile({ realpath: p => p === '/home/op/state/hydra.toml' ? '/dotfiles/hydra.toml' : p }, placesOf('/home/op'), F('/home/op/tmp'))
    expect(t).toContain('(subpath "/home/op/state/hydra.toml")')
    expect(t).toContain('(subpath "/dotfiles/hydra.toml")')
  })
  test('quotes a quote and a backslash so neither can end the string or add a rule', () => {
    const t = sandboxProfile(same, [{ label: 'x', path: '/x/a"b\\c' }], F('/x/tmp'))
    expect(t).toContain('(subpath "/x/a\\"b\\\\c")')
  })
})

describe('a path the profile cannot hold', () => {
  test.each([['newline', '/x/a\nb'], ['tab', '/x/a\tb'], ['NUL', '/x/a\0b'], ['carriage return', '/x/a\rb'], ['DEL', '/x/a\x7fb']])('a %s is refused, with the cause and the fix', (_n, path) => {
    expect(unquotablePath(path)).toMatch(/control character.*remove it from the path/)
    expect(() => sandboxProfile(same, [{ label: 'x', path }], F('/x/tmp'))).toThrow('control character')
  })
  test.each([['quote', '/x/a"b'], ['closing paren', '/x/a)b'], ['opening paren', '/x/a(b'], ['backslash', '/x/a\\b'], ['space', '/x/a b'], ['semicolon', '/x/a;b'], ['unicode', '/x/é']])('a %s is not: it is escaped inside the string', (_n, path) => {
    expect(unquotablePath(path)).toBeUndefined()
  })
})

describe('a profile with nothing to deny', () => {
  test('is refused, not written as an empty rule (which Seatbelt reads as a syntax error)', () => {
    expect(() => sandboxProfile(same, [], F('/srv/tmp/ops/dd'))).toThrow('no off-limits places')
  })
  test('and the production list is never empty: the home folders alone are more than a dozen', () => {
    expect(placesOf('/home/op').length).toBeGreaterThan(12)
  })
})

describe('the wrapped command', () => {
  test('is sandbox-exec with the profile inline, then the pinned command, unchanged', () => {
    const roots = placesOf('/home/op')
    const w = sandboxedServer('/usr/local/bin/datadog-mcp', same, roots, F('/srv/tmp/dd'))
    expect(w.command).toBe(SANDBOX_EXEC)
    expect(w.args).toEqual(['-p', sandboxProfile(same, roots, F('/srv/tmp/dd')), '/usr/local/bin/datadog-mcp'])
  })
})

describe('where the sandbox cannot be set up', () => {
  const roots = placesOf('/home/op')
  test('without sandbox-exec: says what blocks what, that this machine lacks it, and all three ways out', () => {
    const why = sandboxIssues(() => false, roots)!
    expect(why).toBe(`a listed [mcp.*] server runs under ${SANDBOX_EXEC} (macOS only), which blocks its connects to the daemon's socket and its reads of the listed credential folders. This machine does not have it. Remove the servers from the specialist's mcp, set access = "operator", or run hydra on a Mac`)
  })
  test('with a place the profile cannot name: the path and the fix', () => {
    expect(sandboxIssues(c => c === SANDBOX_EXEC, [...roots, { label: 'x', path: '/home/op/a\nb' }])).toMatch(/control character.*remove it from the path/)
  })
  test('with both in order: nothing', () => { expect(sandboxIssues(c => c === SANDBOX_EXEC, roots)).toBeUndefined() })
})

describe('a place that does not exist yet, under a symlinked parent', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nr-')))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  test('is resolved through its nearest existing ancestor, with the rest put back', () => {
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    expect(nearestRealpath(join(dir, 'link', 'missing', 'x'))).toBe(join(dir, 'real', 'missing', 'x'))
    expect(nearestRealpath(join(dir, 'link'))).toBe(join(dir, 'real'))
    expect(nearestRealpath(join(dir, 'real', 'a', 'b'))).toBe(join(dir, 'real', 'a', 'b'))
  })
  test('the daemon\'s and `hydra config check`\'s own probe (systemEnv) resolves that way too: the wiring is pinned, not only the function', () => {
    mkdirSync(join(dir, 'real2'))
    symlinkSync(join(dir, 'real2'), join(dir, 'link2'))
    expect(systemEnv([], dir, dir).realpath(join(dir, 'link2', 'missing', 'x'))).toBe(join(dir, 'real2', 'missing', 'x'))
  })
  test.skipIf(process.platform !== 'darwin')('on macOS /tmp/x is /private/tmp/x whether or not x exists, and the profile names the resolved one', () => {
    const missing = `/tmp/hydra-nr-${process.pid}-does-not-exist/x`
    expect(nearestRealpath(missing)).toBe(`/private${missing}`)
    expect(sandboxProfile({ realpath: nearestRealpath }, [{ label: 'x', path: missing }], F(join(dir, 'tmp')))).toContain(`(subpath "/private${missing}")`)
  })
})

describe.skipIf(!HAVE)('under the real sandbox-exec', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-')))
  const home = join(dir, 'home')
  const operatorRoot = join(dir, 'private-notes')
  const odd = join(dir, 'odd "q" (p) \\b ;x')   // a folder named to try to break out of the profile's string
  const roots = [...placesOf(home, [operatorRoot, odd])]
  const sock = join(dir, 'daemon.sock')
  const scopedRoot = join(dir, 'hydra-scoped')
  const tmp = join(scopedRoot, 'ops-1', 'srv')
  const siblingTmp = join(scopedRoot, 'ops-2', 'srv')
  const folders: ServerFolders = { root: scopedRoot, dir: tmp }
  const profile = () => sandboxProfile(realEnv, roots, folders)
  let unixServer: Server
  let tcpServer: Server
  let tcpPort = 0
  let accepted = 0
  const clean = { PATH: process.env.PATH!, HOME: process.env.HOME! }

  /** Runs a command under the profile; `sandboxed: false` runs it as is, for the control. */
  async function run(argv: string[], sandboxed = true, env: Record<string, string> = clean): Promise<{ code: number; out: string; err: string }> {
    const cmd = sandboxed ? [SANDBOX_EXEC, '-p', profile(), ...argv] : argv
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out, err }
  }
  const connectScript = (path: string) => `import {connect} from 'net'; const c = connect(${JSON.stringify(path)}); c.on('connect',()=>{console.log('connected'); c.end(); process.exit(0)}); c.on('error',e=>{console.log('refused '+e.code); process.exit(3)})`

  beforeAll(async () => {
    // Every place the list names exists as a folder with a secret in it (the profile denies a file or a folder alike).
    for (const r of roots) { if (r.path.endsWith('hydra.toml') || r.path.endsWith('.env')) continue; mkdirSync(r.path, { recursive: true }); writeFileSync(join(r.path, 'secret'), `secret-in-${r.path}`) }
    mkdirSync(tmp, { recursive: true })
    mkdirSync(siblingTmp, { recursive: true })
    mkdirSync(join(home, 'allowed'), { recursive: true }); writeFileSync(join(home, 'allowed', 'secret'), 'secret-in-allowed')
    // hydra.toml is a symlink into a dotfiles folder, as an operator who keeps it in a repo has it.
    mkdirSync(join(dir, 'dotfiles'), { recursive: true })
    writeFileSync(join(dir, 'dotfiles', 'hydra.toml'), '[specialists.ops]\n')
    symlinkSync(join(dir, 'dotfiles', 'hydra.toml'), join(home, 'state', 'hydra.toml'))
    symlinkSync(join(home, 'state'), join(dir, 'state-link'))
    unixServer = createServer(s => { accepted++; s.end() })
    await new Promise<void>(res => unixServer.listen(sock, res))
    tcpServer = createTcpServer(s => s.end('hello'))
    await new Promise<void>(res => tcpServer.listen(0, '127.0.0.1', res))
    tcpPort = (tcpServer.address() as any).port
  })
  afterAll(() => {
    unixServer?.close(); tcpServer?.close()
    // Explicit path only: the temp dir this suite made.
    rmSync(dir, { recursive: true, force: true })
  })

  test('a connect to the daemon\'s socket is refused under the profile and succeeds without it', async () => {
    const control = await run(['bun', '-e', connectScript(sock)], false)
    expect(control.out.trim()).toBe('connected')
    const before = accepted
    const boxed = await run(['bun', '-e', connectScript(sock)])
    expect(boxed.out.trim()).toMatch(/^refused (EPERM|EACCES|ECONNREFUSED)/)
    expect(accepted).toBe(before)   // the daemon stand-in never saw the connection
  })

  test('a grandchild that detaches from its parent is just as refused (the sandbox is inherited, not a parent check)', async () => {
    const script = `import {spawn} from 'child_process'; const c = spawn('bun',['-e',${JSON.stringify(connectScript(sock))}],{detached:true,stdio:['ignore','inherit','inherit']}); c.on('exit',code=>process.exit(code))`
    const boxed = await run(['bun', '-e', script])
    expect(boxed.out.trim()).toMatch(/^refused/)
  })

  test('every place offLimitRoots lists is refused for reading and for writing; the unsandboxed control reads it', async () => {
    for (const r of roots) {
      if (r.path.endsWith('hydra.toml') || r.path.endsWith('.env')) continue
      const f = join(r.path, 'secret')
      expect((await run(['cat', f], false)).out).toBe(`secret-in-${r.path}`)
      const read = await run(['cat', f])
      expect([r.label, read.code === 0]).toEqual([r.label, false])
      expect(read.out).toBe('')
      expect(read.err).toMatch(/Operation not permitted/)
      const write = await run(['sh', '-c', `echo x > ${JSON.stringify(join(r.path, 'planted'))}`])
      expect([r.label, write.code === 0]).toEqual([r.label, false])
      expect(existsSync(join(r.path, 'planted'))).toBe(false)
    }
  })
  test('a folder named with a quote, parentheses, a backslash and a semicolon is denied, and the profile still denies everything else (the name did not break out of its string)', async () => {
    expect((await run(['cat', join(odd, 'secret')])).code).not.toBe(0)
    expect((await run(['cat', join(home, '.ssh', 'secret')])).code).not.toBe(0)
    expect((await run(['bun', '-e', connectScript(sock)])).out.trim()).toMatch(/^refused/)
  })
  test('hydra.toml cannot be read or rewritten, and that holds when it is a symlink into a dotfiles folder (the target is named)', async () => {
    expect((await run(['cat', join(home, 'state', 'hydra.toml')])).code).not.toBe(0)
    const target = join(dir, 'dotfiles', 'hydra.toml')
    expect((await run(['cat', target])).code).not.toBe(0)
    expect((await run(['sh', '-c', `echo 'planted = 1' >> ${JSON.stringify(target)}`])).code).not.toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('[specialists.ops]\n')
    expect((await run(['sh', '-c', `echo 'control = 1' >> ${JSON.stringify(target)}`], false)).code).toBe(0)   // the control can: the denial is the profile's
  })
  test('the state dir through a symlink, and a private root, are denied too', async () => {
    expect((await run(['cat', join(dir, 'state-link', 'secret')])).code).not.toBe(0)
    expect((await run(['cat', join(operatorRoot, 'secret')])).code).not.toBe(0)
  })
  test('a folder outside the list is still readable (the profile takes away named things, not everything)', async () => {
    expect((await run(['cat', join(home, 'allowed', 'secret')])).out).toBe('secret-in-allowed')
  })

  test('loopback TCP and name lookup still work: a server that calls an API is not cut off', async () => {
    const lookup = `import {lookup} from 'dns/promises'; const a = await lookup('localhost'); const s = await Bun.connect({hostname:'127.0.0.1',port:${tcpPort},socket:{data(s,d){console.log('tcp '+d.toString()); s.end()},open(){}}}); await Bun.sleep(300); console.log('lookup '+a.address)`
    const boxed = await run(['bun', '-e', lookup])
    expect(boxed.out).toMatch(/tcp hello/)
    expect(boxed.out).toMatch(/lookup (127\.0\.0\.1|::1)/)
  })
  test.skipIf(process.env.HYDRA_LIVE_NETWORK !== '1')('a real HTTPS request still works (HYDRA_LIVE_NETWORK=1: needs the internet)', async () => {
    const boxed = await run(['curl', '-s', '-o', '/dev/null', '-m', '10', '-w', '%{http_code}', 'https://example.com'])
    expect(boxed.out).toBe('200')
  })

  describe('another process of the same user', () => {
    // A victim with a secret in its environment. Not /bin/sleep: a platform binary hides its environment from everyone.
    let victim: ReturnType<typeof Bun.spawn>
    const SECRET = 'SECRET_VICTIM=topsecret'
    const readerTs = join(dir, 'reader.ts')
    const readerPy = join(dir, 'reader.py')
    beforeAll(async () => {
      victim = Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{},120000)'], { env: { ...clean, SECRET_VICTIM: 'topsecret' }, stdout: 'ignore', stderr: 'ignore' })
      await Bun.sleep(300)
      // KERN_PROCARGS2 is what `ps eww` reads; proc_pidpath and proc_pidinfo are the process-info calls.
      writeFileSync(readerTs, `import { dlopen, FFIType, ptr } from 'bun:ffi'
const pid = Number(process.argv[2])
const lib = dlopen('libSystem.B.dylib', { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 }, proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } })
const mib = new Int32Array([1, 49, pid]); const size = new BigUint64Array([BigInt(1 << 20)]); const buf = new Uint8Array(1 << 20)
const rc = lib.symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null as any, 0n)
const text = Buffer.from(buf.subarray(0, Number(size[0]))).toString('latin1')
const path = new Uint8Array(4096); const n = lib.symbols.proc_pidpath(pid, ptr(path), 4096)
console.log('procargs rc=' + rc + ' secret=' + (rc === 0 && text.includes('${SECRET}') ? 'READ' : 'no') + ' pidpath=' + (n > 0 ? 'READ' : 'no'))
`)
      writeFileSync(readerPy, `import ctypes, ctypes.util, sys
pid = int(sys.argv[1])
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
mib = (ctypes.c_int * 3)(1, 49, pid); size = ctypes.c_size_t(1 << 20); buf = ctypes.create_string_buffer(1 << 20)
rc = libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0)
print('procargs rc=%d secret=%s' % (rc, 'READ' if rc == 0 and b'${SECRET}' in buf.raw[:size.value] else 'no'))
`)
    })
    afterAll(() => { victim?.kill() })

    test('the control reads its environment (so a refusal below is the profile, not a bad reader)', async () => {
      expect((await run(['bun', readerTs, String(victim.pid)], false)).out).toContain('secret=READ')
      expect((await run(['ps', 'eww', '-p', String(victim.pid)], false)).out).toContain(SECRET)
    })
    test('under the profile it cannot, through KERN_PROCARGS2 from bun', async () => {
      const r = await run(['bun', readerTs, String(victim.pid)])
      expect(r.out).toContain('secret=no')
      expect(r.out).toContain('pidpath=no')
    })
    test.skipIf(!existsSync('/usr/bin/python3'))('under the profile it cannot, through KERN_PROCARGS2 from python3', async () => {
      expect((await run(['/usr/bin/python3', readerPy, String(victim.pid)], false)).out).toContain('secret=READ')
      expect((await run(['/usr/bin/python3', readerPy, String(victim.pid)])).out).toContain('secret=no')
    })
    test.skipIf(!existsSync('/usr/bin/python3'))('why `(target others)` is not enough: with it alone the same python reader succeeds, because the victim is in the caller\'s process group (as claude is in its server\'s)', async () => {
      const weak = profile().replace('(deny process-info*)\n(allow process-info* (target self))\n(allow process-info* (target children))', '(deny process-info* (target others))')
      expect(weak).not.toBe(profile())
      const boxed = (text: string) => { const p = Bun.spawnSync([SANDBOX_EXEC, '-p', text, '/usr/bin/python3', readerPy, String(victim.pid)], { env: clean }); return p.stdout.toString() }
      expect(boxed(weak)).toContain('secret=READ')
      expect(boxed(profile())).toContain('secret=no')
    })
    test('under the profile `ps eww` shows nothing of it', async () => {
      expect((await run(['ps', 'eww', '-p', String(victim.pid)])).out).not.toContain(SECRET)
      expect((await run(['sh', '-c', `ps eww -p ${victim.pid}`])).out).not.toContain(SECRET)
    })
    test('under the profile it cannot signal it, and the victim is untouched; it can signal its own child, and the outside can still stop it', async () => {
      const decoy = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' })
      const script = `import {spawn} from 'child_process'
const kid = spawn('/bin/sleep', ['300'])
await Bun.sleep(200)
let own = 'ok'; try { process.kill(kid.pid, 'SIGTERM') } catch (e) { own = e.code }
let other = 'delivered'; try { process.kill(${decoy.pid}, 'SIGUSR2') } catch (e) { other = e.code }
await Bun.sleep(300)
console.log('own=' + own + ' other=' + other)`
      const r = await run(['bun', '-e', script])
      expect(r.out.trim()).toBe('own=ok other=EPERM')
      expect(decoy.killed || decoy.exitCode !== null).toBe(false)
      expect(() => process.kill(decoy.pid, 0)).not.toThrow()
      decoy.kill()
      // An outside SIGTERM (Claude ending the session) still stops a sandboxed server.
      const server = Bun.spawn([SANDBOX_EXEC, '-p', profile(), 'bun', '-e', 'setTimeout(()=>{},120000)'], { stdout: 'ignore', stderr: 'ignore' })
      await Bun.sleep(500)
      server.kill('SIGTERM')
      expect(await Promise.race([server.exited, Bun.sleep(5000).then(() => 'still running')])).not.toBe('still running')
    })
  })

  describe('persistence: writes', () => {
    // A fake home, never the real one. Each is a place that runs unsandboxed at the next login or the next npx.
    const places = ['.zshrc', '.bashrc', '.zprofile', '.bash_profile', '.profile', '.claude.json', 'Library/LaunchAgents/probe.plist', 'Library/Preferences/probe.plist', '.local/bin/probe', '.npm/_npx/probe', 'elsewhere/probe']
    test('every one is denied under the profile and allowed for the control', async () => {
      for (const d of ['Library/LaunchAgents', 'Library/Preferences', '.local/bin', '.npm/_npx', 'elsewhere']) mkdirSync(join(home, d), { recursive: true })
      for (const rel of places) {
        const f = join(home, rel)
        const boxed = await run(['sh', '-c', `echo planted >> ${JSON.stringify(f)}`])
        expect([rel, boxed.code === 0, existsSync(f) && !statSync(f).isDirectory()]).toEqual([rel, false, false])
      }
      // .claude.json is a folder in this fixture (every root is made one, so the roots test can put a secret in it): the control cannot append to it.
      for (const rel of places.filter(r => r !== '.claude.json')) {
        const f = join(home, rel)
        expect([rel, (await run(['sh', '-c', `echo planted >> ${JSON.stringify(f)}`], false)).code]).toEqual([rel, 0])
        rmSync(f, { force: true })
      }
    })
    test('/tmp and the folder beside the server\'s own are denied too', async () => {
      const f = `/tmp/hydra-sbx-persist-${process.pid}-${Date.now()}`
      const boxed = await run(['sh', '-c', `echo planted >> ${JSON.stringify(f)}`])
      expect([boxed.code === 0, existsSync(f)]).toEqual([false, false])
      if (existsSync(f)) rmSync(f, { force: true })   // only if the denial failed: the one explicit path this test made
      expect((await run(['sh', '-c', `echo planted >> ${JSON.stringify(join(dirname(tmp), 'sibling-probe'))}`])).code).not.toBe(0)
    })
    test('its own temp folder is writable, including a private npm cache inside it and the null device', async () => {
      const r = await run(['sh', '-c', `mkdir -p ${JSON.stringify(join(tmp, 'npm-cache', '_cacache'))} && echo ok > ${JSON.stringify(join(tmp, 'npm-cache', 'f'))} && echo x > /dev/null && cat ${JSON.stringify(join(tmp, 'npm-cache', 'f'))}`])
      expect(r.out.trim()).toBe('ok')
    })
  })

  describe('the way out through LaunchServices', () => {
    const toml = join(home, 'state', 'hydra.toml')
    const marker = (n: string) => join(dir, `marker-${n}.txt`)
    /** A background app whose payload records what it can read and reach: it runs outside the sandbox when LaunchServices starts it. */
    function makeApp(n: string): string {
      const app = join(dir, `${n}.app`)
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
      writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>app</string><key>CFBundleIdentifier</key><string>hydra.sbxtest.${n}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>`)
      const exe = join(app, 'Contents', 'MacOS', 'app')
      writeFileSync(exe, `#!/bin/bash\n{\n echo "toml=$(cat ${JSON.stringify(toml)} 2>&1)"\n if echo | /usr/bin/nc -U ${JSON.stringify(sock)} >/dev/null 2>&1; then echo sock=connected; else echo sock=refused; fi\n} > ${JSON.stringify(marker(n))}\n`, { mode: 0o755 })
      Bun.spawnSync(['codesign', '-s', '-', '--force', app])
      return app
    }
    const lsopen = join(dir, 'lsopen')
    const haveClang = !!Bun.which('clang')
    async function waitFor(path: string, ms: number): Promise<string | undefined> {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(200)) if (existsSync(path)) { await Bun.sleep(200); return readFileSync(path, 'utf8') }
      return undefined
    }
    beforeAll(() => {
      if (!haveClang) return
      writeFileSync(join(dir, 'lsopen.c'), `#include <CoreServices/CoreServices.h>\n#include <stdio.h>\nint main(int argc, char **argv) {\n  CFStringRef p = CFStringCreateWithCString(NULL, argv[1], kCFStringEncodingUTF8);\n  CFURLRef u = CFURLCreateWithFileSystemPath(NULL, p, kCFURLPOSIXPathStyle, true);\n  LSLaunchURLSpec spec = {0}; spec.appURL = u; spec.launchFlags = kLSLaunchDontSwitch | kLSLaunchNewInstance;\n  OSStatus s = LSOpenFromURLSpec(&spec, NULL);\n  printf("status=%d\\n", (int)s);\n  return 0;\n}\n`)
      Bun.spawnSync(['clang', '-framework', 'CoreServices', '-o', lsopen, join(dir, 'lsopen.c')])
    })

    /** The pids of helper apps in this test's own temp dir: an exact path, and each is checked to be that app's bash before it is touched. */
    const helperPids = (): number[] => Bun.spawnSync(['pgrep', '-f', `${dir}/`]).stdout.toString().split('\n').filter(Boolean).map(Number)
      .filter(pid => Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)]).stdout.toString().startsWith(`/bin/bash ${dir}/`))
    const stateOf = (pid: number) => Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim()
    // A refused `open` can leave the app LaunchServices had already spawned, suspended and never run (state T). They are ours, by exact pid.
    afterAll(async () => {
      for (const pid of helperPids()) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      await Bun.sleep(300)
      expect(helperPids()).toEqual([])   // a suite run leaves none behind
    })

    test('the control: `open -g -j -n` starts the helper outside any sandbox, and it reads hydra.toml and connects to the socket stand-in (so the refusals below mean something)', async () => {
      const app = makeApp('control')
      const before = accepted
      await run(['/usr/bin/open', '-g', '-j', '-n', app], false)
      const m = await waitFor(marker('control'), 10_000)
      expect(m).toContain('toml=[specialists')
      expect(m).toContain('sock=connected')
      expect(accepted).toBe(before + 1)
    })
    test('under the profile `open -g -j -n` starts no helper that reads hydra.toml or reaches the socket', async () => {
      const app = makeApp('open')
      const before = accepted
      await run(['/usr/bin/open', '-g', '-j', '-n', app])
      expect(await waitFor(marker('open'), 4_000)).toBeUndefined()
      expect(accepted).toBe(before)
      for (const pid of helperPids().filter(pid => Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)]).stdout.toString().includes('/open.app/'))) expect(stateOf(pid)).toMatch(/^T/)   // a suspended spawn that never ran its script
    })
    test.skipIf(!haveClang)('under the profile a direct LaunchServices call (LSOpenFromURLSpec) starts none either', async () => {
      const app = makeApp('direct')
      const control = makeApp('direct-control')
      await run([lsopen, control], false)
      expect(await waitFor(marker('direct-control'), 10_000)).toContain('sock=connected')   // the call works when not sandboxed
      const before = accepted
      await run([lsopen, app])
      expect(await waitFor(marker('direct'), 4_000)).toBeUndefined()
      expect(accepted).toBe(before)
    })
  })

  describe('reading the environment of processes that are not its own', () => {
    const SECRET = 'SECRET_VICTIM=topsecret'
    const readerTs = join(dir, 'reader2.ts')
    const secretEnv = { ...clean, SECRET_VICTIM: 'topsecret' }
    const privSock = join(dir, 'tmux.sock')   // an exact socket in this test's own temp dir: never the operator's server
    // No TMUX in this env, and an exact socket (-S) in this test's temp dir: never the operator's own server.
    const tmuxEnv: Record<string, string> = { ...secretEnv, ...(process.env.TMUX_TMPDIR ? { TMUX_TMPDIR: process.env.TMUX_TMPDIR } : {}) }
    const haveTmux = !!Bun.which('tmux')
    let loneVictim: ReturnType<typeof Bun.spawn>
    let tmuxPid = 0
    beforeAll(async () => {
      writeFileSync(readerTs, `import { dlopen, FFIType, ptr } from 'bun:ffi'
const pid = Number(process.argv[2])
const lib = dlopen('libSystem.B.dylib', { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } })
const mib = new Int32Array([1, 49, pid]); const size = new BigUint64Array([BigInt(1 << 20)]); const buf = new Uint8Array(1 << 20)
const rc = lib.symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null as any, 0n)
console.log(rc === 0 && Buffer.from(buf.subarray(0, Number(size[0]))).toString('latin1').includes('${SECRET}') ? 'secret=READ' : 'secret=no')
`)
      // Its own session and process group: not the server's, as the daemon and the tmux server are not.
      loneVictim = Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{},120000)'], { env: secretEnv, detached: true, stdout: 'ignore', stderr: 'ignore' })
      if (haveTmux) {
        Bun.spawnSync(`tmux -S ${privSock} new-session -d`.split(' ').concat('sleep 120'), { env: tmuxEnv })
        tmuxPid = Number(Bun.spawnSync(`tmux -S ${privSock} display-message -p`.split(' ').concat('#{pid}'), { env: tmuxEnv }).stdout.toString().trim()) || 0
      }
      await Bun.sleep(300)
    })
    afterAll(() => {
      loneVictim?.kill()
      if (haveTmux) Bun.spawnSync(`tmux -S ${privSock} kill-server`.split(' '), { env: tmuxEnv })   // the private server this test started, by its own socket
    })

    test('a process in another session and process group: read by the control, refused under the profile', async () => {
      expect((await run(['bun', readerTs, String(loneVictim.pid)], false)).out.trim()).toBe('secret=READ')
      expect((await run(['bun', readerTs, String(loneVictim.pid)])).out.trim()).toBe('secret=no')
    })
    test('its own parent (as claude is the server\'s): read by the control, refused under the profile', async () => {
      const parent = join(dir, 'parent.ts')
      writeFileSync(parent, `const boxed = process.argv[2] === 'boxed'
const cmd = boxed ? ${JSON.stringify([SANDBOX_EXEC, '-p', profile()])} : []
const r = Bun.spawnSync([...cmd, 'bun', ${JSON.stringify(readerTs)}, String(process.pid)], { env: { PATH: process.env.PATH, HOME: process.env.HOME } })
console.log(r.stdout.toString().trim())
`)
      const asParent = async (mode: string) => { const p = Bun.spawn(['bun', parent, mode], { env: secretEnv, stdout: 'pipe', stderr: 'pipe' }); const out = await new Response(p.stdout).text(); await p.exited; return out.trim() }
      expect(await asParent('control')).toBe('secret=READ')
      expect(await asParent('boxed')).toBe('secret=no')
    })
    test.skipIf(!haveTmux)('a private tmux server: read by the control, refused under the profile', async () => {
      expect(tmuxPid).toBeGreaterThan(0)
      // If this fails the tmux binary hides its environment from everyone and the refusal below proves nothing.
      expect((await run(['bun', readerTs, String(tmuxPid)], false)).out.trim()).toBe('secret=READ')
      expect((await run(['bun', readerTs, String(tmuxPid)])).out.trim()).toBe('secret=no')
    })
    test('signals: refused to a process that is not its child, in another process group too', async () => {
      const r = await run(['bun', '-e', `try { process.kill(${loneVictim.pid}, 'SIGUSR2'); console.log('delivered') } catch (e) { console.log(e.code) }`])
      expect(r.out.trim()).toBe('EPERM')
      expect(() => process.kill(loneVictim.pid, 0)).not.toThrow()
      expect(loneVictim.exitCode).toBeNull()
    })
  })

  describe('sibling servers\' folders', () => {
    test('its own folder is readable and writable; another server\'s folder under the same parent is not readable (the control reads both)', async () => {
      writeFileSync(join(tmp, 'secret'), 'mine'); writeFileSync(join(siblingTmp, 'secret'), 'theirs')
      expect((await run(['cat', join(tmp, 'secret')], false)).out).toBe('mine')
      expect((await run(['cat', join(siblingTmp, 'secret')], false)).out).toBe('theirs')
      expect((await run(['cat', join(tmp, 'secret')])).out).toBe('mine')
      const other = await run(['cat', join(siblingTmp, 'secret')])
      expect([other.code === 0, other.out]).toEqual([false, ''])
      expect((await run(['ls', siblingTmp])).code).not.toBe(0)
      expect((await run(['sh', '-c', `echo x > ${JSON.stringify(join(tmp, 'new'))}`])).code).toBe(0)
    })
  })

  describe('preferences, the system monitor and the pasteboard (mach services)', () => {
    test.skipIf(!existsSync('/usr/bin/defaults'))('`defaults write` into ~/Library/Preferences works for the control and is refused under the profile', async () => {
      // A fake domain; its plist lands in the real ~/Library/Preferences and is removed by its exact path.
      const domain = `hydra.sbxtest.${process.pid}.${Date.now()}`
      const plist = join(process.env.HOME!, 'Library', 'Preferences', `${domain}.plist`)
      const write = (boxed: boolean) => run(['/usr/bin/defaults', 'write', domain, 'probe', '-string', 'planted'], boxed)
      try {
        await write(true)
        expect(existsSync(plist)).toBe(false)
        await write(false)
        expect(existsSync(plist)).toBe(true)   // the control: so the refusal above is the profile
      } finally {
        Bun.spawnSync(['/usr/bin/defaults', 'delete', domain])
        rmSync(plist, { force: true })
      }
    })

    test.skipIf(!Bun.which('pgrep'))('`pgrep -fl` shows another process\'s command line to the control and not under the profile', async () => {
      const mark = `HYDRA_ARGV_MARKER_${process.pid}_${Date.now()}`
      const victim = Bun.spawn([process.execPath, '-e', `setTimeout(()=>{},60000) // ${mark}`], { stdout: 'ignore', stderr: 'ignore' })
      try {
        await Bun.sleep(300)
        expect((await run(['/usr/bin/pgrep', '-fl', mark], false)).out).toContain('setTimeout')
        expect((await run(['/usr/bin/pgrep', '-fl', mark])).out).not.toContain('setTimeout')
      } finally { victim.kill() }
    })

    test.skipIf(!existsSync('/usr/bin/pbcopy'))('the pasteboard: not writable (an unsandboxed pbpaste sees nothing new) and not readable under the profile', async () => {
      // The operator's text clipboard is saved and put back.
      const old = Bun.spawnSync(['/usr/bin/pbpaste']).stdout.toString()
      const put = (text: string) => { Bun.spawnSync(['/usr/bin/pbcopy'], { stdin: new TextEncoder().encode(text) }) }
      const get = () => Bun.spawnSync(['/usr/bin/pbpaste']).stdout.toString()
      const mark = `hydra-pb-${process.pid}-${Date.now()}`
      try {
        put('before')
        const boxedWrite = Bun.spawn([SANDBOX_EXEC, '-p', profile(), '/usr/bin/pbcopy'], { stdin: new TextEncoder().encode(mark), stdout: 'ignore', stderr: 'ignore', env: clean })
        await boxedWrite.exited
        expect(get()).toBe('before')
        const controlWrite = Bun.spawn(['/usr/bin/pbcopy'], { stdin: new TextEncoder().encode(mark), stdout: 'ignore', stderr: 'ignore' })
        await controlWrite.exited
        expect(get()).toBe(mark)   // the control: so the refusal above is the profile
        expect((await run(['/usr/bin/pbpaste'], false)).out).toBe(mark)
        expect((await run(['/usr/bin/pbpaste'])).out).not.toContain(mark)
      } finally { put(old) }
    })
  })

  describe('keystrokes into the session\'s terminal (TIOCSTI)', () => {
    const haveTmux = !!Bun.which('tmux')
    const haveClang = !!Bun.which('clang')
    const privSock = join(dir, 'tty.sock')   // an exact socket in this test's own temp dir: never the operator's server
    const inj = join(dir, 'inj')
    const profileFile = join(dir, 'tty-profile.sb')
    const tmuxEnv: Record<string, string> = { ...clean, ...(process.env.TMUX_TMPDIR ? { TMUX_TMPDIR: process.env.TMUX_TMPDIR } : {}) }   // no TMUX in it
    beforeAll(() => {
      if (!haveClang) return
      writeFileSync(join(dir, 'inj.c'), `#include <stdio.h>\n#include <string.h>\n#include <fcntl.h>\n#include <unistd.h>\n#include <errno.h>\n#include <sys/ioctl.h>\nint main(int argc, char **argv) {\n  const char *mode = argc > 1 ? argv[1] : "rw";\n  int fd = 0;\n  if (strcmp(mode, "fd0") != 0) { fd = open("/dev/tty", strcmp(mode, "r") == 0 ? O_RDONLY : O_RDWR); if (fd < 0) { printf("open denied: %s\\n", strerror(errno)); return 0; } }\n  const char *s = "HYDRA_INJECTED\\n"; int ok = 0;\n  for (const char *p = s; *p; p++) { char c = *p; if (ioctl(fd, TIOCSTI, &c) == 0) ok++; }\n  printf("injected %d\\n", ok);\n  return 0;\n}\n`)
      Bun.spawnSync(['clang', '-o', inj, join(dir, 'inj.c')])
      writeFileSync(profileFile, profile())
    })
    afterAll(() => { if (haveTmux) Bun.spawnSync(`tmux -S ${privSock} kill-server`.split(' '), { env: tmuxEnv }) })

    /** Runs the injector inside a private tmux pane (so it has that pane's terminal) and returns the line the pane's own reader got. */
    async function inPane(name: string, boxed: boolean, mode: string): Promise<string> {
      const marker = join(dir, `tty-${name}.txt`)
      const script = join(dir, `tty-${name}.sh`)
      const wrap = boxed ? `${SANDBOX_EXEC} -f ${profileFile} ` : ''
      writeFileSync(script, `#!/bin/bash\n${wrap}${inj} ${mode} > ${marker}.inj 2>&1\nIFS= read -r -t 1 line\necho "got=[$line]" > ${marker}\n`, { mode: 0o755 })
      Bun.spawnSync(`tmux -S ${privSock} new-session -d -x 80 -y 24 -s ${name}`.split(' ').concat(script), { env: tmuxEnv })
      for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(150)) if (existsSync(marker)) return readFileSync(marker, 'utf8').trim()
      return 'timeout'
    }

    test.skipIf(!haveTmux || !haveClang).each(['rw', 'r', 'fd0'])('opened %s: the control types into the pane; under the profile nothing arrives', async mode => {
      expect(await inPane(`c-${mode}`, false, mode)).toBe('got=[HYDRA_INJECTED]')   // so the refusal below is the profile
      expect(await inPane(`b-${mode}`, true, mode)).toBe('got=[]')
    })
  })

  test('a stdio MCP server started under the profile answers initialize and tools/list', async () => {
    const stub = join(dir, 'stub.ts')
    writeFileSync(stub, `
for await (const line of console) {
  const m = JSON.parse(line)
  if (!('id' in m)) continue
  const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } : m.method === 'tools/list' ? { tools: [] } : {}
  console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
}
`)
    const w = sandboxedServer(process.execPath, realEnv, roots, folders)
    const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]
    const p = Bun.spawn([w.command, ...w.args, stub], { stdin: new TextEncoder().encode(msgs.map(m => JSON.stringify(m)).join('\n') + '\n'), stdout: 'pipe', stderr: 'pipe', env: clean })
    const out = await new Response(p.stdout).text()
    await p.exited
    const replies = out.trim().split('\n').map(l => JSON.parse(l))
    expect(replies[0].result.serverInfo.name).toBe('stub')
    expect(replies[1].result).toEqual({ tools: [] })
  })

  // `npx -y` fetches and runs a server, writing only to its private npm cache inside the server's own temp folder (HYDRA_REAL_NPX=1: needs the internet).
  test.skipIf(process.env.HYDRA_REAL_NPX !== '1' || !Bun.which('npx'))('`npx -y` of a pinned real server works with only the private cache writable', async () => {
    const w = sandboxedServer(Bun.which('npx')!, realEnv, roots, folders)
    const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]
    const cache = join(tmp, 'npm-cache')
    const p = Bun.spawn([w.command, ...w.args, '-y', '@modelcontextprotocol/server-memory@2.1.1'], { stdin: new TextEncoder().encode(msgs.map(m => JSON.stringify(m)).join('\n') + '\n'), stdout: 'pipe', stderr: 'pipe', env: { ...clean, npm_config_cache: cache, TMPDIR: tmp, MEMORY_FILE_PATH: join(tmp, 'memory.jsonl') } })
    const out = await new Response(p.stdout).text()
    setTimeout(() => p.kill(), 100)
    await p.exited
    const replies = out.trim().split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    expect(replies.find(x => x.id === 2).result.tools.length).toBeGreaterThan(0)
    expect(existsSync(cache)).toBe(true)
  }, 120_000)

  // A real server, not a stub: HYDRA_REAL_MCP=<path to an installed MCP server's executable>. Install one into a temp dir at a
  // pinned version first, e.g. `npm install --prefix <tmp> --ignore-scripts @modelcontextprotocol/server-memory@2.1.1`.
  test.skipIf(!process.env.HYDRA_REAL_MCP)('a real npm-installed MCP server starts under the profile and lists its tools', async () => {
    const w = sandboxedServer(process.env.HYDRA_REAL_MCP!, realEnv, roots, folders)
    const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]
    const p = Bun.spawn([w.command, ...w.args], { stdin: new TextEncoder().encode(msgs.map(m => JSON.stringify(m)).join('\n') + '\n'), stdout: 'pipe', stderr: 'pipe', env: { ...clean, MEMORY_FILE_PATH: join(dir, 'memory.jsonl') } })
    const out = await new Response(p.stdout).text()
    setTimeout(() => p.kill(), 100)
    await p.exited
    const replies = out.trim().split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    expect(replies.find(x => x.id === 1).result.serverInfo.name).toBeTruthy()
    expect(replies.find(x => x.id === 2).result.tools.length).toBeGreaterThan(0)
  })
})

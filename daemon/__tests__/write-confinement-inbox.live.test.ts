// Can the daemon be the only writer of a specialist's `<workdir>/.inbox`? Claude Code's `sandbox.filesystem.denyWrite` is tried with the real `claude -p` under hydra's own
// settings (confined-shell-probe.ts): what the confined Bash can and cannot do to a folder so marked. Off unless asked, because it runs the real claude:
//   HYDRA_LIVE_CLAUDE=1 scripts/test.sh --isolate daemon/__tests__/write-confinement-inbox.live.test.ts
// Result (Claude Code 2.1.326, macOS 15): the shell is refused create, overwrite, delete, rename and swap of the folder, and still reads it and writes elsewhere in the workdir;
// that also stops the specialist clearing a full folder, so hydra does not use it (docs/slack.md). Everything is in a throwaway HOME. Each line printed is the evidence.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { makeProbe, type Probe } from './confined-shell-probe.js'

const LIVE = process.env.HYDRA_LIVE_CLAUDE === '1' && process.platform === 'darwin' && !!Bun.which('claude')
const report: string[] = []
const say = (id: string, evidence: string) => { report.push(`INBOX-PROBE ${id}: ${evidence.replace(/\s+/g, ' ').trim().slice(0, 300)}`) }

describe.skipIf(!LIVE)('denyWrite on <workdir>/.inbox', () => {
  let pr: Probe, inbox: string
  const deny = (s: any) => { s.sandbox.filesystem.denyWrite = [inbox] }
  beforeAll(() => { pr = makeProbe('inbox-live'); inbox = join(pr.workdir, '.inbox'); mkdirSync(inbox, { mode: 0o700 }); writeFileSync(join(inbox, 'sent.txt'), 'sent-bytes') })
  afterAll(() => { pr?.stop(); process.stdout.write(`\n${report.join('\n')}\n`); if (pr) rmSync(pr.fake, { recursive: true, force: true }) })
  const sh = (command: string, withDeny = true) => pr.run({ name: 'Bash', input: { command } }, undefined, withDeny ? { tweak: deny } : undefined)

  test('control (no denyWrite): the shell can create and delete in .inbox', async () => {
    const out = await sh(`echo x > ${inbox}/c.txt; echo create_rc=$?; rm ${inbox}/c.txt; echo rm_rc=$?`, false)
    say('control', out)
    expect(out).toContain('create_rc=0'); expect(out).toContain('rm_rc=0')
  }, 90_000)
  test('with denyWrite: it can read a file there, write elsewhere in the workdir', async () => {
    const out = await sh(`cat ${inbox}/sent.txt; echo read_rc=$?; echo y > ${pr.workdir}/other.txt; echo other_rc=$?`)
    say('read+elsewhere', out)
    expect(out).toContain('sent-bytes'); expect(out).toContain('other_rc=0')
  }, 90_000)
  test('with denyWrite: it cannot create, overwrite, delete or rename a file there', async () => {
    const out = await sh(`echo x > ${inbox}/new.txt; echo create_rc=$?; echo x > ${inbox}/sent.txt; echo overwrite_rc=$?; rm ${inbox}/sent.txt; echo rm_rc=$?; mv ${inbox}/sent.txt ${pr.workdir}/moved.txt; echo mv_rc=$?`)
    say('file ops', out)
    expect(existsSync(join(inbox, 'new.txt'))).toBe(false)
    expect(readFileSync(join(inbox, 'sent.txt'), 'utf8')).toBe('sent-bytes')
  }, 90_000)
  test('with denyWrite: it cannot swap the folder itself for a link or move it away', async () => {
    const out = await sh(`mv ${inbox} ${pr.workdir}/inbox-moved; echo mv_rc=$?; rm -rf ${inbox}; echo rmrf_rc=$?; ln -s /tmp ${pr.workdir}/lnk; echo ln_other_rc=$?`)
    say('folder swap', out)
    expect(existsSync(inbox)).toBe(true)
    expect(existsSync(join(pr.workdir, 'inbox-moved'))).toBe(false)
  }, 90_000)
})

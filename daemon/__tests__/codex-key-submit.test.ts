import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { keyTiming, sendTmuxKeys } from '../codex-key-queue.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { fakeCodexAdapter } from './test-harness.js'

// Fake tmux executable on PATH, not a child_process mock. Perl, written once per
// file: a bun process per call and macOS's first-exec check per new file are slow.
const dir = mkdtempSync(join(tmpdir(), 'codex-keys-'))
const log = join(dir, 'calls')
const pane = join(dir, 'pane')
writeFileSync(join(dir, 'tmux'), String.raw`#!/usr/bin/perl
use Time::HiRes qw(time);
my $q = sub { my $s = shift; $s =~ s/(["\\])/\\$1/g; "\"$s\"" };
open(my $l, '>>', ${JSON.stringify(log)}) or die;
print $l '{"args":[' . join(',', map { $q->($_) } @ARGV) . '],"at":' . int(time * 1000) . "}\n";
close $l;
if ($ARGV[0] eq 'display-message') {
  if (grep { $_ eq '#{pane_id} #{pane_pid} #{pane_dead}' } @ARGV) { print "%1 100 0\n" }
  else { open(my $p, '<', ${JSON.stringify(pane)}) or die; local $/; print <$p> }
}
exit 1 if grep { $_ eq 'FAIL' } @ARGV;
`)
chmodSync(join(dir, 'tmux'), 0o755)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function withTmux(fn: (calls: (all?: boolean) => Array<{ args: string[]; at: number }>, pane: (text: string) => void) => Promise<void>) {
  const savedPath = process.env.PATH
  writeFileSync(log, '')
  writeFileSync(pane, '1 2 0\n› Ask Codex to do anything\n')
  process.env.PATH = `${dir}:${savedPath}`
  try {
    await fn((all = false) => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => all || call.args[0] === 'send-keys'),
      text => writeFileSync(pane, text))
  } finally {
    process.env.PATH = savedPath
  }
}

// Shrink real delays; production defaults are pinned below.
const defaults = { settleMs: keyTiming.settleMs, deadline: CodexEngineAdapter.COMPOSER_DEADLINE_MS, poll: CodexEngineAdapter.COMPOSER_POLL_MS }
beforeEach(() => { keyTiming.settleMs = 30; CodexEngineAdapter.COMPOSER_POLL_MS = 10 })
afterEach(() => {
  keyTiming.settleMs = defaults.settleMs
  CodexEngineAdapter.COMPOSER_DEADLINE_MS = defaults.deadline
  CodexEngineAdapter.COMPOSER_POLL_MS = defaults.poll
})

const CURSOR_PROBE = '#{cursor_flag} #{cursor_x} #{cursor_y}'
async function probesSeen(calls: (all?: boolean) => Array<{ args: string[] }>, n: number) {
  while (calls(true).filter(call => call.args.includes(CURSOR_PROBE)).length < n) await Bun.sleep(5)
}

describe('Codex key submission', () => {
  test('production timing defaults', () => {
    expect(defaults).toEqual({ settleMs: 250, deadline: 5000, poll: 100 })
  })

  test('settles literal text before the single default Enter', async () => {
    await withTmux(async calls => {
      await sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' })
      const sent = calls()
      expect(sent.map(call => call.args.slice(3))).toEqual([['-l', '/status'], ['Enter']])
      expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(keyTiming.settleMs)
    })
  })

  test('keeps literal text and one trailing key atomic with raw controls in FIFO order', async () => {
    await withTmux(async calls => {
      await Promise.all([
        sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' }),
        sendTmuxKeys({ target: 'a', mode: 'raw', keys: ['Down', 'Enter'] }),
        sendTmuxKeys({ target: 'a', mode: 'literal', text: '/model', trailingKey: 'Escape' }),
      ])
      const sent = calls()
      expect(sent.map(call => call.args.slice(3))).toEqual([
        ['-l', '/status'], ['Enter'], ['Down', 'Enter'], ['-l', '/model'], ['Escape'],
      ])
      expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(keyTiming.settleMs)
      expect(sent[4].at - sent[3].at).toBeGreaterThanOrEqual(keyTiming.settleMs)
    })
  })

  test('another target proceeds while one target waits for readiness', async () => {
    await withTmux(async calls => {
      let release!: () => void
      const waiting = new Promise<void>(resolve => { release = resolve })
      const first = sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' }, () => waiting)
      await sendTmuxKeys({ target: 'b', mode: 'raw', keys: ['Escape'] })
      expect(calls().map(call => call.args[2])).toEqual(['b'])
      release()
      await first
    })
  })

  test('failed text sends no trailing key and subsequent same-target action succeeds', async () => {
    await withTmux(async calls => {
      const first = sendTmuxKeys({ target: 'a', mode: 'literal', text: 'FAIL' })
      const second = sendTmuxKeys({ target: 'a', mode: 'raw', keys: ['Escape'] })
      await expect(first).rejects.toThrow()
      await second
      expect(calls().map(call => call.args.slice(3))).toEqual([['-l', 'FAIL'], ['Escape']])
    })
  })

  test('readiness failure sends nothing and does not poison the next action', async () => {
    await withTmux(async calls => {
      await expect(sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' }, async () => {
        throw new Error('cold')
      })).rejects.toThrow('cold')
      await sendTmuxKeys({ target: 'a', mode: 'raw', keys: ['Enter'] })
      expect(calls().map(call => call.args.slice(3))).toEqual([['Enter']])
    })
  })

  test('adapter waits for cold composer; active turn does not gate keys', async () => {
    await withTmux(async (calls, pane) => {
      pane('Loading…\n')
      const adapter = fakeCodexAdapter()
      const sent = adapter.sendKeys({ tmuxName: 'a' } as any, '/status')
      await probesSeen(calls, 2)
      expect(calls()).toEqual([])
      pane('1 2 0\n› Ask Codex to do anything\n')
      await expect(sent).resolves.toEqual({ queued: false })
      expect(calls().filter(call => call.args[0] === 'send-keys').map(call => call.args.slice(3)))
        .toEqual([['-l', '/status'], ['Enter']])
    })
  })

  test('adapter checks readiness again for each serialized literal action', async () => {
    await withTmux(async calls => {
      const adapter = fakeCodexAdapter()
      await Promise.all([
        adapter.sendKeys({ tmuxName: 'a' } as any, '/status'),
        adapter.sendKeys({ tmuxName: 'a' } as any, '/model'),
      ])
      expect(calls(true).filter(call => call.args.includes('#{cursor_flag} #{cursor_x} #{cursor_y}') || call.args[0] === 'send-keys').map(call => call.args[0])).toEqual([
        'display-message', 'send-keys', 'send-keys', 'display-message', 'send-keys', 'send-keys',
      ])
    })
  })

  test('raw dialog controls bypass composer readiness and add no Enter', async () => {
    await withTmux(async (calls, pane) => {
      pane('Unrecognized dialog\n')
      const adapter = fakeCodexAdapter()
      await adapter.sendKeys({ tmuxName: 'a' } as any, 'Down Enter', { raw: true })
      expect(calls().map(call => call.args)).toEqual([['send-keys', '-t', 'a:hydra-chat', 'Down', 'Enter']])
    })
  })

  test('menu selection markers and stale prompts are not ready composers', async () => {
    await withTmux(async (calls, pane) => {
      const adapter = fakeCodexAdapter()
      for (const dialog of [
        '0 120 3\nSelect Model and Effort\n› 1. GPT-6-Astra (current)\n\n  enter select · esc back\n',
        '0 120 3\nUpdate Model Permissions\n› 3. Full Access (current)\n\n  enter select · esc back\n',
        '1 2 2\n› historical prompt\n\nSome other focused input\n',
      ]) {
        const before = calls().length
        const probes = calls(true).filter(call => call.args.includes(CURSOR_PROBE)).length
        pane(dialog)
        const sending = adapter.sendKeys({ tmuxName: 'a' } as any, '/status')
        await probesSeen(calls, probes + 3)
        expect(calls()).toHaveLength(before)
        pane('1 2 0\n› Ask Codex to do anything\n')
        await sending
        expect(calls()).toHaveLength(before + 2)
      }
    })
  })

  test('unready composer times out without typing', async () => {
    await withTmux(async (calls, pane) => {
      pane('Loading…\n')
      CodexEngineAdapter.COMPOSER_DEADLINE_MS = 100
      const adapter = fakeCodexAdapter()
      const start = Date.now()
      await expect(adapter.sendKeys({ tmuxName: 'a' } as any, '/status')).rejects.toThrow('no text was sent')
      expect(Date.now() - start).toBeLessThan(CodexEngineAdapter.COMPOSER_DEADLINE_MS + 1000)
      expect(calls()).toEqual([])
    })
  })
})

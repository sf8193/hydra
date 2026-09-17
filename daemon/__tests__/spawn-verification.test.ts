import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugLogSize, bridgeConfigured } from '../engines/claude-engine.js'

/**
 * The debug log is the only place that answers "was the bridge ever in this
 * session's MCP config?" — the plugin loads either way, and a miss is reported
 * nowhere else. Both spawn attempts append to the same log, whose name is keyed
 * on the hydra session id and tmux name, so the retry must read past the mark
 * the first attempt left or it would find the first attempt's own evidence.
 */
describe('debug log mark', () => {
  let dir: string
  let log: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hydra-spawn-verify-'))
    log = join(dir, 'debug-scout-abc.log')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a log that does not exist yet marks at zero', () => {
    expect(debugLogSize(log)).toBe(0)
  })

  test('an engine with no debug log marks at zero', () => {
    expect(debugLogSize(undefined)).toBe(0)
  })

  test('the mark is where the next attempt starts reading', () => {
    writeFileSync(log, 'first attempt, no bridge line\n')
    const mark = debugLogSize(log)
    expect(mark).toBeGreaterThan(0)

    appendFileSync(log, 'MCP server "plugin:discord:discord": Starting connection\n')
    expect(debugLogSize(log)).toBeGreaterThan(mark)
  })
})

/**
 * The signature of the fault, as three sessions showed it: the plugin's skills
 * load and the bridge is never named — not started, not skipped, not errored.
 * Reading that as "configured" would let a doomed process sit out the full
 * timeout; reading a slow start as "missed" would respawn a healthy session.
 */
describe('bridge configuration probe', () => {
  let dir: string
  let log: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hydra-spawn-probe-'))
    log = join(dir, 'debug-scout-abc.log')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a plugin that loaded without its bridge reads as unconfigured', () => {
    writeFileSync(log, [
      'Checking plugin discord: skillsPath=exists, skillsPaths=0 paths',
      'Loaded 2 skills from plugin discord default directory',
      'MCP server "plugin:playwright:playwright": Starting connection with timeout of 30000ms',
      'MCP server "plugin:slack:slack": Starting connection with timeout of 30000ms',
    ].join('\n'))
    expect(bridgeConfigured(log, 0)).toBe(false)
  })

  test('a bridge that is merely slow to connect reads as configured', () => {
    writeFileSync(log, 'MCP server "plugin:discord:discord": Starting connection with timeout of 30000ms\n')
    expect(bridgeConfigured(log, 0)).toBe(true)
  })

  test('the first attempt\'s bridge line is not read as the retry\'s', () => {
    writeFileSync(log, 'MCP server "plugin:discord:discord": Starting connection\n')
    const mark = debugLogSize(log)
    appendFileSync(log, 'Loaded 2 skills from plugin discord default directory\n')
    expect(bridgeConfigured(log, mark)).toBe(false)
  })

  test('a retry that does configure the bridge is seen past the mark', () => {
    writeFileSync(log, 'first attempt, no bridge\n')
    const mark = debugLogSize(log)
    appendFileSync(log, 'MCP server "plugin:discord:discord": Starting connection\n')
    expect(bridgeConfigured(log, mark)).toBe(true)
  })

  test('nothing appended since the mark is unknown, not a miss', () => {
    writeFileSync(log, 'first attempt\n')
    expect(bridgeConfigured(log, debugLogSize(log))).toBe(true)
  })

  test('an unreadable log never convicts a healthy spawn', () => {
    expect(bridgeConfigured(join(dir, 'absent.log'), 0)).toBe(true)
  })
})

import { describe, test, expect } from 'bun:test'
import { isOwnedDevSession, selectOrphanedDevSessions } from '../util.js'
import { LOCAL_STACK_INSTRUCTION } from '../prompts/session.js'

describe('isOwnedDevSession', () => {
  test('matches the bare name and labelled variants', () => {
    expect(isOwnedDevSession('hydra-dev-vale', ['vale'])).toBe(true)
    expect(isOwnedDevSession('hydra-dev-vale-app', ['vale'])).toBe(true)
  })

  test('a name prefix does not capture another session dev sessions', () => {
    expect(isOwnedDevSession('hydra-dev-valence-app', ['vale'])).toBe(false)
    expect(isOwnedDevSession('hydra-dev-vale2', ['vale'])).toBe(false)
  })

  test('hex fallback names with hyphens match only their own sessions', () => {
    expect(isOwnedDevSession('hydra-dev-session-a1b2c3-app', ['session-a1b2c3'])).toBe(true)
    expect(isOwnedDevSession('hydra-dev-session-a1b2c3-app', ['session-a1b2c4'])).toBe(false)
  })
})

describe('selectOrphanedDevSessions', () => {
  test('selects only unowned sessions inside the hydra namespace', () => {
    const names = ['vale', 'hydra-dev-vale-app', 'hydra-dev-ghost-app', 'dev-api', 'dev-scratch', 'hydra-transcribe']
    expect(selectOrphanedDevSessions(names, ['vale'])).toEqual(['hydra-dev-ghost-app'])
  })

  test('a human dev-* session is never selected, whatever the owners', () => {
    const names = ['dev-api', 'dev-scratch', 'dev-vale', 'dev-vale-app']
    expect(selectOrphanedDevSessions(names, [])).toEqual([])
    expect(selectOrphanedDevSessions(names, ['vale', 'api'])).toEqual([])
  })

  test('a live tmux session owns its dev sessions even with no registry record', () => {
    const names = ['ember', 'hydra-dev-ember-graph']
    expect(selectOrphanedDevSessions(names, [])).toEqual([])
  })

  test('an empty owner set does not make every hydra dev session orphaned', () => {
    expect(selectOrphanedDevSessions(['hydra-dev-vale-app', 'vale'], [])).toEqual([])
    expect(selectOrphanedDevSessions(['hydra-dev-vale-app'], [])).toEqual(['hydra-dev-vale-app'])
  })
})

describe('producer and consumer agree', () => {
  test('the reaper recognises exactly the session name the prompt tells an agent to create', () => {
    const tmuxName = 'vale'
    const rule = LOCAL_STACK_INSTRUCTION(tmuxName, '/tmp/wt')
    const created = rule.match(/tmux new-session -d -s (\S+)/)?.[1]
    expect(created).toBeDefined()

    const concrete = created!.replace('<label>', 'app')
    expect(isOwnedDevSession(concrete, [tmuxName])).toBe(true)
    expect(selectOrphanedDevSessions([concrete], [tmuxName])).toEqual([])
    expect(selectOrphanedDevSessions([concrete], [])).toEqual([concrete])
  })

  test('the teardown command the prompt gives targets the same name', () => {
    const rule = LOCAL_STACK_INSTRUCTION('vale', '/tmp/wt')
    const created = rule.match(/tmux new-session -d -s (\S+)/)?.[1]
    const killed = rule.match(/tmux kill-session -t (\S+?)`/)?.[1]
    expect(killed).toBe(created)
  })
})

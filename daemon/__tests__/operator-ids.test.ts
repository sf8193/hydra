import { describe, test, expect, afterEach } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { gate, operatorIds } from '../access.js'
import { _setHydraConfigForTesting, hydraConfigPath, startHydraConfig, stopHydraConfig } from '../hydra-config.js'
import type { HydraConfig } from '../../config/types.js'
import type { InboundMessage } from '../../gateways/gateway.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'

// The suite runs as the discord platform (CHAT_PLATFORM unset).
const withOperator: HydraConfig = {
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, specialists: {}, places: {}, schedules: {}, rules: [],
  people: {
    op: { id: 'op', addresses: ['discord:100000000000000001', 'slack:U0OP', 'github:op'], roles: [], name: 'op' },
    alice: { id: 'alice', addresses: ['discord:100000000000000002'], roles: ['staff'], name: 'alice' },
  },
}
const dm = (authorId: string) => ({ isDM: true, authorId, chatId: 'D1', content: 'hi', messageId: 'm1' }) as unknown as InboundMessage

afterEach(() => { _setHydraConfigForTesting(undefined); stopHydraConfig(); rmSync(hydraConfigPath(), { force: true }) })

describe('operatorIds: who every admin check means', () => {
  test('hydra.toml\'s operator, by their addresses on this platform', () => {
    _setHydraConfigForTesting(withOperator)
    expect(operatorIds()).toEqual(['100000000000000001'])
  })

  test('a hydra.toml that fails to load at boot gives nobody, never allowFrom', () => {
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    startHydraConfig({ env: testLoadEnv({ home: '/h', sessionNames: [] }) })
    expect(operatorIds()).toEqual([])
  })

  test('an operator with no address on this platform gives nobody', () => {
    _setHydraConfigForTesting({ ...withOperator, people: { op: { id: 'op', addresses: ['slack:U0OP'], roles: [], name: 'op' } } })
    expect(operatorIds()).toEqual([])
  })

  test('nobody while hydra.toml names no operator: an access.json allowFrom no longer counts', () => {
    writeFileSync(join(dirname(hydraConfigPath()), 'access.json'), JSON.stringify({ allowFrom: ['999'] }))
    expect(operatorIds()).toEqual([])
    rmSync(join(dirname(hydraConfigPath()), 'access.json'), { force: true })
  })
})

describe('the DM gate', () => {
  test('lets the operator\'s DM through; another person on the roster, or any other id, is dropped', async () => {
    _setHydraConfigForTesting(withOperator)
    expect((await gate(dm('100000000000000001'))).action).toBe('deliver')
    expect((await gate(dm('999'))).action).toBe('drop')
    // Another person on the roster doesn't reach main by DM; routing their DMs to a specialist is a later step.
    expect((await gate(dm('100000000000000002'))).action).toBe('drop')
  })

  test('issues no pairing code: a stranger\'s DM is dropped with or without a hydra.toml', async () => {
    _setHydraConfigForTesting(withOperator)
    expect((await gate(dm('100000000000000009'))).action).toBe('drop')
    _setHydraConfigForTesting(undefined)
    expect((await gate(dm('100000000000000009'))).action).toBe('drop')
  })
})

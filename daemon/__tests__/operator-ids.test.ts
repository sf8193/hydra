import { describe, test, expect, afterEach } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { ACCESS_FILE } from '../config.js'
import { gate, operatorIds } from '../access.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import type { HydraConfig } from '../../config/types.js'
import type { InboundMessage } from '../../gateway.js'

// The suite runs as the discord platform (CHAT_PLATFORM unset).
const withOperator: HydraConfig = {
  operator: 'op', connectors: {}, specialists: {}, places: {}, schedules: {}, rules: [],
  people: {
    op: { id: 'op', ids: ['discord:100000000000000001', 'slack:U0OP', 'github:op'], roles: [], name: 'op' },
    alice: { id: 'alice', ids: ['discord:100000000000000002'], roles: ['staff'], name: 'alice' },
  },
}
const dm = (authorId: string) => ({ isDM: true, authorId, chatId: 'D1', content: 'hi', messageId: 'm1' }) as unknown as InboundMessage

afterEach(() => { _setHydraConfigForTesting(undefined); rmSync(ACCESS_FILE, { force: true }) })

describe('operatorIds: who every admin check means', () => {
  test('hydra.toml\'s operator, by their addresses on this platform', () => {
    _setHydraConfigForTesting(withOperator)
    expect(operatorIds({ allowFrom: ['999'] })).toEqual(['100000000000000001'])
  })

  test('access.json\'s allowFrom while hydra.toml names no operator', () => {
    expect(operatorIds({ allowFrom: ['999', '998'] })).toEqual(['999', '998'])
  })
})

describe('the DM gate', () => {
  test('lets the operator\'s DM through, and no longer an id only allowFrom lists', async () => {
    writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['999'], groups: {}, pending: {} }))
    _setHydraConfigForTesting(withOperator)
    expect((await gate(dm('100000000000000001'))).action).toBe('deliver')
    expect((await gate(dm('999'))).action).toBe('drop')
    // Another person on the roster doesn't reach main by DM; routing their DMs to a specialist is a later step.
    expect((await gate(dm('100000000000000002'))).action).toBe('drop')
  })

  test('without hydra.toml, allowFrom still decides', async () => {
    writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['999'], groups: {}, pending: {} }))
    expect((await gate(dm('999'))).action).toBe('deliver')
  })
})

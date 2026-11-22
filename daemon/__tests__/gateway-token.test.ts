// The chat gateway's token is the daemon's alone: it is read from what the scrub held, so no session (and nothing the daemon forks) can read it.
import { expect, test } from 'bun:test'
import { TOKEN } from '../../infra/config.js'
import { capturedSpawnVars, scrubbedSpawnEnv, scrubbedSpawnVars } from '../../shared/spawn-env.js'

// scripts/test.sh starts bun with DISCORD_BOT_TOKEN=test-token (a dummy; the daemon exits without one).
test('the daemon holds the gateway token for its gateway and leaves none in its own environment', () => {
  expect(TOKEN).toBe('test-token')
  expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined()
  expect(capturedSpawnVars().DISCORD_BOT_TOKEN).toBe('test-token')
  expect(scrubbedSpawnVars()).toContain('DISCORD_BOT_TOKEN')
  expect(scrubbedSpawnEnv({ DISCORD_BOT_TOKEN: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin' })
})

import { expect, test } from 'bun:test'
import { DiscordGateway } from '../discord-gateway'

function gatewayFailingWith(err: unknown) {
  const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
  ;(gw as any).fetchChannel = async () => { if (err) throw err; return {} }
  return gw
}

test('Unknown Channel (10003) and a not-found message mean the thread is gone', async () => {
  expect(await gatewayFailingWith(Object.assign(new Error('Unknown Channel'), { code: 10003 })).threadExists('1')).toBe(false)
  expect(await gatewayFailingWith(new Error('channel 1 not found or not text-based')).threadExists('1')).toBe(false)
})

test('a live thread or any other failure counts as present', async () => {
  expect(await gatewayFailingWith(null).threadExists('1')).toBe(true)
  expect(await gatewayFailingWith(Object.assign(new Error('Missing Access'), { code: 50001 })).threadExists('1')).toBe(true)
})

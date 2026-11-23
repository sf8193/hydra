// Another app's message reaches the router (which hears it only when hydra.toml declares the app): the Discord gateway no longer drops bots itself.
import { expect, spyOn, test } from 'bun:test'
import { ChannelType, Client } from 'discord.js'
import { DiscordGateway } from '../discord.js'
import type { InboundMessage } from '../gateway.js'

test('a message by a bot is handed on, marked isBot', async () => {
  const login = spyOn(Client.prototype, 'login').mockImplementation((async () => 'x') as any)
  const g = new DiscordGateway()
  const got: InboundMessage[] = []
  g.onMessage(async m => { got.push(m) })
  void g.start('test-token')
  const fake = (bot: boolean) => ({ id: bot ? 'b1' : 'p1', channelId: 'C1', author: { id: bot ? 'U-BOT' : 'U-PERSON', username: 'x', bot }, content: 'hi', attachments: new Map(), channel: { type: ChannelType.GuildText, isDMBased: () => false, isThread: () => false }, reference: null, createdTimestamp: Date.now(), createdAt: new Date() })
  const client = (g as any).client as Client
  client.emit('messageCreate', fake(true) as any)
  client.emit('messageCreate', fake(false) as any)
  await Bun.sleep(20)
  login.mockRestore()
  client.destroy()
  expect(got.map(m => [m.authorId, m.isBot])).toEqual([['U-BOT', true], ['U-PERSON', false]])
})

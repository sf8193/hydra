import { expect, test } from 'bun:test'
import { MessagePayload } from 'discord.js'
import { DISCORD_ALLOWED_MENTIONS, DiscordGateway } from '../discord-gateway.js'

test('Discord sends ping users and the replied-to author, never @everyone, @here or roles', () => {
  expect(DISCORD_ALLOWED_MENTIONS).toEqual({ parse: ['users'], repliedUser: true })
  // Set on the client, so it is the default for every send path, not only the ones that pass it.
  const client = (new DiscordGateway({ heartbeatPath: null }) as any).client
  expect(client.options.allowedMentions).toEqual(DISCORD_ALLOWED_MENTIONS)
  // And it reaches the request body every send builds, in Discord's wire form.
  const body = MessagePayload.create({ client } as any, 'x').resolveBody().body as any
  expect(body.allowed_mentions).toEqual({ parse: ['users'], replied_user: true })
})

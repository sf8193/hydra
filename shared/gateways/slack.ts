import type { GatewayProfile } from './profile.js'

// postsReactions: false: the Slack gateway's `react` is a no-op (a bot's reaction pushes a notification). Reactions people post are heard regardless, and are hydra.toml's `reactions`.
export const slack: GatewayProfile = {
  label: 'Slack', channelNames: true, perAppDms: true, previewsWrappedLinks: true,
  postsReactions: false,
  isDmId: id => id.startsWith('D'),
}

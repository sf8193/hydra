import type { GatewayProfile } from './profile.js'

/** The id Discord's link-preview places call a DM by: a DM has no channel id of its own to name it. */
export const DISCORD_DM_ID = 'dm'

export const discord: GatewayProfile = {
  label: 'Discord', channelNames: false, perAppDms: false, previewsWrappedLinks: false,
  isDmId: id => id === DISCORD_DM_ID,
}

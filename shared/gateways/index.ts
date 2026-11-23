// The chat platforms hydra can run as its gateway, one profile each (shared/gateways/<platform>.ts). Code that behaves differently by platform asks the profile's capability and never
// names the platform (scripts/check-rules.ts, `platform-name-branch`); the gateway's own behaviour stays in gateways/.

import type { ChatPlatform } from '../../config/types.js'
import { discord } from './discord.js'
import type { GatewayProfile } from './profile.js'
import { slack } from './slack.js'

export type { ChatPlatform } from '../../config/types.js'
export type { GatewayProfile } from './profile.js'

export const GATEWAY_PROFILES = { discord, slack } as const satisfies Record<ChatPlatform, GatewayProfile>

/** Every platform that can be a daemon's gateway. */
export const GATEWAY_PLATFORMS = Object.keys(GATEWAY_PROFILES) as readonly ChatPlatform[]

export const isChatPlatform = (s: string): s is ChatPlatform => Object.hasOwn(GATEWAY_PROFILES, s)

export const gatewayProfile = (platform: ChatPlatform): GatewayProfile => GATEWAY_PROFILES[platform]

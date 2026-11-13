// Whether hydra.toml turns link previews off where a message is going (`[places]` `link_previews = false`).
//
// Each gateway asks this at its one point of sending (Slack: `postMessage`; Discord: `previewPolicy`), and the Slack connector's listener asks it
// the same way with its own view, so what a place says is decided by this one function. A leaf module: the gateways cannot import hydra.toml's loader (config.ts builds the
// gateway), so the daemon registers where the config and Slack's channel names come from.

import type { HydraConfig } from '../config/types.js'

type Source = {
  config: () => Pick<HydraConfig, 'places'> | undefined
  /** A Slack channel's name, when any connected app has read it. */
  slackName: (channel: string) => string | undefined
}

const source: Source = { config: () => undefined, slackName: () => undefined }

/** The daemon says where the live hydra.toml is (daemon/hydra-config.ts). */
export const registerPreviewConfig = (config: Source['config']): void => { source.config = config }

/** The Slack connector says how a channel id is named (connectors/slack/runtime.ts). */
export const registerSlackChannelNames = (slackName: Source['slackName']): void => { source.slackName = slackName }

/** Where a caller that has its own view of hydra.toml and of Slack's channel names (a connected app) asks from, instead of the registered ones. */
export type PreviewSources = { config?: Pick<HydraConfig, 'places'>; slackName?: (channel: string) => string | undefined }

/** The `[places]` keys a channel goes by: its id (a Discord thread and its parent channel both count), and a Slack channel's `#name`. A Discord DM is the id `dm`. */
export function placeKeysOf(platform: 'slack' | 'discord', ids: readonly string[], slackName: (channel: string) => string | undefined = source.slackName): string[] {
  const keys: string[] = []
  for (const id of ids) {
    keys.push(`${platform}:${id}`)
    if (platform === 'slack') {
      if (id.startsWith('D')) keys.push('slack:dm')
      const name = slackName(id)
      if (name) keys.push(`slack:#${name}`)
    }
  }
  return keys
}

/** True when a place any of these channels goes by sets `link_previews = false`. Anything not declared keeps previews on. */
export function linkPreviewsOff(platform: 'slack' | 'discord', ids: readonly string[], from: PreviewSources = {}): boolean {
  const places = (from.config ?? source.config())?.places
  if (!places) return false
  return placeKeysOf(platform, ids, from.slackName ?? source.slackName).some(k => Object.hasOwn(places, k) && places[k].linkPreviews === false)
}

// Whether hydra.toml turns link previews off where a message is going (`[places]` `link_previews = false`, or `"single"` and the post has 2+ links).
//
// Each gateway asks this at its one point of sending (Slack: `postMessage`; Discord: `previewPolicy`), and the Slack connector asks it
// the same way with its own view, so what a place says is decided by this one function. A leaf module: the gateways cannot import hydra.toml's loader (config.ts builds the
// gateway), so the daemon registers where the config and Slack's channel names come from.

import { EVERY, optionsOf, placeOf, type ChatPlatform, type HydraConfig, type Place } from '../config/types.js'
import { gatewayProfile } from './gateways/index.js'

type Source = {
  config: () => Pick<HydraConfig, 'places'> | undefined
  /** A Slack channel's name, when any connected app has read it. */
  slackName: (channel: string) => string | undefined
}

const source: Source = { config: () => undefined, slackName: () => undefined }

/** The daemon says where the live hydra.toml is (infra/hydra-config.ts). */
export const registerPreviewConfig = (config: Source['config']): void => { source.config = config }

/** The Slack connector says how a channel id is named (connectors/slack/runtime.ts). */
export const registerSlackChannelNames = (slackName: Source['slackName']): void => { source.slackName = slackName }

/** Where a caller that has its own view of hydra.toml and of Slack's channel names (a connected app) asks from, instead of the registered ones. */
export type PreviewSources = { config?: Pick<HydraConfig, 'places'>; slackName?: (channel: string) => string | undefined; /** The declared Slack app that sends: a DM with its bot is `slack:app-dm:<app>`. Absent (a sender that is no `[slack.apps]` app, like the Slack gateway's own bot): only `slack:app-dm:*` applies to its DMs. */ app?: string }

/** The places a channel goes by: its id (a Discord thread and its parent channel both count), and a Slack channel's `#name`. A DM is the one DM place of the app that sends: a Discord DM is the id `dm`, a Slack DM an id starting with `D`. */
export function placesFor(platform: ChatPlatform, ids: readonly string[], slackName: (channel: string) => string | undefined = source.slackName, app?: string): Place[] {
  const at: Place[] = []
  const profile = gatewayProfile(platform)
  for (const id of ids) {
    if (profile.isDmId(id)) { at.push(placeOf(platform, 'app-dm', profile.perAppDms ? app ?? EVERY : EVERY)); continue }
    at.push(placeOf(platform, 'channel', id))
    const name = profile.channelNames ? slackName(id) : undefined
    if (name) at.push(placeOf(platform, 'channel', `#${name}`))
  }
  return at
}

/**
 * True when this post goes out without previews: a place any of these channels goes by sets `link_previews = false`, or one sets
 * `link_previews = "single"` and `text` (what the post shows) carries two or more links the platform would preview (`linksPreviewed`). Anything not declared keeps previews on.
 */
export function linkPreviewsOff(platform: ChatPlatform, ids: readonly string[], from: PreviewSources, text: string): boolean {
  const places = (from.config ?? source.config())?.places
  if (!places) return false
  const said = placesFor(platform, ids, from.slackName ?? source.slackName, from.app).map(p => optionsOf(places, p)?.linkPreviews)
  if (said.includes(false)) return true
  return said.includes('single') && linksPreviewed(platform, text) >= 2
}

/**
 * How many different links in `text` the platform would preview. Code (fenced or inline) previews nothing on either. A markdown link counts on a platform that previews wrapped links (`previewsWrappedLinks`: Slack), and elsewhere (Discord) unless its URL is wrapped in `<…>`. Slack previews
 * `<url>` and `<url|label>` and a bare URL it links itself; Discord previews a bare URL (a markdown link's too) but not one wrapped in `<…>`.
 */
export function linksPreviewed(platform: ChatPlatform, text: string): number {
  const urls = new Set<string>()
  const wrappedShows = gatewayProfile(platform).previewsWrappedLinks
  let rest = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  // A markdown link first, so two that touch are two and its `)` does not run into the next URL.
  rest = rest.replace(/\[[^\]]*\]\((<)?(https?:\/\/[^\s)>]+)>?\)/g, (_m, wrapped: string | undefined, url: string) => { if (wrappedShows || !wrapped) urls.add(url); return ' ' })
  rest = rest.replace(/<(https?:\/\/[^\s<>|]+)(?:\|[^>]*)?>/gi, (_m, url: string) => { if (wrappedShows) urls.add(url); return ' ' })
  for (const m of rest.matchAll(/https?:\/\/[^\s<>|",[\]]+/gi)) urls.add(m[0].replace(/[.;:!?)'*_~]+$/, ''))
  return urls.size
}

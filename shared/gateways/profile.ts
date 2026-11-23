// What one chat platform is, as code outside its gateway needs to know it: its name for a person, whether a reaction is posted, how it draws a time, how its DMs and
// channels are addressed, and which links it previews. Each gateway keeps its own profile in its own file (shared/gateways/<platform>.ts); the table in shared/gateways/index.ts
// is the only place that names them all. A profile is plain data, so a pure module (the link-preview policy) can read it without importing a gateway.

export type GatewayProfile = {
  /** How a message or notice names the platform. */
  label: string
  /** Whether a conversation id is a DM's: Discord marks a DM with the id `dm`; Slack ids that start with `D` are DMs. */
  isDmId: (id: string) => boolean
  /** A channel is also addressed by `#name` in hydra.toml, as well as by its id (Discord channels are named by id only). */
  channelNames: boolean
  /** Every app has its own DM with a person (Slack apps); false: one bot, so one DM. */
  perAppDms: boolean
  /** A link wrapped to hold a preview back (`<url>`, or a markdown link's `(<url>)`) still shows one. Discord suppresses it. */
  previewsWrappedLinks: boolean
}

// One emoji, as a person types it: the character itself, not its name. A `hydra.toml` `emoji` is shown in a thread name and used as a reaction, and neither
// renders a `:name:` (Discord and Slack turn a name into an image only inside a message), so a name is refused here, with what to write instead.

const SEGMENTS = new Intl.Segmenter('en', { granularity: 'grapheme' })
const REGIONS = new Intl.DisplayNames('en', { type: 'region', fallback: 'none' })
/** The longest value kept, in UTF-16 units: a family emoji is 11 and a tag flag 14, and a longer ZWJ chain would push the thread name's focus text out of its 100 characters. */
const MAX_UNITS = 16
// Emoji presentation: a pictograph that shows as a picture on its own, or one made so by U+FE0F. A bare `™`, `©` or `❤` shows as text on some systems.
const PICTURE = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)`
const JOINED = String.raw`‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️?)\p{Emoji_Modifier}?`
const PICTOGRAPH = new RegExp(String.raw`^${PICTURE}(?:\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*(?:${JOINED})*$`, 'u')
const FLAG = /^\p{Regional_Indicator}{2}$/u
const KEYCAP = /^[0-9#*]️⃣$/u
const regionOf = (flag: string) => [...flag].map(c => String.fromCharCode(c.codePointAt(0)! - 0x1F1E6 + 65)).join('')

/** Why `raw` is not one emoji (what to write instead), or undefined when it is. The value is printed JSON-quoted, so a control character cannot reach a log as itself. */
export function emojiProblem(raw: unknown): string | undefined {
  const hint = 'write the one emoji character itself, like emoji = "🔐"'
  if (typeof raw !== 'string') return `must be a string: ${hint}`
  const shown = JSON.stringify(raw)
  if (raw === '') return `is empty: ${hint}, or leave \`emoji\` out to keep the default`
  if (raw.trim() !== raw) return `${shown} has a space around it: ${hint}`
  if (/^:[\w+-]+:$/.test(raw)) return `${shown} is an emoji's name, and a thread name shows only the character: ${hint}`
  if (raw.length > MAX_UNITS) return `${shown} is longer than ${MAX_UNITS} characters, more than any one emoji: ${hint}`
  if ([...SEGMENTS.segment(raw)].length !== 1) return `${shown} is not one emoji: ${hint}`
  if (raw.endsWith('‍')) return `${shown} ends with a joiner, so it is not a whole emoji: ${hint}`
  if (FLAG.test(raw)) {
    const country = REGIONS.of(regionOf(raw))
    return country && country !== 'Unknown Region' ? undefined : `${shown} is a flag of no country: ${hint}`
  }
  if (KEYCAP.test(raw) || PICTOGRAPH.test(raw)) return undefined
  const text = /^\p{Extended_Pictographic}/u.test(raw)
  return text ? `${shown} shows as text on some systems, not as a picture: ${hint}, in its emoji form (copy it from an emoji picker, which adds the invisible U+FE0F)` : `${shown} is not an emoji: ${hint}`
}

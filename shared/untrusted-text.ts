// How other people's words are shown to a model: cleaned, one clean line per attribute, and the body quoted line by line.
//
// The Slack delivery (connectors/slack/watch.ts renderItem) and a restricted session's envelope (app/sends-to.ts) both
// render text that a sender controls, so they share these primitives and nothing else: each keeps its own header, because
// what a header claims differs (who wrote a Slack message, versus who a session was serving when it wrote).

// Invisible and direction-changing characters that let a message look like something it is not
// (C0 and C1 controls except newline and tab, NEL, zero-width and direction marks, line/paragraph separators, bidi overrides, BOM).
// Also every format character (\p{Cf}) and every default-ignorable code point (soft hyphen, tag characters, Arabic letter mark, word
// joiner, Hangul fillers, Mongolian vowel separator, interlinear annotation marks, variation selectors...), which render as nothing.
// The two variation selectors emoji need (U+FE0E, U+FE0F) stay.
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], [0x0B, 0x1F], [0x7F, 0x9F], [0x200B, 0x200F],
  [0x2028, 0x2029], [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF],
]
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u
const KEEP = new Set([0xFE0E, 0xFE0F])
const hidden = (ch: string): boolean => {
  const c = ch.codePointAt(0)!
  return HIDDEN_RANGES.some(([lo, hi]) => c >= lo && c <= hi) || (!KEEP.has(c) && INVISIBLE.test(ch))
}
export const clean = (s: string): string => Array.from(s).filter(ch => !hidden(ch)).join('')

/** The longest sender text one message carries into a session, in characters. */
export const UNTRUSTED_TEXT_MAX_CHARS = 1500

export const oneLine = (s: string | undefined, max: number): string => s ? clean(s).replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** An attribute value: one clean line, quoted, so no value can end its attribute or its line. */
// Quotes, backslashes, `=` and brackets go: a sender's own display name cannot spell out another attribute.
export const attr = (s: string): string => `"${oneLine(s, 120).replace(/["\\=[\]]/g, '')}"`

/** The default note on a cut body (a Slack message can be read in full in its thread). */
export const readTheThread = (cut: number): string => ` […truncated ${cut} chars; read the thread]`

/**
 * The sender's words as a body: cleaned, cut at `max` characters with `note` after the cut, and every line quoted with `| `, so
 * no line of it can begin a header, an item or a marker.
 */
export function quoteBody(text: string, max: number = UNTRUSTED_TEXT_MAX_CHARS, note: (cut: number) => string = readTheThread): string {
  const chars = Array.from(clean(text))
  const body = chars.length > max ? `${chars.slice(0, max).join('')}${note(chars.length - max)}` : chars.join('')
  return body.split('\n').map(l => `| ${l}`).join('\n')
}

/**
 * The untrusted envelope both deliveries wear: an opening marker with a one-off nonce and the attributes hydra fills in, the
 * inner lines, and the closing marker. `marker` is the family (`SLACK-UNTRUSTED`, `SESSION-UNTRUSTED`).
 */
export const fence = (marker: string, nonce: string, attrs: readonly string[], inner: readonly string[]): string =>
  [`<<<${marker}-${nonce} ${attrs.join(' ')}`, ...inner, `${marker}-${nonce}>>>`].join('\n')

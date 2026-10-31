// Session names and their emoji. Pure data: scripts may import this without loading the session registry.

export const SESSION_CATALOG: Array<{ name: string; emoji: string }> = [
  { name: 'spark', emoji: '⚡' },
  { name: 'pixel', emoji: '🟦' },
  { name: 'nova',  emoji: '💥' },
  { name: 'drift', emoji: '🌊' },
  { name: 'flint', emoji: '🪨' },
  { name: 'ember', emoji: '🔥' },
  { name: 'bloom', emoji: '🌸' },
  { name: 'atlas', emoji: '🗺️' },
  { name: 'qubit', emoji: '⚛️' },
  { name: 'prism', emoji: '🌈' },
  { name: 'orbit', emoji: '🪐' },
  { name: 'comet', emoji: '☄️' },
  { name: 'patch', emoji: '🩹' },
  { name: 'glyph', emoji: '🔣' },
  { name: 'pulse', emoji: '💓' },
  { name: 'scout', emoji: '🔭' },
  { name: 'cedar', emoji: '🪵' },
  { name: 'dusk',  emoji: '🌇' },
  { name: 'fern',  emoji: '🌿' },
  { name: 'haze',  emoji: '🌫️' },
  { name: 'jade',  emoji: '🐉' },
  { name: 'lark',  emoji: '🪶' },
  { name: 'moss',  emoji: '🪴' },
  { name: 'pine',  emoji: '🌲' },
  { name: 'reef',  emoji: '🪸' },
  { name: 'sage',  emoji: '🦉' },
  { name: 'tide',  emoji: '🌙' },
  { name: 'vale',  emoji: '🏞️' },
  { name: 'wren',  emoji: '🐦' },
  { name: 'zinc',  emoji: '🔧' },
  { name: 'bolt',  emoji: '🔩' },
  { name: 'crisp', emoji: '❄️' },
]

export const SESSION_NAMES = SESSION_CATALOG.map(s => s.name)

export function sessionEmoji(name: string): string {
  return SESSION_CATALOG.find(s => s.name === name)?.emoji ?? '🔹'
}

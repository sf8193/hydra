// Markdown tables in outbound text, and the two ways a gateway can show one where the chat renders none: a picture
// (an SVG laid out here, rasterized by macOS's sips) or an aligned monospace block. Platform-free: a gateway decides.
// Only a header row followed by a delimiter row of the same width is a table, as GitHub reads one.
import { execFile } from 'child_process'
import { writeFileSync } from 'fs'
import { promisify } from 'util'

/** Which lines are code: a fence marker, or inside a fence. A fence closes on its own character, at least as long. */
export function codeLines(lines: readonly string[]): boolean[] {
  let fence = ''
  return lines.map(l => {
    const m = /^\s*(`{3,}|~{3,})/.exec(l)?.[1]
    if (!m) return fence !== ''
    if (!fence) fence = m
    else if (m[0] === fence[0] && m.length >= fence.length) fence = ''
    return true
  })
}

export type Align = 'left' | 'center' | 'right'
/** A table spans lines [start, end) of the text it was found in. Cells are as written, inline markdown and all. */
export type Table = { start: number; end: number; header: string[]; align: Align[]; rows: string[][] }

const DELIMITER = /^\s*:?-+:?\s*$/

/** A row's cells: outer pipes optional, `\|` a literal pipe. */
function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return t.split(/(?<!\\)\|/).map(c => c.trim().replaceAll('\\|', '|'))
}

export function findTables(lines: readonly string[]): Table[] {
  const code = codeLines(lines)
  const row = (i: number) => i < lines.length && !code[i] && lines[i].includes('|')
  const tables: Table[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!row(i) || !row(i + 1)) continue
    const header = cells(lines[i])
    const delimiter = cells(lines[i + 1])
    if (delimiter.length !== header.length || !delimiter.every(d => DELIMITER.test(d))) continue
    const align = delimiter.map((d): Align => d.endsWith(':') ? (d.startsWith(':') ? 'center' : 'right') : 'left')
    let end = i + 2
    while (row(end)) end++
    const rows = lines.slice(i + 2, end).map(l => header.map((_, c) => cells(l)[c] ?? ''))
    tables.push({ start: i, end, header, align, rows })
    i = end - 1
  }
  return tables
}

/** The links a table's cells hold, once each, as markdown that keeps them clickable outside the picture. Code is not a link. */
export function tableLinks(t: Table): string[] {
  const out = new Set<string>()
  for (const cell of [...t.header, ...t.rows.flat()]) {
    // Code spans blanked to spaces of their length: never a link, and a match's offsets still read the cell itself.
    const prose = cell.replace(/`[^`]*`/g, c => ' '.repeat(c.length))
    for (const m of prose.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)|<?(https?:\/\/(?:[^\s<>|`()]|\([^\s<>|`()]*\))+)>?/g)) {
      out.add(m[3] ? `<${m[3]}>` : cell.slice(m.index, m.index + m[0].length))
    }
  }
  return [...out]
}


// ---------------------------------------------------------------------------
// The monospace block: the table as text, for where no picture can go
// ---------------------------------------------------------------------------

/** Terminal columns a string takes: emoji and East Asian wide characters count two. */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (
      (cp >= 0x1F000 && cp <= 0x1FAFF) || // emoji block
      (cp >= 0x2600 && cp <= 0x27BF) ||    // misc symbols, dingbats
      (cp >= 0xFE00 && cp <= 0xFE0F) ||    // variation selectors (zero-width but often paired)
      (cp >= 0x200D && cp <= 0x200D)       // ZWJ
    ) {
      w += 2
    } else if (
      (cp >= 0x1100 && cp <= 0x115F) ||    // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0x303E) ||    // CJK radicals, ideographic
      (cp >= 0x3040 && cp <= 0x33BF) ||    // Hiragana, Katakana, CJK
      (cp >= 0x3400 && cp <= 0x4DBF) ||    // CJK Unified Ext A
      (cp >= 0x4E00 && cp <= 0x9FFF) ||    // CJK Unified
      (cp >= 0xF900 && cp <= 0xFAFF) ||    // CJK Compatibility
      (cp >= 0xFF01 && cp <= 0xFF60) ||    // Fullwidth forms
      (cp >= 0x20000 && cp <= 0x2FA1F)     // CJK Unified Ext B+
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

/** The table as an aligned code block, cells as written. */
export function tableCodeBlock(t: Table): string {
  const all = [t.header, ...t.rows]
  const widths = t.header.map((_, i) => Math.max(...all.map(r => displayWidth(r[i] ?? ''))))
  const pad = (s: string, w: number, a: Align) => {
    const gap = w - displayWidth(s)
    if (gap <= 0) return s
    if (a === 'right') return ' '.repeat(gap) + s
    if (a === 'center') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l) }
    return s + ' '.repeat(gap)
  }
  const fmt = (row: string[]) => row.map((c, i) => pad(c, widths[i], t.align[i] ?? 'left')).join('  ').trimEnd()
  const sep = widths.map(w => '─'.repeat(w)).join('──')
  return ['```', fmt(t.header), sep, ...t.rows.map(fmt), '```'].join('\n')
}

// ---------------------------------------------------------------------------
// The picture: light, Helvetica, laid out at 1× and sized 2× so the raster is crisp
// ---------------------------------------------------------------------------

/** A cell as it reads: a link by its text, emphasis and code marks dropped. */
const plain = (cell: string) =>
  cell.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1').replace(/<(https?:\/\/[^\s>]+)>/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2').replace(/(^|[^\w*])[*_]([^*_]+)[*_](?![\w*])/g, '$1$2').replace(/<br\s*\/?>/gi, ' ')

// Helvetica and Helvetica-Bold advance widths for ASCII 32..126, per 1000 units of size (the standard AFM metrics).
const REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]

const SIZE = 15, LINE = 22, PAD_X = 12, PAD_Y = 8, MARGIN = 16
// A phone shows the picture at its own width: past about 520 px a table's text shrinks below what reads comfortably.
const BUDGET = 520, MIN_COL = 64, MAX_WORD = 160

/** Units per 1000 of size for one code point outside ASCII, erring wide so text never overruns its cell. */
function units(c: number): number {
  if ((c >= 0x300 && c < 0x370) || c === 0x200d || (c >= 0xfe00 && c < 0xfe10)) return 0 // combining marks, joiners, variation selectors
  if (c >= 0x1f000 || (c >= 0x2600 && c < 0x2800) || (c >= 0x2b00 && c < 0x2c00)) return 1300 // emoji, drawn larger than the text
  if (c >= 0x2e80) return 1000 // CJK and other wide scripts
  return 600
}

/** Width in px. */
function width(s: string, bold: boolean): number {
  const table = bold ? BOLD : REGULAR
  let sum = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    sum += c >= 32 && c < 127 ? table[c - 32] : units(c)
  }
  return sum * SIZE / 1000
}

/** Lines of at most `max` px: broken at spaces, a word longer than a line broken where it must. */
function wrap(text: string, max: number, bold: boolean): string[] {
  const out: string[] = []
  let line = ''
  for (let word of text.split(/\s+/).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word
    if (width(joined, bold) <= max) { line = joined; continue }
    if (line) out.push(line)
    while (width(word, bold) > max) {
      let n = 1
      while (width(word.slice(0, n + 1), bold) <= max) n++
      out.push(word.slice(0, n))
      word = word.slice(n)
    }
    line = word
  }
  return line || !out.length ? [...out, line] : out
}

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const INK = '#1f2328', RULE = '#d8dee4', HEAD = '#f6f8fa', BORDER = '#d0d7de'

/** A cell drawn bold: the header, or a cell that is bold as a whole. */
const cellOf = (cell: string, header: boolean) => {
  const whole = /^(\*\*|__)(.+)\1$/.exec(cell.trim())
  return { text: plain(cell), bold: header || !!whole }
}

/**
 * Column widths that fit the budget: the widest columns give up width first, down to their longest word (so a word
 * is not split) and never below MIN_COL. Many columns may still exceed it; then each keeps its floor.
 */
function fit(natural: number[], floors: number[]): number[] {
  const room = BUDGET - 2 * MARGIN - natural.length * 2 * PAD_X
  const total = (cap: number) => natural.reduce((a, w, c) => a + Math.max(floors[c], Math.min(w, cap)), 0)
  if (total(Infinity) <= room) return natural
  let lo = 0, hi = Math.max(...natural)
  for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (total(mid) <= room) lo = mid; else hi = mid }
  return natural.map((w, c) => Math.max(floors[c], Math.min(w, lo)))
}

export function tableSvg(t: Table): string {
  const grid = [t.header, ...t.rows].map((r, i) => r.map(c => cellOf(c, i === 0)))
  const natural = t.header.map((_, c) => Math.max(...grid.map(r => width(r[c].text, r[c].bold))))
  const floors = t.header.map((_, c) => Math.min(natural[c], Math.max(MIN_COL, Math.min(MAX_WORD,
    ...[0].concat(grid.flatMap(r => r[c].text.split(/\s+/).map(w => width(w, r[c].bold))))))))
  const cols = fit(natural, floors)
  const laid = grid.map(r => r.map((cell, c) => wrap(cell.text, cols[c], cell.bold)))
  const heights = laid.map(r => Math.max(...r.map(ls => ls.length)) * LINE + 2 * PAD_Y)
  const tableW = cols.reduce((a, w) => a + w + 2 * PAD_X, 0)
  const tableH = heights.reduce((a, h) => a + h, 0)
  const W = Math.ceil(tableW + 2 * MARGIN), H = Math.ceil(tableH + 2 * MARGIN)

  const parts = [
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<clipPath id="card"><rect x="${MARGIN}" y="${MARGIN}" width="${tableW}" height="${tableH}" rx="6"/></clipPath>`,
    `<rect x="${MARGIN}" y="${MARGIN}" width="${tableW}" height="${heights[0]}" fill="${HEAD}" clip-path="url(#card)"/>`,
  ]
  let x0 = MARGIN
  for (const w of cols.slice(0, -1)) {
    x0 += w + 2 * PAD_X
    parts.push(`<line x1="${x0}" y1="${MARGIN}" x2="${x0}" y2="${MARGIN + tableH}" stroke="${RULE}"/>`)
  }
  let y = MARGIN
  laid.forEach((r, i) => {
    if (i > 0) parts.push(`<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + tableW}" y2="${y}" stroke="${i === 1 ? BORDER : RULE}"/>`)
    let x = MARGIN
    r.forEach((ls, c) => {
      const align = t.align[c]
      const [anchor, tx] = align === 'right' ? ['end', x + PAD_X + cols[c]] : align === 'center' ? ['middle', x + PAD_X + cols[c] / 2] : ['start', x + PAD_X]
      ls.forEach((l, k) => {
        if (l) parts.push(`<text x="${tx}" y="${y + PAD_Y + k * LINE + 16}" text-anchor="${anchor}"${grid[i][c].bold ? ' font-weight="700"' : ''}>${escape(l)}</text>`)
      })
      x += cols[c] + 2 * PAD_X
    })
    y += heights[i]
  })
  parts.push(`<rect x="${MARGIN + 0.5}" y="${MARGIN + 0.5}" width="${tableW - 1}" height="${tableH - 1}" rx="6" fill="none" stroke="${BORDER}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}" font-family="Helvetica" font-size="${SIZE}" fill="${INK}">${parts.join('')}</svg>`
}

const run = promisify(execFile)
export const SIPS = '/usr/bin/sips' // ships with macOS; rasterizes SVG through CoreSVG

/** Draws the table as a PNG at `png` (its SVG beside it), or rejects saying why: sips missing, failed or past 10 s. */
export async function drawTablePng(t: Table, png: string): Promise<void> {
  const svg = png.replace(/\.png$/, '.svg')
  writeFileSync(svg, tableSvg(t))
  try {
    await run(SIPS, ['-s', 'format', 'png', svg, '--out', png], { timeout: 10_000 })
  } catch (err) {
    const e = err as { code?: unknown; stderr?: string; killed?: boolean; message?: string }
    const why = e.code === 'ENOENT' ? `${SIPS} is missing (not macOS)` : e.killed ? 'sips ran past 10 s' : `sips exited ${e.code}: ${(e.stderr ?? e.message ?? '').trim().split('\n')[0]}`
    throw new Error(why)
  }
}

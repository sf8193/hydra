/**
 * Markdown pipe-table → code-block conversion for Discord.
 *
 * Discord has no native table rendering. This module detects markdown tables
 * in outbound text and converts them to aligned monospace code blocks that
 * render cleanly on both desktop and mobile.
 */

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

const TABLE_ROW_RE = /^[ \t]*\|.+\|[ \t]*$/
const SEPARATOR_RE = /^[ \t]*\|[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|[ \t]*$/

type Align = 'left' | 'center' | 'right'

interface ParsedTable {
  headers: string[]
  alignments: Align[]
  rows: string[][]
  startLine: number
  endLine: number
}

function parseRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
}

function parseAlignments(line: string): Align[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => {
    const t = cell.trim()
    if (t.startsWith(':') && t.endsWith(':')) return 'center'
    if (t.endsWith(':')) return 'right'
    return 'left'
  })
}

export function extractTables(text: string): { tables: ParsedTable[]; cleanedText: string } {
  const lines = text.split('\n')
  const tables: ParsedTable[] = []
  let inCodeBlock = false
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock
      i++
      continue
    }
    if (inCodeBlock) { i++; continue }

    if (TABLE_ROW_RE.test(lines[i]) && i + 1 < lines.length && SEPARATOR_RE.test(lines[i + 1])) {
      const headers = parseRow(lines[i])
      const alignments = parseAlignments(lines[i + 1])
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && TABLE_ROW_RE.test(lines[j])) {
        rows.push(parseRow(lines[j]))
        j++
      }
      if (rows.length > 0) {
        tables.push({ headers, alignments, rows, startLine: i, endLine: j - 1 })
      }
      i = j
    } else {
      i++
    }
  }

  if (tables.length === 0) return { tables: [], cleanedText: text }

  const cleaned: string[] = []
  let lastEnd = -1
  for (const t of tables) {
    for (let k = lastEnd + 1; k < t.startLine; k++) cleaned.push(lines[k])
    lastEnd = t.endLine
  }
  for (let k = lastEnd + 1; k < lines.length; k++) cleaned.push(lines[k])

  return { tables, cleanedText: cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

// ---------------------------------------------------------------------------
// Display width — accounts for emoji and East Asian Wide characters
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Code-block formatting
// ---------------------------------------------------------------------------

function tableToCodeBlock(table: ParsedTable): string {
  const all = [table.headers, ...table.rows]
  const widths = table.headers.map((_, i) =>
    Math.max(...all.map(r => displayWidth(r[i] ?? '')))
  )

  const pad = (s: string, w: number, a: Align) => {
    const gap = w - displayWidth(s)
    if (gap <= 0) return s
    if (a === 'right') return ' '.repeat(gap) + s
    if (a === 'center') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l) }
    return s + ' '.repeat(gap)
  }

  const fmt = (row: string[]) => row.map((c, i) => pad(c, widths[i], table.alignments[i] ?? 'left')).join('  ')
  const sep = widths.map(w => '─'.repeat(w)).join('──')

  return '```\n' + fmt(table.headers) + '\n' + sep + '\n' + table.rows.map(fmt).join('\n') + '\n```'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function formatDiscordTables(text: string): string {
  const { tables, cleanedText } = extractTables(text)
  if (tables.length === 0) return text

  const codeBlocks = tables.map(tableToCodeBlock)
  return cleanedText
    ? cleanedText + '\n\n' + codeBlocks.join('\n\n')
    : codeBlocks.join('\n\n')
}

// How Discord shows the markdown it does not render itself. It draws no tables, and it collapses the spacing that
// aligns box art. So a table becomes a picture attached to the message, its links left as text where it stood; where no
// picture can go (an edit, no room, a failed drawing) it becomes an aligned code block in its place. A run of box-art
// lines goes in a code fence.
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Outbound } from './gateway.js'
import { codeLines, drawTablePng, findTables, SIPS, tableCodeBlock, tableLinks, type Table } from './tables.js'

const art = (l: string) => /^\s*\+[-=+]+\+\s*$/.test(l) || /^\s*\|.*\|\s*$/.test(l) || /[─-╿▀-▟]/.test(l)

/**
 * Runs of two or more box-art or pipe-grid lines, outside code, go in a code fence. Alignment lives between lines, so a
 * single such line (a tree connector beside a link in a status message) is left as it reads.
 */
export function fenceArt(text: string): string {
  const lines = text.split('\n')
  const code = codeLines(lines)
  const isArt = lines.map((l, i) => !code[i] && art(l))
  const inRun = isArt.map((a, i) => a && (isArt[i - 1] || isArt[i + 1]))
  const out: string[] = []
  lines.forEach((l, i) => {
    if (inRun[i] && !inRun[i - 1]) out.push('```')
    out.push(l)
    if (inRun[i] && !inRun[i + 1]) out.push('```')
  })
  return out.join('\n')
}

/** Text only: each table as a code block in its place, box art fenced. What an edit, which cannot add files, shows. */
export function formatDiscordText(text: string): string {
  const lines = text.split('\n')
  for (const t of findTables(lines).reverse()) lines.splice(t.start, t.end - t.start, tableCodeBlock(t))
  return fenceArt(lines.join('\n'))
}

let sipsMissingSaid = false

/** What draws a table: macOS's sips, unless a test hands in its own. */
export type Renderer = { available: () => boolean; draw: (t: Table, png: string) => Promise<void> }
const SIPS_RENDERER: Renderer = { available: () => existsSync(SIPS), draw: drawTablePng }

// Drawing stops here, well inside the bridge's 60 s wait for a reply: later tables become code blocks.
const DRAW_BUDGET_MS = 30_000

/**
 * The Discord gateway's shapeOutbound (gateway.ts). Draws up to `maxFiles` tables as PNGs in a folder of its own, calls
 * `post` with the text and those files, and removes the folder once `post` settles, so the caller's retries still find
 * them. A table that is not drawn becomes a code block in its place, with a stderr line saying why.
 */
export async function shapeDiscordOutbound<R>(
  text: string, maxFiles: number, post: (out: Outbound) => Promise<R>, renderer: Renderer = SIPS_RENDERER,
): Promise<R> {
  const lines = text.split('\n')
  const tables = findTables(lines)
  if (!tables.length || maxFiles <= 0) return post({ text: formatDiscordText(text), files: [] })
  if (!renderer.available()) {
    if (!sipsMissingSaid) process.stderr.write(`discord: tables sent as code blocks: ${SIPS} is missing (not macOS)\n`)
    sipsMissingSaid = true
    return post({ text: formatDiscordText(text), files: [] })
  }

  const dir = mkdtempSync(join(tmpdir(), 'hydra-tables-'))
  const deadline = Date.now() + DRAW_BUDGET_MS
  try {
    const files: string[] = []
    const shown: string[][] = []
    for (const [i, t] of tables.entries()) {
      const png = join(dir, `table-${i + 1}.png`)
      const why = files.length >= maxFiles ? undefined : Date.now() > deadline ? 'drawing ran past its 30 s budget' : await renderer.draw(t, png).then(
        () => { files.push(png); shown.push(tableLinks(t)); return null },
        (err: unknown) => (err instanceof Error && err.message) || String(err),
      )
      if (why === null) continue
      if (why) process.stderr.write(`discord: table ${i + 1} sent as a code block: ${why}\n`)
      shown.push([tableCodeBlock(t)])
    }
    // Back to front, so each splice leaves the earlier tables' line numbers as found.
    for (let i = tables.length - 1; i >= 0; i--) lines.splice(tables[i].start, tables[i].end - tables[i].start, ...shown[i])
    return await post({ text: fenceArt(lines.join('\n')), files })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

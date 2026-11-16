import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { drawTablePng, findTables, SIPS, tableCodeBlock, tableLinks, tableSvg } from '../tables.js'

const lines = (t: string) => t.split('\n')
const viewWidth = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)![1])

describe('findTables', () => {
  test('a GFM table: header, delimiter and body rows, with alignment and escaped pipes', () => {
    const [t] = findTables(lines('intro\n| Name | Count |\n|:--|--:|\n| a \\| b | 3 |\n| c | 10 |\noutro'))
    expect(t).toEqual({ start: 1, end: 5, header: ['Name', 'Count'], align: ['left', 'right'], rows: [['a | b', '3'], ['c', '10']] })
  })

  test('rows without a delimiter row, a delimiter of another width, and tables inside code are not tables', () => {
    expect(findTables(lines('| a | b |\n| 1 | 2 |'))).toEqual([])
    expect(findTables(lines('| a | b |\n|---|\n| 1 | 2 |'))).toEqual([])
    expect(findTables(lines('```\n| a | b |\n|---|---|\n```'))).toEqual([])
    expect(findTables(lines('~~~\n| a | b |\n|---|---|\n~~~'))).toEqual([])
  })

  test('a table ends at the first line without a pipe; outer pipes are optional', () => {
    const ts = findTables(lines('a | b\n--- | ---\n1 | 2\n\n| x |\n|---|\n| y |'))
    expect(ts.map(t => [t.start, t.end, t.rows])).toEqual([[0, 3, [['1', '2']]], [4, 7, [['y']]]])
  })

  test('short rows are padded and long ones cut to the header', () => {
    const [t] = findTables(lines('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |'))
    expect(t.rows).toEqual([['1', ''], ['1', '2']])
  })
})

describe('tableLinks', () => {
  test('once each, bare URLs kept whole, code spans are not links', () => {
    const [t] = findTables(lines('| a | b |\n|---|---|\n| [x](https://e.com/1) | https://e.com/2 |\n| [x](https://e.com/1) | `https://e.com/code` |'))
    expect(tableLinks(t)).toEqual(['[x](https://e.com/1)', '<https://e.com/2>'])
  })

  test('code in a link keeps its text; a URL with parentheses stays whole', () => {
    const [t] = findTables(lines('| a | b |\n|---|---|\n| [a `b`](https://e.com/c) | https://en.wikipedia.org/wiki/Foo_(bar) |'))
    expect(tableLinks(t)).toEqual(['[a `b`](https://e.com/c)', '<https://en.wikipedia.org/wiki/Foo_(bar)>'])
  })
})

describe('tableCodeBlock', () => {
  test('aligns columns, right-aligned where the delimiter says, wide characters counted twice', () => {
    const [t] = findTables(lines('| Name | n |\n|---|--:|\n| 日本 | 3 |\n| ab | 10 |'))
    expect(tableCodeBlock(t)).toBe('```\nName   n\n────────\n日本   3\nab    10\n```')
  })
})

describe('tableSvg', () => {
  test('2× its layout, escaped, links drawn as their text, the header and whole-bold cells at weight 700', () => {
    const [t] = findTables(lines('| <b> & co | Link |\n|---|---|\n| **y** | [PR #1](https://example.com/1) |'))
    const svg = tableSvg(t)
    const [, w, h, vw, vh] = /width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(svg)!.map(Number)
    expect([w, h]).toEqual([vw * 2, vh * 2])
    expect(svg).toContain('&lt;b&gt; &amp; co')
    expect(svg).toContain('>PR #1<')
    expect(svg).not.toContain('https://')
    // CoreSVG draws weight "bold" regular; 700 is what it honours.
    expect(svg).toMatch(/font-weight="700"[^>]*>&lt;b&gt;/)
    expect(svg).toMatch(/font-weight="700"[^>]*>y</)
  })

  test('a long cell wraps to keep the picture phone-legible; a column rule between columns', () => {
    const long = Array(40).fill('lorem').join(' ')
    const svg = tableSvg(findTables(lines(`| Status | Description |\n|---|---|\n| merged | ${long} |`))[0])
    expect(viewWidth(svg)).toBeLessThanOrEqual(520)
    expect(svg).toContain('>merged<')
    expect(svg.match(/<line x1="[\d.]+" y1="16"/g)).toHaveLength(1)
  })

  test('emoji are measured wider than letters, so a cell holding them is not overrun', () => {
    const vw = (cell: string) => viewWidth(tableSvg(findTables(lines(`| ${cell} |\n|---|`))[0]))
    expect(vw('❌❌❌')).toBeGreaterThan(vw('WWW'))
  })
})

describe.skipIf(!existsSync(SIPS))('drawTablePng (macOS)', () => {
  test('sips draws a real PNG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tables-test-'))
    try {
      await drawTablePng(findTables(lines('| a | b |\n|---|---|\n| 1 | 2 |'))[0], join(dir, 't.png'))
      expect(readFileSync(join(dir, 't.png')).subarray(1, 4).toString()).toBe('PNG')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

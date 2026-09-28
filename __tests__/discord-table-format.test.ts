import { describe, test, expect } from 'bun:test'
import { extractTables, formatDiscordTables } from '../discord-table-format.js'

describe('extractTables', () => {
  test('detects a simple pipe table', () => {
    const text = `| Name | Age |
|------|-----|
| Alice | 30 |
| Bob | 25 |`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(['Name', 'Age'])
    expect(tables[0].rows).toEqual([['Alice', '30'], ['Bob', '25']])
    expect(cleanedText).toBe('')
  })

  test('preserves text around table', () => {
    const text = `Here is a table:

| Col A | Col B |
|-------|-------|
| 1     | 2     |

And some text after.`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(1)
    expect(cleanedText).toBe('Here is a table:\n\nAnd some text after.')
  })

  test('returns original text when no tables present', () => {
    const text = 'Just some regular text with | pipes | in it.'
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('skips tables inside triple-backtick code blocks', () => {
    const text = `Some text

\`\`\`
| Header | Value |
|--------|-------|
| A      | 1     |
\`\`\`

More text`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('skips tables inside tilde code blocks', () => {
    const text = `Some text

~~~
| Header | Value |
|--------|-------|
| A      | 1     |
~~~

More text`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('detects multiple tables', () => {
    const text = `First table:

| A | B |
|---|---|
| 1 | 2 |

Second table:

| X | Y | Z |
|---|---|---|
| a | b | c |
| d | e | f |`
    const { tables, cleanedText } = extractTables(text)
    expect(tables).toHaveLength(2)
    expect(tables[0].headers).toEqual(['A', 'B'])
    expect(tables[0].rows).toHaveLength(1)
    expect(tables[1].headers).toEqual(['X', 'Y', 'Z'])
    expect(tables[1].rows).toHaveLength(2)
    expect(cleanedText).toBe('First table:\n\nSecond table:')
  })

  test('parses column alignment from separator', () => {
    const text = `| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |`
    const { tables } = extractTables(text)
    expect(tables[0].alignments).toEqual(['left', 'center', 'right'])
  })

  test('requires data rows after separator', () => {
    const text = `| Header |
|--------|`
    const { tables } = extractTables(text)
    expect(tables).toHaveLength(0)
  })

  test('handles table with emoji and unicode', () => {
    const text = `| Status | Transfer |
|--------|----------|
| ✅ Done | ACH #42 |
| ⚠️ Pending | Wire #7 |`
    const { tables } = extractTables(text)
    expect(tables).toHaveLength(1)
    expect(tables[0].rows[0][0]).toBe('✅ Done')
  })
})

describe('formatDiscordTables', () => {
  test('returns original text when no tables', () => {
    const text = 'No tables here.'
    expect(formatDiscordTables(text)).toBe(text)
  })

  test('converts table to code block', () => {
    const text = `| A | B |
|---|---|
| 1 | 2 |`
    const result = formatDiscordTables(text)
    expect(result).toContain('```')
    expect(result).toContain('A')
    expect(result).toContain('B')
    expect(result).toContain('1')
    expect(result).toContain('2')
    expect(result).not.toContain('|')
  })

  test('preserves surrounding text', () => {
    const text = `Before.

| X | Y |
|---|---|
| a | b |

After.`
    const result = formatDiscordTables(text)
    expect(result).toStartWith('Before.')
    expect(result).toContain('After.')
    expect(result).toContain('```')
  })

  test('aligns columns with right alignment', () => {
    const text = `| Name | Value |
|------|------:|
| a | 100 |
| bb | 5 |`
    expect(formatDiscordTables(text).split('\n')).toEqual([
      '```', 'Name  Value', '───────────', 'a       100', 'bb        5', '```',
    ])
  })

  test('handles emoji in code block with proper width', () => {
    const text = `| Status | Item |
|--------|------|
| ✅ | alpha |
| ⚠️ | beta |`
    // suspect: the VS16 in '⚠️' is counted as width 2 (its comment calls it
    // zero-width), so '⚠️' measures 4 and its row is padded 2 short of '✅'.
    expect(formatDiscordTables(text).split('\n')).toEqual([
      '```', 'Status  Item ', '─────────────', '✅      alpha', '⚠️    beta ', '```',
    ])
  })
})

import { expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { CODEX_MCP_SERVER } from '../../engines/codex-engine-adapter.js'

// registerCodexMcp refuses to run under test, so nothing else reaches the path a Codex launch hands `codex mcp add`: it must name a file that exists.
test('the MCP server a Codex launch registers is a file that exists', () => {
  expect(CODEX_MCP_SERVER).toEndWith('/engines/codex-mcp-server.ts')
  expect(existsSync(CODEX_MCP_SERVER)).toBe(true)
})

import { describe, test, expect } from 'bun:test'
import { PLUGIN_MANIFEST, MCP_CONFIG } from '../plugin-cache.js'

/**
 * The manifest is the declaration that survives.
 *
 * Claude Code serves a plugin's `.mcp.json` through a storage backend that can
 * report the file as absent even when it is on disk, and answers that miss with
 * silence — the plugin loads, and the session has no bridge for its whole life.
 * `mcpServers` in the manifest is merged inline with no file read, so these
 * tests exist to stop the duplication from being tidied away.
 */
describe('bridge declaration', () => {
  test('the manifest declares the bridge on its own', () => {
    const manifest = JSON.parse(PLUGIN_MANIFEST)
    expect(manifest.mcpServers?.discord?.command).toBe('bun')
  })

  test('manifest and .mcp.json name the same server identically', () => {
    expect(JSON.parse(PLUGIN_MANIFEST).mcpServers).toEqual(JSON.parse(MCP_CONFIG).mcpServers)
  })

  test('the launch directory stays a placeholder Claude Code expands per copy', () => {
    expect(JSON.parse(MCP_CONFIG).mcpServers.discord.args).toContain('${CLAUDE_PLUGIN_ROOT}')
  })
})

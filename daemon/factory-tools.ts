// Factory tool declarations — single source of truth for factory-specific tools.
//
// This is a leaf module with no daemon-internal imports, so both the tool
// catalog (bridge-tools.ts, which must stay dependency-isolated to keep the
// session-lifecycle ↔ bridge-dispatch cycle broken) and the factory engine
// (factory.ts) can import from it. Adding a new factory tool means editing
// this file only.

export const FACTORY_TOOLS = Object.freeze([
  { name: 'factory_done', description: 'Signal that your factory build is complete. Triggers mandatory adversarial review — you will defend your implementation as the review owner. Call this instead of posting [done] as text.', inputSchema: { type: 'object', properties: { files_changed: { type: 'array', items: { type: 'string' }, description: 'List of files created or modified.' }, test_results: { type: 'string', description: 'Test output summary (e.g. "1388 pass, 0 fail").' }, rationale: { type: 'string', description: 'Key design decisions and why.' }, known_issues: { type: 'string', description: 'Anything you are unsure about or that needs attention.' }, branch: { type: 'string', description: 'Branch name (for worktree builds).' } }, required: ['files_changed', 'test_results'] } },
].map(t => Object.freeze(t)))

export const FACTORY_TOOL_NAMES = new Set(FACTORY_TOOLS.map(t => t.name))

// Terser description injected for active builders via scoped tool overrides.
// Builders already get the full task framing in their builder prompt, so the
// live tool description stays short.
export const FACTORY_DONE_SCOPED_DESCRIPTION = 'Signal that your factory build is complete. Triggers mandatory adversarial review.'

// The scoped-override record injected for active builders. Both override sites
// in factory.ts (spawn-time in spawnBuilder + runtime in resolveScopedToolOverrides)
// reference this one object, so adding a second overridden factory tool is an
// edit here, not in two call sites.
export const FACTORY_SCOPED_OVERRIDES: Record<string, string> = {
  factory_done: FACTORY_DONE_SCOPED_DESCRIPTION,
}

// A LoadEnv for tests: every probe is explicit, and the defaults find nothing wrong (no folder is private, a git work tree,
// or holds a symlink out). A test that checks a refusal overrides the one probe that makes it; none relies on a missing probe.
import { placeKey, placesAnsweredBy, type HydraConfig, type LoadEnv, type Rule } from '../types.js'

/** The places a specialist answers, as hydra.toml writes them. */
export const answeredKeys = (cfg: Pick<HydraConfig, 'rules'>, id: string): string[] => placesAnsweredBy(cfg, id).map(placeKey)
/** Rules with their place written as hydra.toml writes it, so a test can compare them to a literal. */
export const ruleKeys = (rules: Rule[]) => rules.map(r => r.place ? { ...r, place: placeKey(r.place) } : r)

export function testLoadEnv(over: Partial<LoadEnv> = {}): LoadEnv {
  return {
    home: '/home/op',
    sessionNames: [],
    platform: 'discord',
    macosVersion: undefined,
    stateDir: '/nonexistent/state',
    claudeConfigDir: '/nonexistent/claude',
    isDir: () => true,
    isCommand: () => true,
    realpath: p => p,
    exists: () => false,
    mcpNamesIn: () => [],
    envFileHas: () => true,
    isGitWorkTree: () => false,
    scanWorkdir: () => ({ escapingSymlinks: [], nestedGit: [], truncated: false }),
    ...over,
  }
}

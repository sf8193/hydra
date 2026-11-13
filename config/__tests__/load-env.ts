// A LoadEnv for tests: every probe is explicit, and the defaults find nothing wrong (no folder is private, a git work tree,
// or holds a symlink out). A test that checks a refusal overrides the one probe that makes it; none relies on a missing probe.
import type { LoadEnv } from '../types.js'

export function testLoadEnv(over: Partial<LoadEnv> = {}): LoadEnv {
  return {
    home: '/home/op',
    sessionNames: [],
    stateDir: '/nonexistent/state',
    claudeConfigDir: '/nonexistent/claude',
    isDir: () => true,
    isCommand: () => true,
    realpath: p => p,
    exists: () => false,
    envFileHas: () => true,
    isGitWorkTree: () => false,
    scanWorkdir: () => ({ escapingSymlinks: [], nestedGit: [], truncated: false }),
    ...over,
  }
}

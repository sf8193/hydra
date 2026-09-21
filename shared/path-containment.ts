import { realpathSync } from 'fs'
import { resolve, sep } from 'path'

// Four copies of this predicate had already diverged — one spelled the
// separator '/', one realpathed and three did not. Imports nothing but node
// builtins, because test-setup.ts is a bun preload and must not pull the daemon.
export function isUnder(candidate: string, root: string, opts?: { realpath?: boolean }): boolean {
  const real = (p: string): string => {
    if (!opts?.realpath) return p
    try { return realpathSync(p) } catch { return p }
  }
  const base = real(resolve(root))
  const path = real(resolve(candidate))
  // '/' is a legitimate root, and '//' is a prefix of nothing.
  const prefix = base.endsWith(sep) ? base : base + sep
  return path === base || path.startsWith(prefix)
}

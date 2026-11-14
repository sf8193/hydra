// The machine's own load probes, except that sandbox-exec is found (as on a Mac): a suite on a Linux CI machine launches scoped
// servers as one on a Mac does. The test sets it through `_setLoadEnvForTesting` (hydra-config.ts), the seam startHydraConfig's
// `env` option already is; nothing in production is patched.
import { systemEnv } from '../../config/load.js'
import { SANDBOX_EXEC } from '../../config/server-sandbox.js'
import { offLimitRoots } from '../../config/workdir-scope.js'
import type { LoadEnv } from '../../config/types.js'
import { CLAUDE_CONFIG, STATE_DIR } from '../config.js'
import { SESSION_NAMES } from '../sessions.js'
import type { ScopedConfigInput } from '../engines/claude-engine.js'

export const macLike = (over: Partial<LoadEnv> = {}): LoadEnv => {
  const real = systemEnv(SESSION_NAMES, STATE_DIR, CLAUDE_CONFIG)
  return { ...real, isCommand: c => c === SANDBOX_EXEC || real.isCommand(c), ...over }
}

/** A machine without sandbox-exec. */
export const withoutSandbox = (): LoadEnv => macLike({ isCommand: c => c !== SANDBOX_EXEC && macLike().isCommand(c) })

/** A scopedConfig input with the sandbox's three injected parts filled from a LoadEnv; a test overrides what it checks. */
export const configInput = (over: Partial<ScopedConfigInput> & Pick<ScopedConfigInput, 'scope'>, env: LoadEnv = macLike(), operatorRoots: string[] = []): ScopedConfigInput => ({
  env: {}, held: {}, sessionName: 's', load: env, roots: offLimitRoots(env, operatorRoots), tmpRoot: '/srv/tmp', tmp: t => `/srv/tmp/${t}`, ...over,
})

export const rootsOf = (env: LoadEnv = macLike(), operatorRoots: string[] = []) => offLimitRoots(env, operatorRoots)

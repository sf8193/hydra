// The machine's own load probes, except that sandbox-exec is found (as on a Mac): a suite on a Linux CI machine launches restricted
// servers as one on a Mac does, on a macOS version the sandbox is proven on (a test of the gate passes another). The test sets it through `_setLoadEnvForTesting` (hydra-config.ts), the seam startHydraConfig's
// `env` option already is; nothing in production is patched.
import { systemEnv } from '../../infra/load-env.js'
import { PROVEN_MACOS_MAJORS, SANDBOX_EXEC } from '../../config/server-sandbox.js'
import { offLimitRoots } from '../../config/restricted-workdir.js'
import type { LoadEnv } from '../../config/types.js'
import { CLAUDE_CONFIG, STATE_DIR, PLATFORM } from '../../infra/config.js'
import { SESSION_NAMES } from '../../sessions/registry.js'
import type { RestrictedConfigInput } from '../../engines/claude-engine.js'

export const macLike = (over: Partial<LoadEnv> = {}): LoadEnv => {
  const real = systemEnv(SESSION_NAMES, STATE_DIR, PLATFORM, CLAUDE_CONFIG)
  return { ...real, macosVersion: `${PROVEN_MACOS_MAJORS[0]}.0`, isCommand: c => c === SANDBOX_EXEC || real.isCommand(c), ...over }
}

/** A machine without sandbox-exec. */
export const withoutSandbox = (): LoadEnv => macLike({ isCommand: c => c !== SANDBOX_EXEC && macLike().isCommand(c) })

/** A restrictedConfig input with the sandbox's three injected parts filled from a LoadEnv; a test overrides what it checks. */
export const configInput = (over: Partial<RestrictedConfigInput> & Pick<RestrictedConfigInput, 'policy'>, env: LoadEnv = macLike(), operatorRoots: string[] = []): RestrictedConfigInput => ({
  env: {}, held: {}, sessionName: 's', load: env, roots: offLimitRoots(env, operatorRoots), tmpRoot: '/srv/tmp', tmp: t => `/srv/tmp/${t}`, builtins: [], ...over,
})

export const rootsOf = (env: LoadEnv = macLike(), operatorRoots: string[] = []) => offLimitRoots(env, operatorRoots)

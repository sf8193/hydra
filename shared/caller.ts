// Who is calling the daemon from a shell: what the CLI says of its caller on every request (cli/helpers.ts sendRequest), and the daemon
// checks (sessions/cli-caller.ts).
//
// Each session is launched with a token the daemon issued for it (HYDRA_SESSION_TOKEN: Claude and omp read it from a launch file, Codex has
// it in its app-server's environment; never on a command line).
// The daemon keeps only its hash. A caller that presents it is that session. A caller whose environment is a session's but has no token
// (launched before tokens, or the variable was dropped) is a session that cannot show which: never the operator. A caller with no hydra
// session variable at all is the operator's shell.
//
// The bound: a session runs as the same OS user as the operator and every other session. It can read another process's environment
// (`ps -E`), and a caller that clears every hydra variable looks like the operator's shell. Separating them takes a user boundary.

import { SESSION_IDENTITY_VARS } from './spawn-env.js'

export const SESSION_TOKEN_VAR = 'HYDRA_SESSION_TOKEN'

/** What the CLI says of its caller. Absent: the operator's shell. */
export type CallerClaim = { token: string } | { inSession: true }

export function callerClaim(env: NodeJS.ProcessEnv): CallerClaim | undefined {
  const token = env[SESSION_TOKEN_VAR]
  if (token) return { token }
  if (SESSION_IDENTITY_VARS.some(v => env[v])) return { inSession: true }
  return undefined
}

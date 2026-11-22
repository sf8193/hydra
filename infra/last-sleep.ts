// The OS's word on the machine's last sleep, which the resume detector (shared/resume.ts) uses to tell a sleep from a
// held loop.

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LastSleep } from '../shared/resume.js'

const execFileP = promisify(execFile)

/**
 * macOS's last sleep and wake. Async, absolute path, killed outright at its deadline, so a slow machine on wake can
 * delay the name of a resume but never hold the loop. `{ sec = 1794422780, usec = 970655 } Wed Nov 11 …` per line.
 */
export const sysctlLastSleep: LastSleep = async () => {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileP('/usr/sbin/sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' })
    const [slept, woke] = [...stdout.matchAll(/sec = (\d+), usec = (\d+)/g)].map(m => Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000))
    return slept === undefined || woke === undefined ? null : { sleptAt: slept, wokeAt: woke }
  } catch { return null }
}

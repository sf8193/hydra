// What the old runner's launchd entries (bun.cron.hydra-job-<platform>-<name>) run; Bun passes the entry's title as
// --cron-title. Such an entry keeps running its job as a launchd-runner job until `hydra jobs sync` moves it onto a
// plist that names a stable bun.
import { parseLegacyTitle } from '../shared/jobs-launchd.js'
import { resolveConfig } from './helpers.js'
import { jobsLaunchdRun } from './jobs.js'

export default {
  async scheduled() {
    const title = process.execArgv.find(a => a.startsWith('--cron-title='))?.slice('--cron-title='.length) ?? ''
    const t = parseLegacyTitle(title)
    if (!t) { process.stderr.write(`not a hydra job entry: ${title}\n`); return }
    process.exitCode = await jobsLaunchdRun(t.platform, t.name, resolveConfig(t.platform).stateDir)
  },
}

// The script launchd runs for every registered job. Bun passes the job title as the flag --cron-title (in execArgv, not argv).
import { jobsRun, parseTitle } from './jobs.js'

export default {
  async scheduled() {
    const title = process.execArgv.find(a => a.startsWith('--cron-title='))?.slice('--cron-title='.length) ?? ''
    const t = parseTitle(title)
    if (!t) throw new Error(`not a hydra job title: ${title}`)
    if ((await jobsRun(t.platform, t.name)).outcome === 'failed') process.exitCode = 1
  },
}

// What the old launchd entries (bun.cron.hydra-job-*) run. The daemon owns the jobs clock now, so a firing does
// nothing but say how to remove the entry. Removed once no install still has those entries.
export default {
  scheduled() {
    process.stderr.write('hydra jobs moved into the daemon, which removes this launchd entry on its next tick\n')
  },
}

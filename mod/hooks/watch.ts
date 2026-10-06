// PR URLs a `gh pr create` or `gt submit` printed, as the github.com URLs watch_pr takes.
// gh prints github.com/<o>/<r>/pull/<n>; gt prints app.graphite.com/github/pr/<o>/<r>/<n>.
export function submittedPrUrls(command: string, output: string): string[] {
  // Where a command starts, so `grep "gt submit"` printing someone else's PR watches nothing. `gt s`/`gt ss` are submit aliases.
  if (!/(?:^|[;&|(]\s*)(?:gh\s+pr\s+create|gt\s+(?:submit|ss|s))\b/.test(command)) return []
  const urls = new Set<string>()
  for (const m of output.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) urls.add(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`)
  for (const m of output.matchAll(/app\.graphite\.(?:com|dev)\/github\/pr\/([\w.-]+)\/([\w.-]+)\/(\d+)/g)) urls.add(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`)
  return [...urls]
}

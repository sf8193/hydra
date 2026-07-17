import { defineLens } from '../../daemon/protocol-dsl.js'

export default defineLens({
  lens: 'security',
  aliases: ['s'],
  instructions: `
Review for security vulnerabilities. Correctness and readability are settled — focus purely on attack surface.

Check for:
- Injection (SQL, command, template, log)
- Authentication and authorization bypass
- Secrets in code, logs, or error messages
- Unsafe deserialization or eval
- Path traversal and symlink attacks
- Race conditions with security implications
- Missing input validation at system boundaries
- Overly permissive defaults

For each finding: name the vulnerability class, show the specific line, and describe a concrete exploit. No hypotheticals — if you can't construct an attack, it's not a finding.
  `.trim(),
})

import { defineLens } from '../../daemon/protocol-dsl.js'

export default defineLens({
  lens: 'readability',
  aliases: ['r'],
  instructions: `
Review purely for simplicity and readability. Correctness is settled — don't re-litigate it.

The standard: code should be immediately understandable without comments.
If something needs a comment to explain it, it should be rewritten instead.

Flag:
- Anything you have to read twice to understand
- Indirection that obscures what's actually happening
- Abstractions that make simple things look complex
- Code that could be deleted without changing behavior
- Inconsistency (same thing done two different ways)

Do NOT suggest adding anything (comments, types, docs, error handling).
Only suggest making things simpler, clearer, or shorter.
  `.trim(),
})

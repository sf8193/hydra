// Hooks outside hydra read the requested task from these tags instead of parsing hydra's wording.
const wrap = (tag: string, text: string, pad = ''): string =>
  `<${tag}>${pad}${text.replaceAll(`</${tag}>`, `<\\/${tag}>`)}${pad}</${tag}>`

export const request = (text: string): string => wrap('request', text)
export const hydraPrompt = (prompt: string): string => wrap('hydra-prompt', prompt, '\n')

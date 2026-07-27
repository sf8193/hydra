import { defineLens } from '../../daemon/lens-loader.js'
import { SECURITY_INSTRUCTIONS } from '../../daemon/modifiers.js'

export default defineLens({
  lens: 'security',
  aliases: ['s'],
  instructions: SECURITY_INSTRUCTIONS,
})

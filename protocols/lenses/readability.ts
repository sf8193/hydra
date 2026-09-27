import { defineLens } from '../../daemon/lens-loader.js'
import { READABILITY_INSTRUCTIONS } from '../../daemon/modifiers.js'

export default defineLens({
  lens: 'readability',
  aliases: ['r'],
  instructions: READABILITY_INSTRUCTIONS,
})

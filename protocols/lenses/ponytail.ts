import { defineLens } from '../../daemon/lens-loader.js'
import { PONYTAIL_INSTRUCTIONS } from '../../daemon/modifiers.js'

export default defineLens({
  lens: 'ponytail',
  aliases: [],
  instructions: PONYTAIL_INSTRUCTIONS,
})

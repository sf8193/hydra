import { setDeliveryGate } from '../../sessions/bridge-transport.js'
import { deliveryRefusal } from '../../app/restricted.js'

// The daemon arms the delivery gate at boot (daemon.ts); a test that delivers imports this to run under the same rule.
setDeliveryGate(deliveryRefusal)

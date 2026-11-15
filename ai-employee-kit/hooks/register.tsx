import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'
import { registerDock } from './dock'

export const register: Register = on => {
  // The dock registers first, so its hook on helpers' report_progress runs before Clean View's.
  registerDock(on)
  registerCleanView(on)
  // More mods register here, each from its own file.
}

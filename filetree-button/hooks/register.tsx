import type { EngineInterface, Register } from 'claude-code'
import { statusGrid } from './status-grid'
import { switchedHidden, switchedOff, watchSwitch } from './switch'

// A status-bar button that shows or hides the filetree mod's sidebar, as
// `/filetree` does. The tree itself stays filetree's: this only runs the command.

const TREE_PLUGIN = 'filetree'

const C = {
  teal: '#39C5CF',
  ink: '#0D1117',
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function toggleTree($: EngineInterface): Promise<void> {
  try {
    const commands = await $.command.list()
    const own = commands.find(c => c.plugin === TREE_PLUGIN && c.name === 'filetree')
    const command = (own ?? commands.find(c => c.name === 'filetree'))?.name
    if (!command) {
      $.ui.toast('filetree is not on. Turn it on in Mods, then /reload-plugins.')

      return
    }
    const result = await $.command.run({ command })
    const text = result?.text ?? ''
    // filetree explains when it can't show (layout or width); pass that on.
    if (/needs/i.test(text)) $.ui.toast(text)
  } catch (err) {
    $.ui.toast(`The file tree could not open (${errorText(err)}).`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($, 'filetree-button', 'Files button')

    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (switchedOff() || switchedHidden()) return next(e) /* switch-guarded */
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const modes = e.props.modes

    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="toggle-filetree"
          plain
          onPress={() => {
            // Opening waits on filetree; keep the press itself short.
            $.clock.after(0, () => {
              void toggleTree($)
            })
          }}
        >
          <Text color={C.teal}>▐</Text>
          <Text backgroundColor={C.teal} color={C.ink} bold>
            {'▤ Files'}
          </Text>
          <Text color={C.teal}>▌</Text>
        </Button>,
    ) as never
  })
}

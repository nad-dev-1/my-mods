import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReplayTarget } from '../types'
import { statusGrid } from './status-grid'

// A status-bar button that opens Replay Theater. The pane, the diffs and the
// stepping all stay Replay Theater's: this mod only counts the edits, so the
// button can show how many there are, and runs `/replay` when pressed.

const REPLAY_PLUGIN = 'replay-theater'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

const edits = atom({ plugin: 'replay-button', key: 'edits' } as const, 0)
const pending = atom({ plugin: 'replay-button', key: 'pending' } as const, 0)

const C = {
  pink: '#DB61A2',
  idle: '#30363D',
  idleText: '#8B949E',
  ink: '#0D1117',
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Replay Theater's own command, or why it can't be run. */
async function findReplay($: EngineInterface): Promise<ReplayTarget> {
  const commands = await $.command.list()
  const own = commands.find(c => c.plugin === REPLAY_PLUGIN && c.name === 'replay')
  const any = own ?? commands.find(c => c.name === 'replay')
  if (any) return { command: any.name }

  return { missing: 'Replay Theater is not on. Turn it on in Mods, then /reload-plugins.' }
}

async function openReplay($: EngineInterface): Promise<void> {
  try {
    const target = await findReplay($)
    if ('missing' in target) {
      $.ui.toast(target.missing)

      return
    }
    const result = await $.command.run({ command: target.command })
    const text = result?.text ?? ''
    // Replay Theater answers "no edits in the last turn" when it has nothing.
    if (/no edits/i.test(text)) $.ui.toast('Replay: no file edits to show yet.')
  } catch (err) {
    $.ui.toast(`Replay could not open (${errorText(err)}).`)
  }
}

export const register: Register = on => {
  // Counts reset with each load, as Replay Theater's own memory does.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await update($, edits, () => 0)
    await update($, pending, () => 0)

    return r
  })

  // Count each edit; never touch the call.
  on('tool.call', async ($, e, next) => {
    if (EDIT_TOOLS.has(e.tool)) {
      // MultiEdit (on builds that have it) is one Replay step per edit.
      const list: unknown = (e as unknown as { edits?: unknown }).edits
      const steps = Array.isArray(list) ? list.length : 1
      await update($, pending, n => n + steps)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, pending, () => 0)

    return next(e)
  })

  // Like Replay Theater: a main turn with edits replaces the replay; a turn
  // without edits keeps the last one.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const count = await read($, pending)
    if (count > 0) {
      await update($, edits, () => count)
      await update($, pending, () => 0)
    }

    return r
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const count = await read($, edits)
    const hasEdits = count > 0
    const fill = hasEdits ? C.pink : C.idle
    const ink = hasEdits ? C.ink : C.idleText
    const modes = e.props.modes

    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-replay"
          plain
          onPress={() => {
            // Opening waits on Replay Theater; keep the press itself short.
            $.clock.after(0, () => {
              void openReplay($)
            })
          }}
        >
          <Text color={fill}>▐</Text>
          <Text backgroundColor={fill} color={ink} bold>
            {hasEdits ? `▶ Replay ${count}` : '▶ Replay'}
          </Text>
          <Text color={fill}>▌</Text>
        </Button>,
    ) as never
  })
}

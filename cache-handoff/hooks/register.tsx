import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffMode } from '../types'
import { statusGrid } from './status-grid'

/** This session's prompt cache lives an hour after the last request reads it. */
const TTL_MS = 60 * 60 * 1000
/** The keep-alive goes out this long before the cache would expire. */
const LEAD_MS = 5 * 60 * 1000
/** The cheapest message that still makes a request over the cached prefix. */
const KEEP_ALIVE_TEXT = 'Hi'
/** `$.store` key of the Keep cache switch, kept across sessions. */
const KEEP_STORE = 'keep-cache'
/** While a turn runs, look again this often instead of sending. */
const BUSY_RETRY_MS = 30 * 1000
/** Under this much time left the countdown shows seconds. */
const SECONDS_UNDER_MS = 10 * 60 * 1000

const C = {
  warm: '#3FB950',
  soon: '#D29922',
  cold: '#F85149',
  accent: '#39C5CF',
  muted: '#7D8590',
  coral: '#F78166',
  coralBright: '#FFA28B',
  ink: '#0D1117',
  sheet: '#161B22',
}

/** The small dialog the status-bar Handoff button opens. */
const CHOICE_PANE = 'cache-handoff-choice'

/** A handoff asked for while Claude was replying: it starts when the reply ends. */
let queued: HandoffMode | null = null

const lastRequestAt = atom({ plugin: 'cache-handoff', key: 'lastRequestAt' } as const, 0)
const isKeepOn = atom({ plugin: 'cache-handoff', key: 'isKeepOn' } as const, false)
const isTurnRunning = atom({ plugin: 'cache-handoff', key: 'isTurnRunning' } as const, false)
const nowAtom = atom({ plugin: 'cache-handoff', key: 'now' } as const, 0)
const isChoosingHandoff = atom(
  { plugin: 'cache-handoff', key: 'isChoosingHandoff' } as const,
  false,
)
const lastKeepAliveAt = atom({ plugin: 'cache-handoff', key: 'lastKeepAliveAt' } as const, 0)
const note = atom({ plugin: 'cache-handoff', key: 'note' } as const, '')

type Timer = { cancel: () => void }

/** Minutes for a long wait, m:ss under ten minutes. */
export function fmtLeft(ms: number): string {
  if (ms >= SECONDS_UNDER_MS) {
    const minutes = Math.floor(ms / 60000)

    return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
  }
  const seconds = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * The moment the countdown is drawn for: whole minutes far out, whole seconds
 * near the end, counted from the expiry so the figure changes exactly on it.
 */
function shownTime(now: number, last: number): number {
  if (last === 0) return Math.floor(now / 60000) * 60000
  const expires = last + TTL_MS
  const left = expires - now
  if (left <= 0) return expires + Math.floor(-left / 60000) * 60000
  const step = left < SECONDS_UNDER_MS + 60000 ? 1000 : 60000

  return expires - Math.ceil(left / step) * step
}

/** Whole minutes since the cache expired. */
function fmtAgo(ms: number): string {
  const minutes = Math.floor(ms / 60000)

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Timers and these flags start over on a reload; `session.start` arms them again.
let keepAliveTimer: Timer | null = null
let ticker: Timer | null = null
let armGen = 0
let sawStepThisTurn = false

async function say($: EngineInterface, text: string) {
  await update($, note, () => text)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const shown = shownTime(now, await read($, lastRequestAt))
  if (shown !== (await read($, nowAtom))) await update($, nowAtom, () => shown)
}

/** Sets the one keep-alive timer from the switch and the last request; clears it otherwise. */
async function arm($: EngineInterface) {
  const gen = ++armGen
  const keep = await read($, isKeepOn)
  const last = await read($, lastRequestAt)
  const now = await $.clock.now()
  // A later arm owns the timer; from here to the assignment nothing awaits.
  if (gen !== armGen) return
  keepAliveTimer?.cancel()
  keepAliveTimer = null
  // Nothing cached yet, or already expired: a "Hi" would only re-write it.
  if (!keep || last === 0 || now >= last + TTL_MS - 2000) return
  const delay = Math.max(1000, last + TTL_MS - LEAD_MS - now)
  keepAliveTimer = $.clock.after(delay, () => {
    void keepAlive($)
  })
}

/** Sends the keep-alive when it is still due: switch on, cache warm, no turn running. */
async function keepAlive($: EngineInterface) {
  keepAliveTimer = null
  const gen = armGen
  if (!(await read($, isKeepOn))) return
  const last = await read($, lastRequestAt)
  const now = await $.clock.now()
  if (last === 0 || now >= last + TTL_MS) return
  // A request since the timer was set moved the cache clock: schedule from it.
  if (now < last + TTL_MS - LEAD_MS - 1000) return arm($)
  if (await read($, isTurnRunning)) {
    if (gen === armGen && !keepAliveTimer) {
      keepAliveTimer = $.clock.after(BUSY_RETRY_MS, () => {
        void keepAlive($)
      })
    }

    return
  }
  await update($, lastKeepAliveAt, () => now)
  try {
    const sent = await $.prompt.submit({ text: KEEP_ALIVE_TEXT })
    if (sent.drop !== undefined) await say($, `Keep cache: the "Hi" was not sent (${sent.drop}).`)
    else await say($, '')
  } catch (err) {
    await say($, `Keep cache: the "Hi" could not be sent (${errorText(err)}).`)
  }
}

async function setKeep($: EngineInterface, isOn: boolean) {
  await update($, isKeepOn, () => isOn)
  await $.store.set(KEEP_STORE, isOn).catch(() => undefined)
  await arm($)
}

/** Runs ctx-handoff's own command: `now` hands off (clears the chat), `dry` only writes it. */
async function runHandoff($: EngineInterface, mode: HandoffMode) {
  await update($, isChoosingHandoff, () => false)
  try {
    const commands = await $.command.list()
    const own = commands.find(c => c.plugin === 'ctx-handoff' && (c.name === 'handoff' || c.name === 'ctx-handoff'))
    const command = own?.name ?? commands.find(c => c.name === 'ctx-handoff')?.name
    if (!command) {
      await say($, 'Create Handoff needs the ctx-handoff mod installed and turned on.')

      return
    }
    await say($, '')
    // A handoff takes a minute or more, past a press's 10s budget: start it on
    // its own timer and return, as ctx-handoff starts its own.
    $.clock.after(0, () => {
      void startHandoff($, command, mode)
    })
  } catch (err) {
    await say($, `The handoff could not start (${errorText(err)}).`)
  }
}

/** The status-bar button: a small dialog with the same two choices as the band. */
async function openChoice($: EngineInterface) {
  const opened = await $.ui.open({
    id: CHOICE_PANE,
    title: 'Handoff',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: 7,
    columns: 46,
    backgroundColor: C.sheet,
  })
  if (!opened.isPlaced) {
    // No room for a dialog: fall back to the choice row above the prompt.
    await update($, isChoosingHandoff, () => true)
  }
}

/** A choice from the dialog: now, or once the reply under way has ended. */
async function chooseFromDialog($: EngineInterface, mode: HandoffMode) {
  await $.ui.close({ id: CHOICE_PANE }).catch(() => undefined)
  if (await read($, isTurnRunning)) {
    queued = mode
    await say($, `The handoff (${mode === 'now' ? 'hand off now' : 'just write it'}) starts when Claude's reply ends.`)

    return
  }
  await runHandoff($, mode)
}

async function startHandoff($: EngineInterface, command: string, mode: HandoffMode) {
  try {
    await $.command.run({ command, args: mode })
  } catch (err) {
    await say($, `The handoff could not start (${errorText(err)}).`)
  }
}

/**
 * ctx-handoff's handoff request: its instructions are written in Chinese and
 * say "use the user's language", which drifts to Chinese. Told by who made the
 * call, or by the request's own opening words and its HANDOFF: line.
 */
export function isHandoffRequest(prompt: string, plugin: string): boolean {
  const looksLikeIt = prompt.includes('HANDOFF:') && (prompt.includes('handoff') || prompt.includes('交接'))

  return plugin === 'ctx-handoff' ? looksLikeIt : looksLikeIt && prompt.startsWith('為接手這段工作')
}

export const ENGLISH_HANDOFF = [
  '',
  'LANGUAGE (this overrides the line above about the user\'s language): write the whole handoff in English, ' +
    'whatever language these instructions or the conversation use. The first line is "HANDOFF:" followed by the goal in English; ' +
    'number the sections 1 to 12 with English headings (Goal and scope, User constraints and preferences, Where it stopped, Verified, ' +
    'Done but unverified / discussed only, Tried and failed, Facts found, Tools and environment, Still running or unfinished, ' +
    'Decisions, Next step, Questions for the user); write "None" for an empty section. ' +
    'Quote the user\'s own words exactly as they wrote them (do not translate quotes). Keep code, commands, paths, names and error messages verbatim.',
].join('\n')

/** ctx-handoff's background notes request (its system prompt opens with these words). */
export function isNotesRequest(system: string, plugin: string): boolean {
  const looksLikeIt = system.startsWith('你在背景整理使用者訊息裡附上的對話紀錄')

  return looksLikeIt && (plugin === 'ctx-handoff' || plugin === 'engine')
}

export const ENGLISH_NOTES = [
  '',
  'LANGUAGE (this overrides the line above about the user\'s language): write every value you output in English: titles, ' +
    'how, why, evidence, rule and procedure names and steps, progress fields and decisions, even though these instructions ' +
    'and many existing notes are in Chinese. When you update an existing note, write the updated text in English. ' +
    'Keep JSON keys, op names, ids (M1, R2, P3, G1) and the output format exactly as specified. ' +
    'Copy "quote" values exactly as the user wrote them, never translated. Keep code, commands, paths, names and error messages verbatim.',
].join('\n')

export const register: Register = on => {
  // ctx-handoff's project notes in English: add the instruction to its notes request.
  on('model.complete', async ($, e, next) => {
    const system = e.system ?? ''
    if (!isNotesRequest(system, next.origin.plugin) || system.includes(ENGLISH_NOTES)) return next(e)

    return next({ ...e, system: `${system}${ENGLISH_NOTES}` })
  })

  // Handoff documents in English: add the instruction to ctx-handoff's request.
  on('model.fork', async ($, e, next) => {
    if (!isHandoffRequest(e.prompt, next.origin.plugin) || e.prompt.includes(ENGLISH_HANDOFF)) return next(e)

    return next({ ...e, prompt: `${e.prompt}${ENGLISH_HANDOFF}` })
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const kept = await $.store.get(KEEP_STORE).catch(() => undefined)
    await update($, isKeepOn, () => kept === true)
    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void tick($)
    })
    await tick($)
    await arm($)

    return started
  })

  // Each request the main conversation sends reads the cache and restarts its hour.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      sawStepThisTurn = true
      const now = await $.clock.now()
      await update($, isTurnRunning, () => true)
      await update($, lastRequestAt, () => now)
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      // A host that raised no step still sent a request when the turn has usage.
      if (!sawStepThisTurn && e.usage) {
        const now = await $.clock.now()
        await update($, lastRequestAt, () => now)
      }
      sawStepThisTurn = false
      await update($, isTurnRunning, () => false)
      await tick($)
      await arm($)
      if (queued) {
        const mode = queued
        queued = null
        await runHandoff($, mode)
      }
    }

    return done
  })

  // A compaction sends the summary request: the new, shorter prefix is cached from now.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, lastRequestAt, () => now)
      await arm($)
    }

    return done
  })

  // /clear or a resume starts another conversation: nothing of it is cached yet.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, lastRequestAt, () => 0)
      await update($, isTurnRunning, () => false)
      await arm($)
    }

    return next(e)
  })

  // The Handoff button in the status bar, beside the other mods' buttons.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const fill = queued ? C.coralBright : C.coral
    const modes = e.props.modes

    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-handoff"
          plain
          onPress={async () => {
            // Opened within the press, so it counts as asked for.
            await openChoice($)
          }}
        >
          <Text color={fill}>▐</Text>
          <Text backgroundColor={fill} color={C.ink} bold>
            {queued ? '⇄ Handoff …' : '⇄ Handoff'}
          </Text>
          <Text color={fill}>▌</Text>
        </Button>,
    ) as never
  })

  // The dialog it opens.
  on('ui.render', { component: 'Pane', requestId: CHOICE_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = await read($, isTurnRunning)

    return (
      <Box flexDirection="column">
        <Text bold color={C.coral}>
          ⇄ Create a handoff
        </Text>
        <Text dimColor>{busy ? 'Claude is replying: it starts when the reply ends.' : 'ctx-handoff writes a summary to carry on from.'}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Button key="dialog-now" label="Hand off now (clears chat)" hotkey="1" variant="primary" autoFocus onPress={() => chooseFromDialog($, 'now')} />
          <Button key="dialog-write" label="Just write it" hotkey="2" onPress={() => chooseFromDialog($, 'dry')} />
          <Button key="dialog-cancel" label="Cancel" hotkey="3" onPress={() => $.ui.close({ id: CHOICE_PANE }).catch(() => undefined)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const { Box, Button, Text } = $.ui.resolve(e)

    const last = await read($, lastRequestAt)
    const keep = await read($, isKeepOn)
    const choosing = await read($, isChoosingHandoff)
    const shownNow = await read($, nowAtom)
    const message = await read($, note)
    const now = Math.max(shownNow, await $.clock.now())

    const left = last + TTL_MS - now
    const isCold = last > 0 && left <= 0
    const color = last === 0 ? C.muted : isCold ? C.cold : left < LEAD_MS * 2 ? C.soon : C.warm
    const label = last === 0 ? 'waiting for the first reply' : isCold ? `expired ${fmtAgo(-left)} ago` : `${fmtLeft(left)} left`
    const untilHi = last + TTL_MS - LEAD_MS - now
    const hint = !keep ? '' : last === 0 ? ' · keeps it from the first reply' : isCold ? ' · keeps it from your next message' : untilHi > 0 ? ` · Hi in ${fmtLeft(untilHi)}` : ' · sending Hi…'

    const bar = choosing ? (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text color={C.soon} bold>
          Create Handoff:
        </Text>
        <Button key="handoff-now" label="Hand off now (clears chat)" variant="primary" onPress={() => runHandoff($, 'now')} />
        <Button key="handoff-write" label="Just write it" onPress={() => runHandoff($, 'dry')} />
        <Button key="handoff-cancel" label="Cancel" role="dismiss" onPress={() => update($, isChoosingHandoff, () => false)} />
      </Box>
    ) : (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text>
          <Text color={C.accent} bold>
            ◷ Cache{' '}
          </Text>
          <Text color={color} bold>
            {label}
          </Text>
          <Text dimColor>{hint}</Text>
        </Text>
        <Button key="keep-cache" variant={keep ? 'primary' : 'secondary'} onPress={() => setKeep($, !keep)}>
          Keep cache:{' '}
          <Text bold color={keep ? C.warm : C.muted}>
            {keep ? 'ON' : 'OFF'}
          </Text>
        </Button>
        <Button key="create-handoff" label="Create Handoff" onPress={() => update($, isChoosingHandoff, () => true)} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        {rest ?? null}
        {bar}
        {message !== '' && <Text dimColor>{message}</Text>}
      </Box>
    )
  })
}

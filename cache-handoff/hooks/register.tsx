import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffMode } from '../types'
import { statusGrid } from './status-grid'

// Cache Clock, after "Mod #3" of Ben AI's "9 Insane Claude Mods" video (itself
// inspired by Karan Bansal's Cache Tax): a card above the prompt counting down
// the hour the prompt cache stays warm, an Auto-warm switch that keeps it warm
// with invisible pings, and a Create Handoff button for ctx-handoff.

/** This session's prompt cache lives an hour after the last request reads it. */
const TTL_MS = 60 * 60 * 1000
/** A keep-warm ping goes out this long before the cache would expire. */
const LEAD_MS = 5 * 60 * 1000
/** `$.store` keys kept across sessions: the Auto-warm switch and the folded card. */
const KEEP_STORE = 'keep-cache'
const HIDE_STORE = 'card-hidden'
/** While a turn runs, look again this often instead of pinging. */
const BUSY_RETRY_MS = 30 * 1000
/** A ping refused by a busy API is tried again this long after, while it can still land. */
const API_RETRY_MS = 60 * 1000
/** The cold-send guard only holds back a chat at least this large. */
const GUARD_MIN_TOKENS = 50_000
/** The bar's length in cells. */
const BAR_CELLS = 24

/**
 * The ping: a tool-less question over the chat as the main thread last sent
 * it, so the API reads the whole prefix from the cache and keeps it warm. It
 * names no effort, which could make the first fork write the chat again.
 */
const PING_PROMPT = 'This is an automated prompt-cache keep-alive, not a task. Reply with the single word OK, straight away, without thinking it over.'

const C = {
  warm: '#3FB950',
  soon: '#D29922',
  cold: '#F85149',
  accent: '#39C5CF',
  keep: '#58A6FF',
  muted: '#7D8590',
  track: '#30363D',
  coral: '#F78166',
  coralBright: '#FFA28B',
  ink: '#0D1117',
  sheet: '#161B22',
}

// $ per million tokens, [cache read, 1h cache write, output], list prices
// October 2026, from Karan Bansal's Cache Tax (MIT,
// https://github.com/karanb192/cache-tax). More specific families first.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

/** [cache read, 1h cache write, uncached input, output] $/MTok for a model id; null when unknown. */
export function priceOf(model: string): [number, number, number, number] | null {
  const m = model.toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, readP, writeP, outP] of PRICES) {
    // An uncached input token costs half a 1-hour cache write.
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [readP, writeP, writeP / 2, outP]
  }

  return null
}

/** The dollar figure of a request's tokens; null for a model with no price. */
function usdOf(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number | null {
  const p = priceOf(model)
  if (!p) return null
  const [readP, writeP, inP, outP] = p

  return (u.cache_read_input_tokens * readP + u.cache_creation_input_tokens * writeP + u.input_tokens * inP + u.output_tokens * outP) / 1e6
}

export function fmtUsd(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

/** 214000 → 214k, 1500000 → 1.5M. */
export function fmtK(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const [v, unit] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'M']

  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`
}

/** The video's clock: whole minutes and seconds, 59:49. */
export function fmtClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Whole minutes since the cache expired. */
function fmtAgo(ms: number): string {
  const minutes = Math.floor(ms / 60000)

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

/** The moment the countdown is drawn for: whole seconds, counted from the expiry. */
function shownTime(now: number, last: number): number {
  if (last === 0) return Math.floor(now / 60000) * 60000
  const expires = last + TTL_MS
  const left = expires - now
  if (left <= 0) return expires + Math.floor(-left / 60000) * 60000

  return expires - Math.ceil(left / 1000) * 1000
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The small dialog the status-bar Handoff button opens. */
const CHOICE_PANE = 'cache-handoff-choice'

/** A handoff asked for while Claude was replying: it starts when the reply ends. */
let queued: HandoffMode | null = null

const lastRequestAt = atom({ plugin: 'cache-handoff', key: 'lastRequestAt' } as const, 0)
const isKeepOn = atom({ plugin: 'cache-handoff', key: 'isKeepOn' } as const, false)
const isTurnRunning = atom({ plugin: 'cache-handoff', key: 'isTurnRunning' } as const, false)
const nowAtom = atom({ plugin: 'cache-handoff', key: 'now' } as const, 0)
const isChoosingHandoff = atom({ plugin: 'cache-handoff', key: 'isChoosingHandoff' } as const, false)
const lastKeepAliveAt = atom({ plugin: 'cache-handoff', key: 'lastKeepAliveAt' } as const, 0)
const note = atom({ plugin: 'cache-handoff', key: 'note' } as const, '')
const isHidden = atom({ plugin: 'cache-handoff', key: 'isHidden' } as const, false)
const pingCount = atom({ plugin: 'cache-handoff', key: 'pingCount' } as const, 0)
const lastPingRead = atom({ plugin: 'cache-handoff', key: 'lastPingRead' } as const, 0)
const pingsUsd = atom({ plugin: 'cache-handoff', key: 'pingsUsd' } as const, 0)
const pausedReason = atom({ plugin: 'cache-handoff', key: 'pausedReason' } as const, '')
const guardedFor = atom({ plugin: 'cache-handoff', key: 'guardedFor' } as const, 0)
const warnedFor = atom({ plugin: 'cache-handoff', key: 'warnedFor' } as const, 0)

type Timer = { cancel: () => void }

// Timers and these flags start over on a reload; `session.start` arms them again.
let keepAliveTimer: Timer | null = null
let warnTimer: Timer | null = null
let ticker: Timer | null = null
let armGen = 0
let sawStepThisTurn = false
let pingInFlight = false

async function say($: EngineInterface, text: string) {
  await update($, note, () => text)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const shown = shownTime(now, await read($, lastRequestAt))
  if (shown !== (await read($, nowAtom))) await update($, nowAtom, () => shown)
}

/** The chat's size as the session last measured it: what a cold send writes again. */
async function chatTokens($: EngineInterface): Promise<number> {
  const usage = await $.session.usage().catch(() => undefined)

  return usage?.context.tokens ?? 0
}

/**
 * Sets the timers from the switch and the last request: with Auto-warm on, the
 * ping 5 minutes before expiry; with it off, the warning at the same moment.
 */
async function arm($: EngineInterface) {
  const gen = ++armGen
  const keep = await read($, isKeepOn)
  const last = await read($, lastRequestAt)
  const paused = await read($, pausedReason)
  const warned = await read($, warnedFor)
  const now = await $.clock.now()
  // A later arm owns the timers; from here to the assignments nothing awaits.
  if (gen !== armGen) return
  keepAliveTimer?.cancel()
  keepAliveTimer = null
  warnTimer?.cancel()
  warnTimer = null
  // Nothing cached yet, or already expired: a ping would only write it again.
  if (last === 0 || now >= last + TTL_MS - 2000) return
  const due = Math.max(1000, last + TTL_MS - LEAD_MS - now)
  if (keep && paused === '') {
    keepAliveTimer = $.clock.after(due, () => {
      void keepAlive($)
    })
  } else if (!keep && warned !== last) {
    warnTimer = $.clock.after(due, () => {
      void warnCold($)
    })
  }
}

/** Auto-warm off: one notification, 5 minutes before this hour's cache goes cold. */
async function warnCold($: EngineInterface) {
  warnTimer = null
  if (await read($, isKeepOn)) return
  const last = await read($, lastRequestAt)
  const now = await $.clock.now()
  if (last === 0 || now >= last + TTL_MS || (await read($, warnedFor)) === last) return
  if (now < last + TTL_MS - LEAD_MS - 1000) return arm($)
  await update($, warnedFor, () => last)
  await $.ui
    .notify('The prompt cache goes cold in 5 minutes. Reply, or switch Auto-warm on, to keep it warm.', { title: 'Cache' })
    .catch(() => undefined)
}

/** Stops the pinging and says why; the next reply of the main conversation starts it again. */
async function pause($: EngineInterface, reason: string) {
  await update($, pausedReason, () => reason)
  keepAliveTimer?.cancel()
  keepAliveTimer = null
}

/** The ping, when it is still due: switch on, cache warm, no turn running, none in flight. */
async function keepAlive($: EngineInterface) {
  keepAliveTimer = null
  const gen = armGen
  if (!(await read($, isKeepOn)) || (await read($, pausedReason)) !== '') return
  const last = await read($, lastRequestAt)
  const now = await $.clock.now()
  if (last === 0 || now >= last + TTL_MS) return
  // A request since the timer was set moved the cache clock: schedule from it.
  if (now < last + TTL_MS - LEAD_MS - 1000) return arm($)
  if ((await read($, isTurnRunning)) || pingInFlight) {
    if (gen === armGen && !keepAliveTimer) {
      keepAliveTimer = $.clock.after(BUSY_RETRY_MS, () => {
        void keepAlive($)
      })
    }

    return
  }
  pingInFlight = true
  let result: Awaited<ReturnType<EngineInterface['model']['fork']>> | null = null
  try {
    result = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    await pause($, `the last ping could not be sent (${errorText(err)})`)
  } finally {
    pingInFlight = false
  }
  if (!result) return
  const at = await $.clock.now()
  if (!result.isAnswered) {
    const status = 'status' in result ? Number(result.status) : 0
    const busy = result.reason === 'api-error' && (status === 429 || status === 529 || status >= 500)
    if (busy && at + API_RETRY_MS < last + TTL_MS - 5000) {
      await say($, `The API was busy (${status}): the ping is tried again in a minute.`)
      if (gen === armGen) {
        // Another step may have set a timer while the ping was out.
        ;(keepAliveTimer as Timer | null)?.cancel()
        keepAliveTimer = $.clock.after(API_RETRY_MS, () => {
          void keepAlive($)
        })
      }

      return
    }
    await pause($, result.reason === 'nothing-to-fork' ? 'there is no conversation to read yet' : `the last ping failed (${result.reason}${status ? ` ${status}` : ''})`)

    return
  }
  const u = result.usage
  const usd = usdOf(await $.session.model().catch(() => ''), u) ?? 0
  await update($, pingCount, n => (n ?? 0) + 1)
  await update($, lastPingRead, () => u.cache_read_input_tokens)
  await update($, pingsUsd, n => (n ?? 0) + usd)
  await update($, lastKeepAliveAt, () => at)
  await say($, '')
  // The safety check: a ping must read the chat from the cache, not write it.
  if (u.cache_read_input_tokens === 0) {
    await pause($, 'the last ping found no cache (it had already gone cold), so pinging would only pay to write it again')

    return
  }
  if (u.cache_creation_input_tokens >= u.cache_read_input_tokens * 0.1) {
    await pause($, `the last ping wrote ${fmtK(u.cache_creation_input_tokens)} tokens to the cache instead of only reading it`)

    return
  }
  // The read restarted the cache's hour.
  await update($, lastRequestAt, () => at)
  await update($, warnedFor, () => 0)
  await tick($)
  await arm($)
}

async function setKeep($: EngineInterface, isOn: boolean) {
  await update($, isKeepOn, () => isOn)
  await $.store.set(KEEP_STORE, isOn).catch(() => undefined)
  await arm($)
}

async function setHidden($: EngineInterface, hidden: boolean) {
  await update($, isHidden, () => hidden)
  await $.store.set(HIDE_STORE, hidden).catch(() => undefined)
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

/** The status-bar button: a small dialog with the same two choices as the card. */
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
  }).catch(($, e, next) => next(e))

  // Handoff documents in English: add the instruction to ctx-handoff's request.
  on('model.fork', async ($, e, next) => {
    if (!isHandoffRequest(e.prompt, next.origin.plugin) || e.prompt.includes(ENGLISH_HANDOFF)) return next(e)

    return next({ ...e, prompt: `${e.prompt}${ENGLISH_HANDOFF}` })
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const kept = await $.store.get(KEEP_STORE).catch(() => undefined)
    await update($, isKeepOn, () => kept === true)
    const hidden = await $.store.get(HIDE_STORE).catch(() => undefined)
    await update($, isHidden, () => hidden === true)
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
      // A reply re-warmed the cache: a paused keep-warm starts again from it.
      await update($, pausedReason, () => '')
      await update($, warnedFor, () => 0)
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

  // The cold-send guard: on a cold, large chat, the first message a person
  // typed is held back once with the rewrite price; sending again goes ahead.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin.kind !== 'composer') return next(e)
    const last = await read($, lastRequestAt)
    const now = await $.clock.now()
    if (last === 0 || now < last + TTL_MS || (await read($, guardedFor)) === last) return next(e)
    const tokens = await chatTokens($)
    if (tokens < GUARD_MIN_TOKENS) return next(e)
    await update($, guardedFor, () => last)
    const p = priceOf(await $.session.model().catch(() => ''))
    const cold = p ? ` (~${fmtUsd((tokens * p[1]) / 1e6)}; a warm reply would have cost ~${fmtUsd((tokens * p[0]) / 1e6)})` : ''
    // Put the text back, so sending it again is one keypress.
    const text = e.text
    $.clock.after(50, () => {
      void (async () => {
        const box = await $.prompt.read().catch(() => ({ text: 'x', cursor: 0 }))
        if (box.text === '') await $.prompt.fill({ text }).catch(() => undefined)
      })()
    })

    return {
      drop: `The prompt cache went cold ${fmtAgo(now - last - TTL_MS)} ago: sending this writes about ${fmtK(tokens)} tokens again${cold}. Send it again to go ahead, or use Create Handoff to start fresh from a summary.`,
    }
  }).catch(($, e, next) => next(e))

  // A compaction sends the summary request: the new, shorter prefix is cached from now.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, lastRequestAt, () => now)
      await arm($)
    }

    return done
  }).catch(($, e, next) => next(e))

  // /clear or a resume starts another conversation: nothing of it is cached yet.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, lastRequestAt, () => 0)
      await update($, isTurnRunning, () => false)
      await update($, pingCount, () => 0)
      await update($, lastPingRead, () => 0)
      await update($, pausedReason, () => '')
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

  // The card above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const { Box, Button, Text } = $.ui.resolve(e)

    const last = await read($, lastRequestAt)
    const keep = await read($, isKeepOn)
    const choosing = await read($, isChoosingHandoff)
    const hidden = await read($, isHidden)
    const shownNow = await read($, nowAtom)
    const message = await read($, note)
    const pings = await read($, pingCount)
    const pingRead = await read($, lastPingRead)
    const spent = await read($, pingsUsd)
    const paused = await read($, pausedReason)
    const now = Math.max(shownNow, await $.clock.now())
    const model = await $.session.model().catch(() => '')
    const tokens = await chatTokens($)
    const price = priceOf(model)

    const left = last + TTL_MS - now
    const isCold = last > 0 && left <= 0
    const color = last === 0 ? C.muted : isCold || left < LEAD_MS ? C.cold : left < LEAD_MS * 2 ? C.soon : C.warm
    const filled = last === 0 || isCold ? 0 : Math.max(1, Math.round((left / TTL_MS) * BAR_CELLS))
    const untilPing = last + TTL_MS - LEAD_MS - now

    // Line 1: the clock, the bar, and the buttons (the only line left when folded).
    const head = (
      <Box key="cache-head" flexDirection="row" justifyContent="space-between" flexWrap="wrap">
        <Text>
          <Text color={color}>{'◷ Cache '}</Text>
          {last === 0 ? <Text color={C.muted}>waiting for the first reply</Text> : null}
          {isCold ? (
            <Text color={C.cold} bold>
              {`cold · expired ${fmtAgo(-left)} ago`}
            </Text>
          ) : null}
          {last > 0 && !isCold ? <Text color={color}>{'warm '}</Text> : null}
          {last > 0 && !isCold ? (
            <Text color={color} bold>
              {fmtClock(left)}
            </Text>
          ) : null}
          <Text>{'  '}</Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={C.track}>{'━'.repeat(BAR_CELLS - filled)}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="keep-cache" variant={keep ? 'primary' : 'secondary'} onPress={() => setKeep($, !keep)}>
            {'Auto-warm: '}
            <Text bold color={keep ? C.warm : C.muted}>
              {keep ? 'ON' : 'OFF'}
            </Text>
          </Button>
          <Button key="create-handoff" label="Create Handoff" onPress={() => update($, isChoosingHandoff, () => true)} />
          <Button key="hide-card" label={hidden ? 'Show' : 'Hide'} onPress={() => setHidden($, !hidden)} />
        </Box>
      </Box>
    )

    const dollars =
      price && tokens > 0 ? ` (~${fmtUsd((tokens * price[0]) / 1e6)} warm vs ~${fmtUsd((tokens * price[1]) / 1e6)} if it goes cold)` : ''
    const explain =
      last === 0
        ? 'The clock starts with Claude\'s first reply; the cache then stays warm for an hour.'
        : isCold
          ? `The cache went cold: your next message writes ${tokens > 0 ? `about ${fmtK(tokens)} tokens` : 'the whole chat'} again${price && tokens > 0 ? ` (~${fmtUsd((tokens * price[1]) / 1e6)})` : ''}.`
          : `1 hour cache, as Anthropic's last reply set it. Reply now and ${tokens > 0 ? `${fmtK(tokens)} tokens` : 'the chat'} cost 5 to 10% as much${dollars}.`

    const spentText = pings > 0 && spent > 0 ? ` · pings so far ~${fmtUsd(spent)}` : ''
    const keepLine = !keep ? (
      <Text key="keep-line" color={C.muted}>
        Auto-warm is off · a notification comes 5 minutes before it goes cold
      </Text>
    ) : paused !== '' ? (
      <Text key="keep-line" color={C.soon}>
        {`Pinging paused: ${paused}. It starts again after your next message.`}
      </Text>
    ) : last === 0 || isCold ? (
      <Text key="keep-line" color={C.keep}>
        {`Keeping warm · from your next reply${spentText}`}
      </Text>
    ) : (
      <Text key="keep-line" color={C.keep}>
        {pings === 0
          ? `Keeping warm · first ping in ${fmtClock(untilPing)}`
          : `Keeping warm · ping ${pings} · next in ${fmtClock(untilPing)} · last ping read ${fmtK(pingRead)} cached tokens${spentText}`}
      </Text>
    )

    const card = choosing ? (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text color={C.soon} bold>
          Create Handoff:
        </Text>
        <Button key="handoff-now" label="Hand off now (clears chat)" variant="primary" onPress={() => runHandoff($, 'now')} />
        <Button key="handoff-write" label="Just write it" onPress={() => runHandoff($, 'dry')} />
        <Button key="handoff-cancel" label="Cancel" role="dismiss" onPress={() => update($, isChoosingHandoff, () => false)} />
      </Box>
    ) : hidden ? (
      head
    ) : (
      <Box flexDirection="column">
        {head}
        <Text key="explain" color={C.muted} wrap="wrap">
          {explain}
        </Text>
        {keepLine}
        <Text key="cost-note" dimColor wrap="wrap">
          Each ping reads the chat from cache for a small part of the price (5 to 10%). Letting it go cold means writing it all again.
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {rest ?? null}
        {card}
        {message !== '' && <Text dimColor>{message}</Text>}
      </Box>
    )
  })
}

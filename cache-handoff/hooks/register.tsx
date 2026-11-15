import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffState } from '../types'
import { checkHandoff, handoffPrompt, scanMessages, slugOf, stampOf, usedFigure, wordCount } from './handoff-logic'
import type { Msg } from './handoff-logic'
import { statusGrid } from './status-grid'

// Cache Clock, after "Mod #3" of Ben AI's "9 Insane Claude Mods" video (itself
// inspired by Karan Bansal's Cache Tax): a card above the prompt counting down
// the hour the prompt cache stays warm, an Auto-warm switch that keeps it warm
// with invisible pings. And the Handoff, after the video's "Mod #4": a banner
// past 250k (or on a cold cache), a five-step progress card while the handoff
// is written, and a ready card that starts the new chat from it.

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
/** The Refresh banner shows from this context size, and again each 50k after a Hide. */
const BANNER_AT = 250_000
const BANNER_STEP = 50_000
/** While work is under way, the handoff looks again this often before it starts. */
const WAIT_POLL_MS = 2000
/** The `$.store` key set once ctx-handoff's own keep-warm refresh was switched off. */
const CTX_REFRESH_STORE = 'ctx-refresh-off'
/** Where handoffs are saved, under the project root; kept out of git locally. */
const HANDOFF_DIR = '.claude/handoffs'
/** The progress card's five steps. */
export const STEPS = ['Reading the conversation', 'Finding the files you used', 'Listing skills, tools and links', 'Writing the handoff', 'Saving and checking']
/** Cells in each step's bar. */
const STEP_CELLS = 12

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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const HANDOFF_IDLE: HandoffState = {
  phase: 'idle',
  step: 0,
  figures: ['', '', '', '', ''],
  waitingFor: '',
  writingSince: 0,
  text: '',
  words: 0,
  path: '',
  shownPath: '',
  costUsd: 0,
  saving: '',
  error: '',
}

const lastRequestAt = atom({ plugin: 'cache-handoff', key: 'lastRequestAt' } as const, 0)
const isKeepOn = atom({ plugin: 'cache-handoff', key: 'isKeepOn' } as const, false)
const isTurnRunning = atom({ plugin: 'cache-handoff', key: 'isTurnRunning' } as const, false)
const nowAtom = atom({ plugin: 'cache-handoff', key: 'now' } as const, 0)
const lastKeepAliveAt = atom({ plugin: 'cache-handoff', key: 'lastKeepAliveAt' } as const, 0)
const note = atom({ plugin: 'cache-handoff', key: 'note' } as const, '')
const isHidden = atom({ plugin: 'cache-handoff', key: 'isHidden' } as const, false)
const pingCount = atom({ plugin: 'cache-handoff', key: 'pingCount' } as const, 0)
const lastPingRead = atom({ plugin: 'cache-handoff', key: 'lastPingRead' } as const, 0)
const pingsUsd = atom({ plugin: 'cache-handoff', key: 'pingsUsd' } as const, 0)
const pausedReason = atom({ plugin: 'cache-handoff', key: 'pausedReason' } as const, '')
const guardedFor = atom({ plugin: 'cache-handoff', key: 'guardedFor' } as const, 0)
const warnedFor = atom({ plugin: 'cache-handoff', key: 'warnedFor' } as const, 0)
const handoffAtom = atom({ plugin: 'cache-handoff', key: 'handoff' } as const, HANDOFF_IDLE, { shape: 'handoff-v1' })
const bannerHiddenAt = atom({ plugin: 'cache-handoff', key: 'bannerHiddenAt' } as const, 0)
const coldBannerHiddenFor = atom({ plugin: 'cache-handoff', key: 'coldBannerHiddenFor' } as const, 0)
const recentAtom = atom({ plugin: 'cache-handoff', key: 'recent' } as const, [] as string[])

type Timer = { cancel: () => void }

// Timers and these flags start over on a reload; `session.start` arms them again.
let keepAliveTimer: Timer | null = null
let warnTimer: Timer | null = null
let ticker: Timer | null = null
let armGen = 0
let sawStepThisTurn = false
let pingInFlight = false
/** The handoff under way: a Cancel or a new one moves it, and the old one's results are dropped. */
let handoffGen = 0
let isBuilding = false
let waitTimer: Timer | null = null
let writeTicker: Timer | null = null

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

// ── The handoff (Mod #4) ──────────────────────────────────────────────────

async function setHandoff($: EngineInterface, patch: (h: HandoffState) => Partial<HandoffState>) {
  await update($, handoffAtom, h => ({ ...h, ...patch(h) }))
}

/** Sets step `i`'s figure (0 to 4) and moves on to the next step. */
async function stepDone($: EngineInterface, i: number, figure: string) {
  await setHandoff($, h => {
    const figures = [...h.figures]
    figures[i] = figure

    return { figures, step: i + 2 }
  })
}

/** What the handoff waits for before it can read the conversation whole; '' when nothing. */
async function busyWith($: EngineInterface): Promise<string> {
  if (await read($, isTurnRunning)) return "Claude's reply"
  const agents = await $.agent.list().catch(() => [])
  const running = agents.filter(a => a.status === 'running' || a.status === 'pending').length

  return running ? `${plural(running, 'subagent')} to finish` : ''
}

/** Refresh, Create Handoff, ⇄ Handoff and /handoff-new: build a handoff once work is done. */
export async function startHandoff($: EngineInterface) {
  const h = await read($, handoffAtom)
  if (h.phase === 'waiting' || h.phase === 'running') return
  const gen = ++handoffGen
  waitTimer?.cancel()
  waitTimer = null
  await update($, handoffAtom, () => ({ ...HANDOFF_IDLE, phase: 'waiting' as const }))
  await update($, recentAtom, () => [])
  await say($, '')
  // The writing takes a minute, past a press's 10s budget: it runs on its own timer.
  $.clock.after(0, () => {
    void proceed($, gen)
  })
}

async function proceed($: EngineInterface, gen: number) {
  if (gen !== handoffGen || isBuilding || (await read($, handoffAtom)).phase !== 'waiting') return
  const busy = await busyWith($)
  if (gen !== handoffGen) return
  if (busy) {
    await setHandoff($, () => ({ waitingFor: busy }))
    waitTimer?.cancel()
    waitTimer = $.clock.after(WAIT_POLL_MS, () => {
      void proceed($, gen)
    })

    return
  }
  await build($, gen)
}

export async function cancelHandoff($: EngineInterface) {
  handoffGen++
  waitTimer?.cancel()
  waitTimer = null
  writeTicker?.cancel()
  writeTicker = null
  await update($, handoffAtom, () => HANDOFF_IDLE)
  await update($, recentAtom, () => [])
}

async function fail($: EngineInterface, gen: number, error: string) {
  if (gen !== handoffGen) return
  await setHandoff($, () => ({ phase: 'failed' as const, error }))
}

/** The five steps: read, find files, list what was used, write, save and check. */
async function build($: EngineInterface, gen: number) {
  if (isBuilding) return
  isBuilding = true
  const live = () => gen === handoffGen
  try {
    await setHandoff($, () => ({ phase: 'running' as const, step: 1, waitingFor: '' }))
    const raw = await $.session.messages()
    const msgs = (Array.isArray(raw) ? raw : []) as Msg[]
    const scan = scanMessages(msgs)
    if (!live()) return
    await stepDone($, 0, plural(scan.count, 'message'))
    await stepDone($, 1, plural(scan.files.length, 'file'))
    await stepDone($, 2, usedFigure(scan))

    const root = await $.session.root().catch(() => $.session.cwd())
    const tokensBefore = await chatTokens($)
    const startedAt = await $.clock.now()
    await setHandoff($, h => {
      const figures = [...h.figures]
      figures[3] = '0s'

      return { figures, writingSince: startedAt }
    })
    writeTicker?.cancel()
    writeTicker = $.clock.every(1000, () => {
      void (async () => {
        if (!live()) return
        const now = await $.clock.now()
        await setHandoff($, h => {
          if (h.phase !== 'running' || h.step !== 4) return {}
          const figures = [...h.figures]
          figures[3] = `${Math.floor((now - h.writingSince) / 1000)}s`

          return { figures }
        })
      })()
    })
    let result: Awaited<ReturnType<EngineInterface['model']['fork']>>
    try {
      result = await $.model.fork({ prompt: handoffPrompt(root, scan) })
    } finally {
      writeTicker?.cancel()
      writeTicker = null
    }
    if (!live()) return
    if (!result.isAnswered) {
      const why =
        result.reason === 'nothing-to-fork'
          ? 'there is no finished reply to read yet (send a message first, then try again)'
          : `the model could not write it (${result.reason}${'status' in result && result.status ? ` ${result.status}` : ''})`

      return fail($, gen, `The handoff was not written: ${why}.`)
    }
    const text = result.text.trim()
    const problem = checkHandoff(text)
    if (problem) return fail($, gen, `The handoff came back unusable: ${problem}. Try again.`)
    const seconds = Math.max(1, Math.round(((await $.clock.now()) - startedAt) / 1000))
    await stepDone($, 3, `${seconds}s`)

    const name = `${stampOf(await $.clock.now())}-${slugOf(text)}.md`
    const shownPath = `${HANDOFF_DIR}/${name}`
    const path = `${root}/${shownPath}`
    await $.fs.write(path, `${text}\n`)
    const back = await $.fs.read(path).catch(() => '')
    if (back.trim() !== text) return fail($, gen, `The handoff was written but ${shownPath} does not read back the same.`)
    await keepOutOfGit($, root)
    if (!live()) return
    await stepDone($, 4, name)

    const model = await $.session.model().catch(() => '')
    const costUsd = usdOf(model, result.usage) ?? 0
    await setHandoff($, () => ({
      phase: 'ready' as const,
      step: 6,
      text,
      words: wordCount(text),
      path,
      shownPath,
      costUsd,
      saving: savingText(model, tokensBefore, text),
    }))
  } catch (err) {
    await fail($, gen, `The handoff could not be built (${errorText(err)}).`)
  } finally {
    isBuilding = false
  }
}

/** The ready card's per-message saving: the new chat sends the handoff, not the whole chat. */
function savingText(model: string, tokens: number, text: string): string {
  const fresh = Math.ceil(text.length / 4)
  if (tokens <= fresh) return ''
  const p = priceOf(model)
  const dollars = p ? `: ~${fmtUsd(((tokens - fresh) * p[0]) / 1e6)} less per message while warm, ~${fmtUsd(((tokens - fresh) * p[1]) / 1e6)} less when cold` : ''

  return `Each message in the new chat starts from about ${fmtK(fresh)} tokens instead of ${fmtK(tokens)}${dollars}.`
}

/** Adds the handoffs folder to the repository's own exclude file: never committed, never shared. */
async function keepOutOfGit($: EngineInterface, root: string) {
  const found = await $.process.run(['git', 'rev-parse', '--git-path', 'info/exclude'], { cwd: root }).catch(() => null)
  if (!found || found.exitCode !== 0 || !found.stdout.trim()) return
  const rel = found.stdout.trim()
  const exclude = rel.startsWith('/') ? rel : `${root}/${rel}`
  const current = await $.fs.read(exclude).catch(() => '')
  if (current.split('\n').some(line => line.trim().replace(/^\//, '').replace(/\/$/, '') === HANDOFF_DIR)) return
  const sep = current === '' || current.endsWith('\n') ? '' : '\n'
  await $.fs.write(exclude, `${current}${sep}# cache-handoff: saved handoffs stay on this machine\n${HANDOFF_DIR}/\n`).catch(() => undefined)
}

async function copyHandoff($: EngineInterface, surface?: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const h = await read($, handoffAtom)
  const r = await $.ui.copy({ text: h.text, ...(surface ? { surface } : {}) }).catch(() => ({ isCopied: false }))
  await say($, r.isCopied ? 'Copied the handoff prompt: paste it into any new chat.' : 'The handoff could not be copied here; open the file instead.')
}

/** /clear, then the handoff in the prompt box, followed by whatever was typed meanwhile; not sent. */
async function startNewChat($: EngineInterface) {
  const h = await read($, handoffAtom)
  if (h.phase !== 'ready') return
  $.clock.after(0, () => {
    void (async () => {
      try {
        const typed = (await $.prompt.read().catch(() => ({ text: '' }))).text.trim()
        await $.command.run({ command: 'clear', args: '' })
        await $.prompt.fill({ text: typed ? `${h.text}\n\n${typed}` : h.text })
        await cancelHandoff($)
        await say($, `New chat started from ${h.shownPath}: read it over, then send.`)
      } catch (err) {
        await say($, `The new chat could not be started (${errorText(err)}). Copy the handoff prompt instead.`)
      }
    })()
  })
}

async function openFile($: EngineInterface, path: string) {
  for (const opener of ['open', 'xdg-open']) {
    const r = await $.process.run([opener, path]).catch(() => null)
    if (r && r.exitCode === 0) return
  }
  await say($, `Could not open ${path}.`)
}

/** Earlier handoffs of this project, newest first, at most five; pressed again it folds. */
async function toggleRecent($: EngineInterface) {
  if ((await read($, recentAtom)).length) return update($, recentAtom, () => [])
  const h = await read($, handoffAtom)
  const root = await $.session.root().catch(() => $.session.cwd())
  const entries = await $.fs.list(`${root}/${HANDOFF_DIR}`).catch(() => [])
  const names = [...entries]
    .filter(f => f.kind === 'file' && f.name.endsWith('.md') && `${root}/${HANDOFF_DIR}/${f.name}` !== h.path)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(0, 5)
    .map(f => f.name)
  if (!names.length) return say($, 'No earlier handoffs in this project.')
  await update($, recentAtom, () => names)
}

/** Switches ctx-handoff's own keep-warm refresh off once: Auto-warm does that job here. */
async function quietCtxHandoff($: EngineInterface) {
  if ((await $.store.get(CTX_REFRESH_STORE).catch(() => undefined)) === true) return
  const commands = await $.command.list().catch(() => [])
  const own = commands.find(c => c.plugin === 'ctx-handoff' && c.name === 'handoff')
  if (!own) return
  await $.command.run({ command: own.name, args: 'refresh off' })
  await $.store.set(CTX_REFRESH_STORE, true)
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
    await $.command
      .register({ name: 'handoff-new', description: 'Write a full handoff of this chat, save it, and start a new chat from it' })
      .catch(() => undefined)
    $.clock.after(0, () => {
      void quietCtxHandoff($).catch(() => undefined)
    })

    return started
  })

  on('command.run', { command: 'handoff-new' }, async $ => {
    await startHandoff($)

    return { text: 'Building a handoff: follow its steps above the prompt.' }
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
      // A handoff waiting for this reply starts now, unless subagents still run.
      if ((await read($, handoffAtom)).phase === 'waiting') {
        const gen = handoffGen
        $.clock.after(0, () => {
          void proceed($, gen)
        })
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
      drop: `The prompt cache went cold ${fmtAgo(now - last - TTL_MS)} ago: sending this writes about ${fmtK(tokens)} tokens again${cold}. Send it again to go ahead, or press Refresh (or /handoff-new) to move this work to a new chat with a full handoff.`,
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
    const phase = (await read($, handoffAtom)).phase
    const isBusy = phase === 'waiting' || phase === 'running'
    const fill = isBusy ? C.coralBright : C.coral
    const modes = e.props.modes

    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-handoff"
          plain
          onPress={() => startHandoff($)}
        >
          <Text color={fill}>▐</Text>
          <Text backgroundColor={fill} color={C.ink} bold>
            {isBusy ? '⇄ Handoff …' : '⇄ Handoff'}
          </Text>
          <Text color={fill}>▌</Text>
        </Button>,
    ) as never
  })

  // The card above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const { Box, Button, Text } = $.ui.resolve(e)

    const last = await read($, lastRequestAt)
    const keep = await read($, isKeepOn)
    const handoff = await read($, handoffAtom)
    const recent = await read($, recentAtom)
    const hiddenAt = await read($, bannerHiddenAt)
    const coldHiddenFor = await read($, coldBannerHiddenFor)
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
          <Button key="create-handoff" label="Create Handoff" onPress={() => startHandoff($)} />
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

    const isActive = handoff.phase !== 'idle'
    const card =
      hidden || isActive ? (
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

    // The Refresh banner: a cold cache on a chat worth moving, or a context past 250k.
    const showCold = !isActive && isCold && tokens >= GUARD_MIN_TOKENS && coldHiddenFor !== last
    const showBig = !isActive && !showCold && tokens >= BANNER_AT && (hiddenAt === 0 || tokens >= hiddenAt + BANNER_STEP)
    const banner =
      showCold || showBig ? (
        <Box key="refresh-banner" flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
          <Text wrap="wrap">
            <Text color={showCold ? C.cold : C.soon}>{'● '}</Text>
            {showCold
              ? `Cache cold on a ${fmtK(tokens)} chat: your next message writes it all again${price ? ` (~${fmtUsd((tokens * price[1]) / 1e6)})` : ''}. Refresh moves this work to a new chat with a full handoff.`
              : `Context at ${fmtK(tokens)}. Refresh moves this work to a new chat with a full handoff.`}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="banner-refresh" label="Refresh" variant="primary" onPress={() => startHandoff($)} />
            <Button
              key="banner-hide"
              label="Hide"
              onPress={() => (showCold ? update($, coldBannerHiddenFor, () => last) : update($, bannerHiddenAt, () => tokens))}
            />
          </Box>
        </Box>
      ) : null

    const stepRow = (label: string, i: number) => {
      const n = i + 1
      const done = handoff.step > n
      const current = handoff.phase === 'running' && handoff.step === n
      const seconds = Math.floor((now - handoff.writingSince) / 1000)
      const filled = done ? STEP_CELLS : current ? (n === 4 ? Math.min(STEP_CELLS - 1, 1 + Math.floor(seconds / 4)) : STEP_CELLS / 2) : 0
      const mark = done ? '✓' : current ? '▸' : handoff.phase === 'failed' && handoff.step === n ? '✗' : '○'
      const markColor = done ? C.warm : current ? C.accent : handoff.phase === 'failed' && handoff.step === n ? C.cold : C.muted

      return (
        <Text key={`step-${n}`} wrap="truncate-end">
          <Text color={markColor}>{`${mark} `}</Text>
          <Text color={done || current ? undefined : C.muted}>{`${n}. ${label}`.padEnd(34)}</Text>
          <Text color={done ? C.warm : C.accent}>{'━'.repeat(filled)}</Text>
          <Text color={C.track}>{'━'.repeat(STEP_CELLS - filled)}</Text>
          <Text color={C.muted}>{handoff.figures[i] ? `  ${handoff.figures[i]}` : ''}</Text>
        </Text>
      )
    }

    const handoffCard = !isActive ? null : (
      <Box key="handoff-card" flexDirection="column" borderStyle="round" borderColor={handoff.phase === 'failed' ? C.cold : handoff.phase === 'ready' ? C.warm : C.coral} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
          <Text bold color={handoff.phase === 'failed' ? C.cold : handoff.phase === 'ready' ? C.warm : C.coral}>
            {handoff.phase === 'waiting'
              ? `⇄ Refreshing: waiting for ${handoff.waitingFor || 'the work under way'}`
              : handoff.phase === 'running'
                ? '⇄ Refreshing: building your handoff'
                : handoff.phase === 'ready'
                  ? `✓ Handoff ready: ${handoff.words} words`
                  : '✗ Handoff failed'}
          </Text>
          {handoff.phase === 'waiting' || handoff.phase === 'running' ? (
            <Button key="handoff-cancel" label="Cancel" role="dismiss" onPress={() => cancelHandoff($)} />
          ) : null}
        </Box>
        {handoff.phase === 'waiting' ? (
          <Text color={C.muted} wrap="wrap">
            It starts by itself once the work under way has finished, so the handoff reads all of it.
          </Text>
        ) : null}
        {STEPS.map(stepRow)}
        {handoff.phase === 'failed' ? (
          <Text color={C.cold} wrap="wrap">
            {handoff.error}
          </Text>
        ) : null}
        {handoff.phase === 'ready' ? (
          <Box flexDirection="column">
            <Text wrap="wrap">
              <Text color={C.muted}>{'Saved to '}</Text>
              {handoff.shownPath}
              <Text color={C.muted}>{' (kept out of git on this machine)'}</Text>
            </Text>
            <Text color={C.muted} wrap="wrap">
              {`Writing it cost ~${fmtUsd(handoff.costUsd)}.${handoff.saving ? ` ${handoff.saving}` : ''}`}
            </Text>
          </Box>
        ) : null}
        {handoff.phase === 'ready' ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
            <Button key="handoff-new-chat" label="Start new chat with it" variant="primary" onPress={() => startNewChat($)} />
            <Button key="handoff-copy" label="Copy handoff prompt" onPress={() => copyHandoff($, e.surface)} />
            <Button key="handoff-open" label="Open file" onPress={() => openFile($, handoff.path)} />
            <Button key="handoff-recent" label={recent.length ? 'Hide earlier' : 'Earlier handoffs'} onPress={() => toggleRecent($)} />
            <Button key="handoff-close" label="Close" role="dismiss" onPress={() => cancelHandoff($)} />
          </Box>
        ) : null}
        {handoff.phase === 'failed' ? (
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="handoff-retry" label="Try again" variant="primary" onPress={() => startHandoff($)} />
            <Button key="handoff-close" label="Close" role="dismiss" onPress={() => cancelHandoff($)} />
          </Box>
        ) : null}
        {handoff.phase === 'ready' && recent.length ? (
          <Box flexDirection="column">
            <Text color={C.muted}>Earlier handoffs in this project:</Text>
            {recent.map(name => (
              <Button key={`recent-${name}`} plain onPress={() => openFile($, `${handoff.path.slice(0, handoff.path.lastIndexOf('/'))}/${name}`)}>
                <Text color={C.keep}>{`  ${name}`}</Text>
              </Button>
            ))}
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {rest ?? null}
        {card}
        {banner}
        {handoffCard}
        {message !== '' && <Text dimColor>{message}</Text>}
      </Box>
    )
  })
}

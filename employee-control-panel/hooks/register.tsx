import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alias, GitInfo, Level, MainPicks, SubPicks, Tokens } from '../types'

import { statusGrid } from './status-grid'
import { offCommand, offPane, switchedHidden, switchedOff, watchSwitch } from './switch'

// Employee Control Panel: a "Control Tools" button in the status bar opens a
// panel to switch the model and effort level of the main session (it runs
// /model and /effort for you) and of the subagents Claude starts (it rewrites
// each agent as it starts). A status line under the controls shows what is in
// force, what is waiting for Claude to finish, and what was refused.

type E$ = EngineInterface

const PANE = 'control-tools'

// In the video's order, cheapest first. `version` is the latest known when
// this was written; the model in use always shows its live version instead.
const MODELS: { alias: Alias; label: string; version: string }[] = [
  { alias: 'haiku', label: 'Haiku', version: '5.5' },
  { alias: 'sonnet', label: 'Sonnet', version: '5.5' },
  { alias: 'opus', label: 'Opus', version: '5.5' },
  { alias: 'fable', label: 'Fable', version: '5.2' },
]
const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
const LEVEL_LABEL: Record<Level, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

/** What a command's output says when it did not take. */
const REFUSED = /not available|invalid|unknown|not supported|unsupported|no such|cannot|can't|failed|error/i

const isOpen = atom({ plugin: 'employee-control-panel', key: 'isOpen' } as const, false)
const isBusy = atom({ plugin: 'employee-control-panel', key: 'isBusy' } as const, false)
const tick = atom({ plugin: 'employee-control-panel', key: 'tick' } as const, 0)
const NO_PICKS: MainPicks = { model: null, effort: null }
const main = atom({ plugin: 'employee-control-panel', key: 'main' } as const, NO_PICKS, { shape: 'main-1' })
const seen = atom({ plugin: 'employee-control-panel', key: 'seen' } as const, {} as Record<string, string>, {
  shape: 'seen-1',
})
const AUTO: SubPicks = { model: '', effort: '' }
const sub = atom({ plugin: 'employee-control-panel', key: 'sub' } as const, AUTO, { shape: 'sub-1' })
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const tokens = atom({ plugin: 'employee-control-panel', key: 'tokens' } as const, NO_TOKENS, { shape: 'tokens-1' })
const NO_GIT: GitInfo = { branch: '', added: 0, removed: 0 }
const git = atom({ plugin: 'employee-control-panel', key: 'git' } as const, NO_GIT, { shape: 'git-1' })


/** The video's palette: orange accent, pink effort, green for what is live. */
const C = {
  orange: '#EE6A3C',
  pink: '#C2569B',
  blue: '#58A6FF',
  violet: '#A371F7',
  ink: '#0D1117',
  sheet: '#161B22',
  chip: '#30363D',
  rule: '#3D444D',
  text: '#E6EDF3',
  white: '#FFFFFF',
  muted: '#7D8590',
  green: '#3FB950',
  amber: '#E3B341',
  red: '#F85149',
}

/** `Control Tools` → `C O N T R O L   T O O L S`, as the video's headings. */
function spaced(text: string): string {
  return text
    .toUpperCase()
    .split(' ')
    .map(word => word.split('').join(' '))
    .join('   ')
}

/** A model family's tab label, with the live version for the one in use. */
function labelOf(alias: Alias, live: string): string {
  if (familyOf(live) === alias) return prettyModel(live)
  const m = MODELS.find(x => x.alias === alias)

  return m ? `${m.label} ${m.version}` : cap(alias)
}

function effortColor(level: string): string {
  switch (level) {
    case 'low':
      return C.muted
    case 'medium':
      return C.blue
    case 'high':
      return C.amber
    case 'xhigh':
      return C.red
    case 'max':
      return C.violet
    default:
      return C.text
  }
}

function pctColor(pct: number): string {
  return pct >= 90 ? C.red : pct >= 70 ? C.amber : C.green
}

/** A 10-cell meter: ▰ used, ▱ free. */
function meter(pct: number): string {
  const used = Math.max(0, Math.min(10, Math.round(pct / 10)))

  return '▰'.repeat(used) + '▱'.repeat(10 - used)
}

/** 1234 → 1.2k, 120000 → 120k, 2500000 → 2.5M. */
function fmtK(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const [v, unit] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'M']

  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`
}

/** 7_800_000 ms → 2h 10m; under an hour → 45m. */
function fmtDur(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60

  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** The working folder's branch and uncommitted line changes, as git says. */
async function refreshGit($: E$): Promise<void> {
  const cwd = await $.session.cwd().catch(() => '')
  if (!cwd) return
  const run = (args: string[]) =>
    $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  const head = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.exitCode !== 0) {
    await update($, git, () => NO_GIT)

    return
  }
  const stat = await run(['diff', '--shortstat', 'HEAD'])
  const added = Number(/(\d+) insertion/.exec(stat.stdout)?.[1] ?? 0)
  const removed = Number(/(\d+) deletion/.exec(stat.stdout)?.[1] ?? 0)
  const next: GitInfo = { branch: head.stdout.trim(), added, removed }
  const cur = await read($, git)
  if (cur.branch !== next.branch || cur.added !== added || cur.removed !== removed) await update($, git, () => next)
}

/** Subscription or API, from how the session signs in (once per load). */
let planCache: string | undefined
async function planOf($: E$, rateLimitCount: number): Promise<string> {
  if (planCache === undefined) {
    const who = await $.session.identity().catch(() => undefined)
    const kind = who && !who.deny ? who.kind : ''
    planCache = kind === 'claude.ai' ? 'Subscription' : kind === 'console' || kind === 'api-key' ? 'API' : ''
  }
  // A five-hour window exists only on a subscription.
  return planCache || (rateLimitCount > 0 ? 'Subscription' : '')
}

// ---------------------------------------------------------------------------
// Reading what is in force
// ---------------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function cap(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word
}

/** The family a model id or name belongs to ('' when none of ours). */
function familyOf(model: string): Alias | '' {
  const m = /(fable|opus|sonnet|haiku)/i.exec(model)

  return m ? (m[1]!.toLowerCase() as Alias) : ''
}

/** `claude-opus-5-5` → `Opus 5.5`; anything else as given. */
function prettyModel(model: string): string {
  const m = /(fable|opus|sonnet|haiku)[- ](\d+)(?:[-.](\d{1,2}))?(?!\d)/i.exec(model)
  if (!m) return model || 'unknown model'

  return `${cap(m[1]!.toLowerCase())} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

async function modelNow($: E$): Promise<string> {
  return $.session.model().catch(() => '')
}

/**
 * The effort in force for `model`: the last /effort seen on it this session,
 * else the per-model level in the settings, else the settings' own level.
 * '' when nothing says.
 */
async function effortNow($: E$, model: string): Promise<string> {
  const known = (await read($, seen))[model]
  if (known) return known
  try {
    const per = (await $.settings.read({ key: 'modelSettings' as never })) as unknown
    if (per && typeof per === 'object') {
      const table = per as Record<string, { effortLevel?: unknown } | undefined>
      const own = table[model]?.effortLevel
      if (typeof own === 'string') return own
      const fam = familyOf(model)
      const kin = Object.entries(table).find(([id]) => fam && familyOf(id) === fam)?.[1]?.effortLevel
      if (typeof kin === 'string') return kin
    }
    const level = (await $.settings.read({ key: 'effortLevel' as never })) as unknown

    return typeof level === 'string' ? level : ''
  } catch {
    return ''
  }
}

async function redraw($: E$): Promise<void> {
  await update($, tick, n => (n ?? 0) + 1)
}

// ---------------------------------------------------------------------------
// Main session: /model and /effort, run for the person
// ---------------------------------------------------------------------------

let seq = 0

/** The 30-second refresh of the clocks and git. */
let timer: { cancel: () => void } | undefined

/** A pick: shown at once (pending), run as the command, then shown as it went. */
async function pickMain($: E$, kind: 'model' | 'effort', value: string): Promise<void> {
  const mine = ++seq
  await update($, main, cur => ({ ...(cur ?? NO_PICKS), [kind]: { value, state: 'pending', text: '', seq: mine } }))
  // In the background: the command waits for a running reply to end.
  void applyMain($, kind, value, mine)
}

async function applyMain($: E$, kind: 'model' | 'effort', value: string, mine: number): Promise<void> {
  let text = ''
  let failed = false
  try {
    const ran = await $.command.run({ command: kind, args: value })
    text = (ran.text ?? '').trim()
    failed = REFUSED.test(text)
  } catch (err) {
    failed = true
    text = errorText(err)
  }
  if (!failed && kind === 'model' && familyOf(await modelNow($)) !== value) failed = true
  // This plugin's own run skips its own command.run hooks: note the level here.
  if (!failed && kind === 'effort') {
    const model = await modelNow($)
    await update($, seen, cur => ({ ...(cur ?? {}), [model]: value }))
  }
  // A newer pick of the same kind tells the story now.
  if ((await read($, main))[kind]?.seq !== mine) return
  const why = failed ? (text.split('\n')[0] ?? '').slice(0, 120) || 'it did not take' : ''
  await update($, main, cur => ({ ...(cur ?? NO_PICKS), [kind]: { value, state: failed ? 'error' : 'applied', text: why, seq: mine } }))
  await redraw($)
}

// ---------------------------------------------------------------------------
// Subagents: picks kept per project
// ---------------------------------------------------------------------------

async function subKey($: E$): Promise<string> {
  const root = await $.session.root().catch(() => '')

  return `sub:${root || 'default'}`
}

function parseSub(raw: unknown): SubPicks {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const model = typeof o.model === 'string' && MODELS.some(m => m.alias === o.model) ? o.model : ''
  const effort = typeof o.effort === 'string' && (LEVELS as string[]).includes(o.effort) ? o.effort : ''

  return { model, effort }
}

async function pickSub($: E$, kind: 'model' | 'effort', value: string): Promise<void> {
  const next = { ...(await read($, sub)), [kind]: value }
  await update($, sub, () => next)
  await $.store.set(await subKey($), next).catch(() => undefined)
}

function subLabel(s: SubPicks): string {
  return [s.model ? cap(s.model) : '', s.effort].filter(Boolean).join('/')
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

async function openPanel($: E$): Promise<void> {
  if (await read($, isOpen)) return
  await update($, isOpen, () => true)
  const opened = await $.ui.open({
    id: PANE,
    title: 'Control Tools',
    focus: true,
    closeOnEscape: true,
    rows: 16,
    columns: 64,
    backgroundColor: C.sheet,
  })
  if (!opened.isPlaced) {
    await update($, isOpen, () => false)
    await $.ui.close({ id: PANE }).catch(() => undefined)
    $.ui.toast(`Control Tools could not open: ${opened.reason}`)
  }
}

async function closePanel($: E$): Promise<void> {
  await update($, isOpen, () => false)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

/** The one status line for the main session. */
function mainStatus(model: string, effort: string, picks: MainPicks, busy: boolean): { icon: string; color: string; text: string } {
  const p = [picks.model, picks.effort]
  const modelPart = picks.model?.state === 'pending' ? labelOf(picks.model.value as Alias, model) : prettyModel(model)
  const effortPart = picks.effort?.state === 'pending' ? picks.effort.value : effort || 'default'
  const head = `Main: ${modelPart} · effort ${effortPart}`
  const failed = p.find(x => x?.state === 'error')
  if (failed) {
    const what = failed === picks.model ? cap(failed.value) : `effort ${failed.value}`

    return { icon: '✕', color: C.red, text: `${head} · ${what}: ${failed.text}` }
  }
  if (p.some(x => x?.state === 'pending')) {
    return { icon: '◐', color: C.amber, text: `${head} · ${busy ? 'pending, applies when Claude finishes' : 'switching…'}` }
  }
  const touched = p.some(x => x?.state === 'applied')

  return { icon: '●', color: C.green, text: `${head} · ${touched ? 'applied' : 'in use'}` }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($, 'employee-control-panel', 'Control Tools')
    const r = await next(e)
    await $.command.register({ name: 'controls', description: 'Pick the model and effort for Claude and its subagents' })
    // A reload or a new session: no pane, no reply running, this project's picks.
    await update($, isOpen, () => false)
    await update($, isBusy, () => false)
    await update($, main, () => NO_PICKS)
    const stored = await $.store.get(await subKey($)).catch(() => undefined)
    await update($, sub, () => parseSub(stored))
    await refreshGit($)
    await redraw($)
    // The clocks and git move on their own: look again every 30 seconds.
    timer?.cancel()
    timer = $.clock.every(30_000, () => {
      void refreshGit($).then(() => redraw($))
    })

    return r
  })

  on('command.run', { command: 'controls' }, async $ => {

    if (switchedOff()) return offCommand() /* switch-guarded */
    await openPanel($)

    return { text: 'Opening Control Tools.' }
  })

  // /model and /effort, typed or run by the panel: the status follows.
  // A failure here must never stand in the way of the command itself.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    if (switchedOff()) return offCommand() /* switch-guarded */
    const r = await next(e)
    await redraw($)

    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort' }, async ($, e, next) => {

    if (switchedOff()) return offCommand() /* switch-guarded */
    const r = await next(e)
    const level = e.args.trim().toLowerCase()
    if ((LEVELS as string[]).includes(level) && !REFUSED.test(r.text ?? '')) {
      const model = await modelNow($)
      await update($, seen, cur => ({ ...(cur ?? {}), [model]: level }))
    }
    await redraw($)

    return r
  }).catch(($, e, next) => next(e))

  // A main-loop reply running: a switch picked now waits for it.
  on('turn.start', async ($, e, next) => {
    if (switchedOff()) return next(e) /* switch-guarded */
    const r = await next(e)
    if (!e.agentId) await update($, isBusy, () => true)

    return r
  })

  on('turn.complete', async ($, e, next) => {

    if (switchedOff()) return next(e) /* switch-guarded */
    const r = await next(e)
    if (!e.agentId) {
      await update($, isBusy, () => false)
      const u = e.usage
      if (u) {
        await update($, tokens, cur => ({
          input: (cur?.input ?? 0) + u.input_tokens,
          output: (cur?.output ?? 0) + u.output_tokens,
          cacheRead: (cur?.cacheRead ?? 0) + u.cache_read_input_tokens,
          cacheWrite: (cur?.cacheWrite ?? 0) + u.cache_creation_input_tokens,
        }))
      }
      await refreshGit($)
    }
    await redraw($)

    return r
  })

  // Subagent model: every agent but a fork (which always runs as the main
  // session) or a resumed one (whose model is fixed).
  on('agent.spawn', async ($, e, next) => {
    if (switchedOff()) return next(e) /* switch-guarded */
    const s = await read($, sub)
    const r = !s.model || e.subagentType === 'fork' || e.resume ? await next(e) : await next({ ...e, model: s.model })
    await redraw($)

    return r
  }).catch(($, e, next) => next(e))

  // Subagent effort: set on each Agent call but a fork's.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (switchedOff()) return next(e) /* switch-guarded */
    const s = await read($, sub)
    if (!s.effort || e.subagent_type === 'fork') return next(e)

    return next({ ...e, effort: s.effort as Level })
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    await update($, isOpen, () => false)

    return done
  }).catch(($, e, next) => next(e))

  // Live figures: a measurement after each turn or rate-limit move, and an
  // agent starting, redraw the bar.
  on('session.measure', async ($, e, next) => {
    if (switchedOff()) return next(e) /* switch-guarded */
    const r = await next(e)
    await redraw($)

    return r
  }).catch(($, e, next) => next(e))

  // The live session bar, three lines as ccstatusline drew them, under the
  // engine's own hint line (kept live), so it starts at the left edge.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (switchedOff() || switchedHidden()) return next(e) /* switch-guarded */
    const { Box, Text } = $.ui.resolve(e)
    const hint = await next(e)
    await read($, tick)
    const picks = await read($, main)
    const s = await read($, sub)
    const t = await read($, tokens)
    const g = await read($, git)
    const model = await modelNow($)
    const effort = picks.effort?.state === 'pending' ? picks.effort.value : await effortNow($, model)
    const modelPending = picks.model?.state === 'pending'
    const modelText = modelPending ? `${labelOf(picks.model!.value as Alias, model)} …` : prettyModel(model)
    const usage = await $.session.usage().catch(() => undefined)
    const now = await $.clock.now()
    const ctx = usage?.context.percent
    const ctxTokens = usage?.context.tokens
    const fiveHour = usage?.rateLimits.find(r => r.kind === 'five_hour')
    const week = usage?.rateLimits.find(r => r.kind === 'seven_day')
    const blockReset = fiveHour?.resetsAt ? Date.parse(fiveHour.resetsAt) : NaN
    const blockElapsed = Number.isFinite(blockReset) ? 5 * 3_600_000 - (blockReset - now) : NaN
    const sessionMs = usage?.startedAt ? now - usage.startedAt : NaN
    const plan = await planOf($, usage?.rateLimits.length ?? 0)
    const agents = (await $.agent.list().catch(() => [])).filter(a => a.status === 'running').length
    const cwd = await $.session.cwd().catch(() => '')
    const folder = cwd.split('/').filter(Boolean).pop() ?? ''
    const style = await $.settings.read({ key: 'outputStyle' as never }).catch(() => undefined)
    const total = t.input + t.output + t.cacheRead + t.cacheWrite
    const subText = subLabel(s)

    /** One labelled figure: a dim label, then the value in colour. */
    const seg = (key: string, label: string, value: string, color: string, bold = true) => (
      <Text key={key}>
        {label ? <Text color={C.muted}>{`${label} `}</Text> : null}
        <Text color={color} bold={bold}>
          {value}
        </Text>
      </Text>
    )
    /** Joins the figures of one line with dim bars, skipping the empty ones. */
    const line = (key: string, parts: (ReturnType<typeof seg> | null)[], tail?: unknown) => {
      const shown = parts.filter((x): x is ReturnType<typeof seg> => x !== null)
      const out: unknown[] = []
      shown.forEach((x, i) => {
        if (i > 0) {
          out.push(
            <Text key={`${key}-sep-${i}`} color={C.rule}>
              {' │ '}
            </Text>,
          )
        }
        out.push(x)
      })

      // One Text per line: short of room it is cut at its end, never broken
      // into a column of fragments.
      return (
        <Text key={key} wrap="truncate-end">
          {out as ReturnType<typeof seg>[]}
          {tail as ReturnType<typeof seg>}
        </Text>
      )
    }

    const line1 = line(
      'line-1',
      [
        plan ? seg('seg-plan', '', `◆ ${plan}`, C.green, false) : null,
        <Text key="seg-model" color={modelPending ? C.amber : C.text} bold>
          <Text color={C.blue}>{'◆ '}</Text>
          {modelText}
        </Text>,
        seg('seg-effort', 'effort', effort || 'default', effortColor(effort)),
        ctx !== undefined ? (
          <Text key="seg-ctx">
            <Text color={C.muted}>{'ctx '}</Text>
            <Text color={C.green}>{meter(ctx)}</Text>
            <Text color={pctColor(ctx)} bold>{` ${Math.round(ctx)}%`}</Text>
            {ctxTokens !== undefined ? <Text color={C.muted}>{` · ${fmtK(ctxTokens)}`}</Text> : null}
          </Text>
        ) : null,
        <Text key="seg-agents" color={agents > 0 ? C.blue : C.muted}>
          {`${agents > 0 ? '◆' : '◇'} ${agents} agent${agents === 1 ? '' : 's'}`}
        </Text>,
        subText ? seg('seg-sub', 'sub', subText, C.text, false) : null,
      ],
    )
    const line2 = line('line-2', [
      fiveHour ? seg('seg-5h', '5h', `${Math.round(fiveHour.percentUsed)}%`, pctColor(fiveHour.percentUsed)) : null,
      Number.isFinite(blockElapsed) ? seg('seg-block', 'block', fmtDur(blockElapsed), C.text, false) : null,
      week ? seg('seg-week', 'week', `${Math.round(week.percentUsed)}%`, pctColor(week.percentUsed)) : null,
      Number.isFinite(sessionMs) ? seg('seg-session', 'session', fmtDur(sessionMs), C.text, false) : null,
    ])
    const line3 = line('line-3', [
      folder ? seg('seg-cwd', '', `▸ ${folder}`, C.blue, false) : null,
      g.branch
        ? (
            <Text key="seg-git">
              <Text color={C.violet}>{`⎇ ${g.branch}`}</Text>
              {g.added || g.removed ? (
                <Text>
                  <Text color={C.green}>{` +${g.added}`}</Text>
                  <Text color={C.red}>{` −${g.removed}`}</Text>
                </Text>
              ) : null}
            </Text>
          )
        : null,
      total > 0
        ? (
            <Text key="seg-tokens">
              <Text color={C.muted}>{'in '}</Text>
              <Text color={C.text}>{fmtK(t.input)}</Text>
              <Text color={C.muted}>{'  out '}</Text>
              <Text color={C.text}>{fmtK(t.output)}</Text>
              <Text color={C.muted}>{'  cached '}</Text>
              <Text color={C.text}>{fmtK(t.cacheRead + t.cacheWrite)}</Text>
              <Text color={C.muted}>{'  total '}</Text>
              <Text color={C.text} bold>
                {fmtK(total)}
              </Text>
            </Text>
          )
        : null,
      seg('seg-style', 'style', typeof style === 'string' && style ? style : 'default', C.text, false),
    ])

    return (
      <Box key="status-hint" flexDirection="column">
        {hint as ReturnType<typeof seg>}
        {line1}
        {line2}
        {line3}
      </Box>
    )
  })

  // The status bar's own place, to the right of the hint line: every mod's
  // button, this one first, in the shared grid at the right edge.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (switchedOff() || switchedHidden()) return next(e) /* switch-guarded */
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const open = await read($, isOpen)
    const button = (
      <Button
        key="open-controls"
        plain
        label={open ? 'Close Control Tools' : 'Open Control Tools'}
        onPress={async () => {
          // Opened within the press, so it counts as asked for.
          if (await read($, isOpen)) await closePanel($)
          else await openPanel($)
        }}
      >
        <Text backgroundColor={open ? C.orange : C.chip} color={open ? C.white : C.orange} bold>
          {` ◆ Control Tools ${open ? '∨' : '∧'} `}
        </Text>
      </Button>
    )

    return statusGrid({ Box, Text }, below, e.props.modes, button) as never
  })

  // The panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (switchedOff()) return offPane($, e) /* switch-guarded */
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const picks = await read($, main)
    const s = await read($, sub)
    const busy = await read($, isBusy)
    const model = await modelNow($)
    const effort = await effortNow($, model)
    const pickedModel = picks.model && picks.model.state !== 'error' ? picks.model.value : familyOf(model)
    const pickedEffort = picks.effort && picks.effort.state !== 'error' ? picks.effort.value : effort
    const status = mainStatus(model, effort, picks, busy)
    const nowText = `${pickedModel ? labelOf(pickedModel as Alias, model) : prettyModel(model)} · ${cap(pickedEffort) || 'Default'}`

    /** One option in a tab row: plain text, highlighted when picked. */
    const tab = (key: string, label: string, isOn: boolean, onColor: string, onPress: () => unknown) => (
      <Button key={key} plain label={label} onPress={onPress}>
        <Text backgroundColor={isOn ? onColor : undefined} color={isOn ? C.white : C.text} bold={isOn}>
          {` ${label} `}
        </Text>
      </Button>
    )
    const row = (name: string, tabs: ReturnType<typeof tab>[]) => (
      <Box key={`row-${name}`} flexDirection="row" flexWrap="wrap">
        <Text color={C.muted}>{name.padEnd(9)}</Text>
        {tabs}
      </Box>
    )
    const section = (title: string) => (
      <Box key={`sec-${title}`} flexDirection="row" marginTop={1}>
        <Text color={C.rule}>{'── '}</Text>
        <Text color={C.muted} bold>
          {spaced(title)}
        </Text>
      </Box>
    )
    const modelTabs = (prefix: string, picked: string, onPick: (alias: string) => unknown) =>
      MODELS.map(m => tab(`${prefix}#${m.alias}`, labelOf(m.alias, model), picked === m.alias, C.orange, () => onPick(m.alias)))
    const effortTabs = (prefix: string, picked: string, onPick: (level: string) => unknown) =>
      LEVELS.map(l => tab(`${prefix}#${l}`, LEVEL_LABEL[l], picked === l, C.pink, () => onPick(l)))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={C.orange} bold>
            {`◆ ${spaced('Control Tools')}`}
          </Text>
          <Text color={C.muted}>{nowText}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {row('MODEL', modelTabs('main-model', pickedModel, alias => pickMain($, 'model', alias)))}
          {row('EFFORT', effortTabs('main-effort', pickedEffort, level => pickMain($, 'effort', level)))}
        </Box>
        {section('Subagents')}
        <Box flexDirection="column" marginTop={1}>
          {row('MODEL', [
            tab('sub-model#', 'Auto', s.model === '', C.orange, () => pickSub($, 'model', '')),
            ...modelTabs('sub-model', s.model, alias => pickSub($, 'model', alias)),
          ])}
          {row('EFFORT', [
            tab('sub-effort#', 'Auto', s.effort === '', C.pink, () => pickSub($, 'effort', '')),
            ...effortTabs('sub-effort', s.effort, level => pickSub($, 'effort', level)),
          ])}
        </Box>
        {section('Status')}
        <Box flexDirection="column" marginTop={1}>
          <Text color={status.color} wrap="truncate-end">
            {`${status.icon} ${status.text}`}
          </Text>
          <Text color={C.green} wrap="truncate-end">
            {`● Subagents (this project): ${s.model ? labelOf(s.model as Alias, model) : 'Auto'} · effort ${s.effort || 'Auto'}`}
          </Text>
          <Text color={C.muted} wrap="truncate-end">
            Forks always run as the main session.
          </Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Button key="close" label="Close" onPress={() => closePanel($)} />
          <Text color={C.muted}>Esc closes</Text>
        </Box>
      </Box>
    )
  })
}

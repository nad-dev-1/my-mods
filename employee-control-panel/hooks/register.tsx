import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alias, Level, MainPicks, SubPicks } from '../types'

// Employee Control Panel: a "Control Tools" button in the status bar opens a
// panel to switch the model and effort level of the main session (it runs
// /model and /effort for you) and of the subagents Claude starts (it rewrites
// each agent as it starts). A status line under the controls shows what is in
// force, what is waiting for Claude to finish, and what was refused.

type E$ = EngineInterface

const PANE = 'control-tools'

const MODELS: { alias: Alias; label: string }[] = [
  { alias: 'fable', label: 'Fable' },
  { alias: 'opus', label: 'Opus' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'haiku', label: 'Haiku' },
]
const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']

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

const C = {
  blue: '#58A6FF',
  blueBright: '#A5D6FF',
  ink: '#0D1117',
  sheet: '#161B22',
  green: '#3FB950',
  amber: '#E3B341',
  red: '#F85149',
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
  const modelPart = picks.model?.state === 'pending' ? cap(picks.model.value) : prettyModel(model)
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
    const r = await next(e)
    await $.command.register({ name: 'controls', description: 'Pick the model and effort for Claude and its subagents' })
    // A reload or a new session: no pane, no reply running, this project's picks.
    await update($, isOpen, () => false)
    await update($, isBusy, () => false)
    await update($, main, () => NO_PICKS)
    const stored = await $.store.get(await subKey($)).catch(() => undefined)
    await update($, sub, () => parseSub(stored))
    await redraw($)

    return r
  })

  on('command.run', { command: 'controls' }, async $ => {
    await openPanel($)

    return { text: 'Opening Control Tools.' }
  })

  // /model and /effort, typed or run by the panel: the status follows.
  // A failure here must never stand in the way of the command itself.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const r = await next(e)
    await redraw($)

    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort' }, async ($, e, next) => {
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
    const r = await next(e)
    if (!e.agentId) await update($, isBusy, () => true)

    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!(e as { agentId?: string }).agentId) {
      await update($, isBusy, () => false)
      await redraw($)
    }

    return r
  })

  // Subagent model: every agent but a fork (which always runs as the main
  // session) or a resumed one (whose model is fixed).
  on('agent.spawn', async ($, e, next) => {
    const s = await read($, sub)
    if (!s.model || e.subagentType === 'fork' || e.resume) return next(e)

    return next({ ...e, model: s.model })
  }).catch(($, e, next) => next(e))

  // Subagent effort: set on each Agent call but a fork's.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const s = await read($, sub)
    if (!s.effort || e.subagent_type === 'fork') return next(e)

    return next({ ...e, effort: s.effort as Level })
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    await update($, isOpen, () => false)

    return done
  }).catch(($, e, next) => next(e))

  // The status-bar button, with what is in force.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    await read($, tick)
    const open = await read($, isOpen)
    const picks = await read($, main)
    const s = await read($, sub)
    const model = await modelNow($)
    const fam = picks.model?.state === 'pending' ? cap(picks.model.value) : cap(familyOf(model)) || prettyModel(model)
    const effort = picks.effort?.state === 'pending' ? picks.effort.value : await effortNow($, model)
    const subText = subLabel(s)
    const label = `» Control Tools · ${fam}${effort ? ` · ${effort}` : ''}${subText ? ` · sub: ${subText}` : ''}`
    const fill = open ? C.blueBright : C.blue
    const modes = e.props.modes

    return (
      <Box flexDirection="row">
        {below ?? (modes.length > 0 ? <Text dimColor>{modes.join(' & ')}</Text> : null)}
        <Text>{'  '}</Text>
        <Button
          key="open-controls"
          plain
          onPress={async () => {
            // Opened within the press, so it counts as asked for.
            if (await read($, isOpen)) await closePanel($)
            else await openPanel($)
          }}
        >
          <Text color={fill}>▐</Text>
          <Text backgroundColor={fill} color={C.ink} bold>
            {label}
          </Text>
          <Text color={fill}>▌</Text>
        </Button>
      </Box>
    )
  })

  // The panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
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

    const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown) => (
      <Button key={key} label={label} variant={isOn ? 'primary' : 'secondary'} onPress={onPress} />
    )
    const row = (head: string, name: string, chips: ReturnType<typeof chip>[]) => (
      <Box key={`row-${head}-${name}`} flexDirection="row" flexWrap="wrap" gap={1}>
        <Text bold color={C.blue}>
          {head.padEnd(10)}
        </Text>
        <Text dimColor>{name.padEnd(7)}</Text>
        {chips}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={C.blue}>
            {'» Control Tools'}
          </Text>
          <Text dimColor>Esc closes</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {row(
            'MAIN',
            'Model',
            MODELS.map(m => chip(`main-model#${m.alias}`, m.label, pickedModel === m.alias, () => pickMain($, 'model', m.alias))),
          )}
          {row(
            '',
            'Effort',
            LEVELS.map(l => chip(`main-effort#${l}`, l, pickedEffort === l, () => pickMain($, 'effort', l))),
          )}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {row('SUBAGENTS', 'Model', [
            chip('sub-model#', 'Auto', s.model === '', () => pickSub($, 'model', '')),
            ...MODELS.map(m => chip(`sub-model#${m.alias}`, m.label, s.model === m.alias, () => pickSub($, 'model', m.alias))),
          ])}
          {row('', 'Effort', [
            chip('sub-effort#', 'Auto', s.effort === '', () => pickSub($, 'effort', '')),
            ...LEVELS.map(l => chip(`sub-effort#${l}`, l, s.effort === l, () => pickSub($, 'effort', l))),
          ])}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color={status.color} wrap="truncate-end">
            {`${status.icon} ${status.text}`}
          </Text>
          <Text color={C.green} wrap="truncate-end">
            {`● Subagents (this project): ${s.model ? cap(s.model) : 'Auto'} · effort ${s.effort || 'Auto'}`}
          </Text>
          <Text dimColor wrap="truncate-end">
            Forks always run as the main session.
          </Text>
        </Box>
        <Box flexDirection="row" marginTop={1}>
          <Button key="close" label="Close" onPress={() => closePanel($)} />
        </Box>
      </Box>
    )
  })
}

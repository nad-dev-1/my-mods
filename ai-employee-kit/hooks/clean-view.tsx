// Clean View: every `$` call lives in this file. Pure logic is in ./clean-view-logic.

import type { EngineInterface, On, PromptSubmitInput, Timer } from 'claude-code'

import type { Checklist, CleanTask } from '../types'
import {
  KEEPS_FAILING,
  NEEDS_ANSWER,
  NEEDS_OK,
  NEEDS_REPLY,
  REFUSED,
  SAID_NO,
  SYSTEM_SECTION,
  applyPlan,
  applyProgress,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodos,
  cleanTitle,
  elapsed,
  finishAll,
  fit,
  friendlyError,
  hasUnfinished,
  isRefusal,
  label,
  meter,
  nameColumns,
  namingPrompt,
  newChecklist,
  titleFromRequest,
} from './clean-view-logic'

type E$ = EngineInterface

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLAN_TOOL = 'mcp__ai-employee-kit__plan_steps'
const PROGRESS_TOOL = 'mcp__ai-employee-kit__report_progress'
const STORE_ENABLED = 'cleanViewEnabled'
const FAIL = 'Clean View could not do that just now. Nothing was changed.'

const ENABLED = { plugin: 'ai-employee-kit', key: 'cleanViewEnabled' } as const
const CHECKLIST = { plugin: 'ai-employee-kit', key: 'checklist' } as const
const TICK = { plugin: 'ai-employee-kit', key: 'tick' } as const

/** Tools the main agent may use before a plan exists. */
const ALWAYS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL, PROGRESS_TOOL])

const GATE = `Clean View: call ${PLAN_TOOL} first with 2 to 8 short plain-English step names, in order (load it with ToolSearch if it is deferred). Your to-do list (TodoWrite or TaskCreate) also works as the plan. Then try this again.`

const C = {
  green: '#3DD68C',
  amber: '#E3B341',
  gold: '#F2C46D',
  text: '#E6EDF3',
  muted: '#7D8590',
  hair: '#262B33',
  ink: '#0D1117',
} as const

// ---------------------------------------------------------------------------
// Module state: the checklist is held here and mirrored into $.state for drawing.
// ---------------------------------------------------------------------------

let enabled = true
let list: Checklist | null = null
let pendingTyped = false
let pendingCommand = false
let failures = 0
let lastError: { kind?: string; details?: string } | null = null
let animator: Timer | null = null
let frame = 0
let collapser: Timer | null = null

function mint(): string {
  return Math.random().toString(36).slice(2, 10)
}

function isTyped(e: PromptSubmitInput): boolean {
  if (e.command !== undefined || e.isMeta === true || e.turnId !== undefined) return false
  const o = e.origin as { kind: string; asUser?: boolean }
  return o.kind === 'composer' || o.kind === 'bridge' || (o.kind === 'plugin' && o.asUser === true)
}

function animate($: E$): void {
  const isLive = enabled && !!list && (list.phase === 'working' || list.phase === 'needsYou')
  if (isLive && !animator) {
    animator = $.clock.every(250, () => {
      frame += 1
      void $.state.set(TICK, frame).catch(() => undefined)
    })
  } else if (!isLive && animator) {
    animator.cancel()
    animator = null
  }
}

async function publish($: E$): Promise<void> {
  await $.state.set(CHECKLIST, list ? (JSON.parse(JSON.stringify(list)) as Checklist) : null)
  animate($)
}

async function setPhase($: E$, phase: Checklist['phase'], reason: { needsYou?: string | null; stuck?: string | null } = {}): Promise<void> {
  if (!list) return
  list = { ...list, phase, needsYouReason: reason.needsYou ?? null, stuckReason: reason.stuck ?? null }
  await publish($)
}

async function setEnabled($: E$, isOn: boolean): Promise<void> {
  enabled = isOn
  await $.state.set(ENABLED, isOn)
  await $.store.set(STORE_ENABLED, isOn)
  if (!isOn) list = null
  await publish($)
}

function scheduleCollapse($: E$, jobId: string): void {
  collapser?.cancel()
  collapser = $.clock.after(5000, () => {
    if (list && list.jobId === jobId && list.phase === 'done') {
      list = { ...list, isCollapsed: true }
      void publish($).catch(() => undefined)
    }
  })
}

async function startJob($: E$, request: string): Promise<void> {
  const jobId = mint()
  list = newChecklist(jobId, titleFromRequest(request), await $.clock.now())
  failures = 0
  lastError = null
  collapser?.cancel()
  await publish($)
  // Name the job in the background; a newer job wins.
  void (async () => {
    try {
      const reply = await $.model.complete({ model: 'haiku', prompt: namingPrompt(request), effort: 'low', maxTokens: 40, timeoutMs: 20_000 })
      if (!reply.isAnswered || !list || list.jobId !== jobId) return
      const title = cleanTitle(reply.text)
      if (title && title !== 'Working on it') {
        list = { ...list, title }
        await publish($)
      }
    } catch {
      // keep the first title
    }
  })()
}

/** A plan tool called with no job running (Clean View turned on mid-turn, a turn nobody typed). */
async function ensureJob($: E$): Promise<Checklist> {
  if (!list || list.phase === 'done' || list.phase === 'stopped') {
    list = newChecklist(mint(), 'Working on your request', await $.clock.now())
  }
  return list
}

/** A technical row shows when Clean View is off, or in the expanded (ctrl+o) view. */
async function isRowShown($: E$, isExpanded: boolean | undefined): Promise<boolean> {
  const isOn = (await $.state.get(ENABLED)).value ?? true
  return !isOn || isExpanded === true
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

type Els = { Box: any; Text: any; Button: any }

function ToggleButton($: E$, els: Els, isOn: boolean, compact: boolean): any {
  const { Button, Text } = els
  return (
    <Button
      key="clean-view-toggle"
      plain
      onPress={async () => {
        try {
          await setEnabled($, !isOn)
          $.ui.toast(!isOn ? 'Clean View is on: tool details are hidden.' : 'Clean View is off: every detail is showing.')
        } catch {
          $.ui.toast(FAIL)
        }
      }}
    >
      <Text color={C.muted}>{compact ? '[' : '[ '}</Text>
      <Text color={isOn ? C.green : C.muted}>{isOn ? '●' : '○'}</Text>
      <Text color={isOn ? C.text : C.muted}>{compact ? (isOn ? ' ON]' : ' OFF]') : isOn ? ' Clean View: ON ]' : ' Clean View: OFF ]'}</Text>
    </Button>
  )
}

function buttonWidth(isOn: boolean, compact: boolean): number {
  return compact ? (isOn ? 6 : 7) : isOn ? 20 : 21
}

function Header(els: Els, l: Checklist, now: number, room: number): any {
  const { Box, Text } = els
  if (l.phase === 'needsYou') {
    const badge = ' Needs you '
    return (
      <Box flexDirection="row">
        <Text backgroundColor={C.amber} color={C.ink} bold>{fit(badge, room)}</Text>
        <Text color={C.text}>{fit(' ' + (l.needsYouReason ?? NEEDS_REPLY), Math.max(0, room - badge.length))}</Text>
      </Box>
    )
  }
  if (l.phase === 'stuck') {
    return <Text color={C.amber}>{fit(`⚠ Stuck: ${l.stuckReason ?? 'something went wrong'}`, room)}</Text>
  }
  if (l.phase === 'stopped') {
    return <Text color={C.muted}>{fit(`■ Stopped · ${l.title} · you pressed Esc`, room)}</Text>
  }
  if (l.phase === 'done') {
    const took = elapsed((l.finishedAt ?? now) - l.startedAt)
    return (
      <Box flexDirection="row">
        <Text color={C.green} bold>{fit('✓ All done', room)}</Text>
        <Text color={C.text}>{fit(` · ${l.title} · took ${took}`, Math.max(0, room - 10))}</Text>
      </Box>
    )
  }
  const time = elapsed(now - l.startedAt)
  const head = fit(l.title, Math.max(4, room - time.length - 3))
  return (
    <Box flexDirection="row">
      <Text color={C.text} bold>{head}</Text>
      <Text color={C.muted}>{fit(` · ${time}`, Math.max(0, room - head.length))}</Text>
    </Box>
  )
}

function Row(els: Els, task: CleanTask, isFirstUpcoming: boolean, isPaused: boolean, w: number, tick: number): any {
  const { Box, Text } = els
  const nameW = nameColumns(w)
  const icon = task.status === 'done' ? '✓' : task.status === 'active' ? (isPaused ? '‖' : '▶') : '○'
  const iconColor = task.status === 'done' ? C.green : task.status === 'active' ? C.gold : C.muted
  const name = fit(task.name, nameW).padEnd(nameW)
  const m = meter(task, tick)
  const fillColor = task.status === 'done' ? C.green : C.gold
  return (
    <Box flexDirection="row">
      <Text color={iconColor}>{icon + ' '}</Text>
      <Text color={task.status === 'active' ? C.text : C.muted} bold={task.status === 'active'}>{name}</Text>
      <Text> </Text>
      {m.sweep ? (
        <Box flexDirection="row">
          {m.sweep.before ? <Text color={C.hair}>{m.sweep.before}</Text> : null}
          <Text color={C.gold}>{m.sweep.lit}</Text>
          {m.sweep.after ? <Text color={C.hair}>{m.sweep.after}</Text> : null}
        </Box>
      ) : (
        <Box flexDirection="row">
          {m.filled ? <Text color={fillColor}>{m.filled}</Text> : null}
          {m.empty ? <Text color={C.hair}>{m.empty}</Text> : null}
        </Box>
      )}
      <Text color={task.status === 'active' ? C.text : C.muted}>{'  ' + label(task, isFirstUpcoming).padEnd(7)}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCleanView(on: On): void {
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    await $.command.register({
      name: 'simple',
      description: 'Clean View: hide the technical details and show a simple checklist (on, off)',
      argumentHint: '[on | off]',
      immediate: true,
    })
    await $.tool
      .register({
        name: 'plan_steps',
        description:
          'Lay out every step of the job up front for the person\'s checklist: 2 to 8 short plain-English step names in order, each under 40 characters and starting with a verb. No file names, paths, code or tool names. The first step starts right away.',
        inputSchema: {
          type: 'object',
          properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: 'The step names, in order.' } },
          required: ['steps'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    await $.tool
      .register({
        name: 'report_progress',
        description:
          'Report progress on the current step (or, as a helper agent, on your task): the step or task name and a percent from 0 to 100. Report 100 the moment it finishes.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The step or task name, as planned.' },
            percent: { type: 'number', minimum: 0, maximum: 100, description: 'How far along it is, 0 to 100.' },
          },
          required: ['task', 'percent'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    try {
      const stored = await $.store.get(STORE_ENABLED)
      enabled = stored !== false
      await $.state.set(ENABLED, enabled)
      // A reload keeps $.state but starts the module over.
      const held = (await $.state.get(CHECKLIST)).value
      if (held && !list) list = held as Checklist
      animate($)
    } catch {
      // starts on, with no job
    }
    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    try {
      const arg = e.args.trim().toLowerCase()
      if (arg && arg !== 'on' && arg !== 'off') return { text: 'Use /simple on, /simple off, or /simple to switch.' }
      const turnOn = arg === '' ? !enabled : arg === 'on'
      await setEnabled($, turnOn)
      return { text: turnOn ? 'Clean View is on: tool details are hidden and a checklist shows above the prompt.' : 'Clean View is off: every detail is showing again.' }
    } catch {
      return { text: FAIL }
    }
  }).catch(() => ({ text: FAIL }))

  // 2. Make Claude use the plan tools.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!enabled) return composed
    return { sections: [...composed.sections, { id: 'ai-employee-kit:clean-view', text: SYSTEM_SECTION(PLAN_TOOL, PROGRESS_TOOL), scope: 'session' as const }] }
  })

  // Which turns are the person's own requests.
  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
    const result = await next(e)
    if (result.drop === undefined && e.turnId === undefined) {
      pendingTyped = isTyped(e)
      pendingCommand = e.command !== undefined
    }
    return result
  }).catch(($, e, next) => next(e))

  // 4. A new job, or the reply that continues one.
  on('turn.start', { turnId: /^/ }, async ($, e, next) => {
    if (e.agentId === undefined && enabled) {
      const isRequest = pendingTyped && !pendingCommand && e.text.trim() !== ''
      pendingTyped = false
      pendingCommand = false
      if (isRequest) {
        if (list && list.phase === 'needsYou' && hasUnfinished(list)) {
          await setPhase($, 'working')
        } else {
          await startJob($, e.text).catch(() => undefined)
        }
      } else if (list && list.phase === 'needsYou') {
        await setPhase($, 'working')
      }
    }
    return next(e)
  })

  // 3 and 4. Plan first, and fill the checklist from what Claude already does.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || !enabled || !list || list.phase === 'done' || list.phase === 'stopped') return next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (list.phase === 'needsYou' && tool !== 'AskUserQuestion') await setPhase($, 'working')
    if (!list.hasPlan && !ALWAYS.has(tool)) return { deny: GATE }
    if (tool === 'AskUserQuestion') await setPhase($, 'needsYou', { needsYou: NEEDS_ANSWER })

    const result = await next(e)
    if (!list) return result
    const ok = result.deny === undefined && result.isError !== true

    if (tool === 'AskUserQuestion' || list.phase === 'needsYou') await setPhase($, 'working')
    if (ok && tool === 'TodoWrite') list = applyTodos(list, input.todos)
    if (ok && tool === 'TaskCreate') {
      const created = (result.result as { task?: { id?: unknown } } | undefined)?.task?.id
      if (created !== undefined) list = applyTaskCreate(list, String(created), input.subject)
    }
    if (ok && tool === 'TaskUpdate') list = applyTaskUpdate(list, input as { taskId?: unknown; status?: unknown; subject?: unknown })

    if (result.deny === undefined) {
      if (result.isError === true) {
        if (isRefusal(result.text)) {
          list = { ...list, phase: 'stuck', stuckReason: SAID_NO, needsYouReason: null }
        } else {
          failures += 1
          if (failures >= 3) list = { ...list, phase: 'stuck', stuckReason: KEEPS_FAILING, needsYouReason: null }
        }
      } else {
        failures = 0
        if (list.phase === 'stuck') list = { ...list, phase: 'working', stuckReason: null }
      }
    }
    await publish($)
    return result
  }).catch(($, e, next) => next(e))

  // 1. The two tools Claude calls (helpers' calls are answered by the Agent Dock first).
  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const input = e as unknown as { steps?: unknown }
    const count = Array.isArray(input.steps) ? Math.min(8, input.steps.length) : 0
    if (enabled && e.agentId === undefined) {
      const applied = applyPlan(await ensureJob($), input.steps)
      if (applied.count === 0) return { result: 'No steps given. Call plan_steps with 2 to 8 short step names.' }
      list = applied.list
      await publish($)
      return { result: `Planned ${applied.count} steps. The first one has started.` }
    }
    return { result: count ? `Planned ${count} steps. The first one has started.` : 'No steps given.' }
  }).catch(() => ({ result: 'Planned. The first step has started.' }))

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const input = e as unknown as { task?: unknown; percent?: unknown }
    const pct = Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0)))
    if (enabled && e.agentId === undefined) {
      const applied = applyProgress(await ensureJob($), input.task, input.percent)
      list = { ...applied.list, phase: list?.phase === 'stuck' ? 'working' : (list?.phase ?? 'working'), stuckReason: null }
      await publish($)
    }
    return { result: `Progress noted: ${pct}%.` }
  }).catch(() => ({ result: 'Progress noted.' }))

  // Permission prompts: Needs you, right away.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (enabled && list && list.phase !== 'done' && list.phase !== 'stopped') await setPhase($, 'needsYou', { needsYou: NEEDS_OK }).catch(() => undefined)
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const isPermission = /permission/i.test(`${e.notification_type} ${e.message}`)
    if (isPermission && enabled && list && list.phase !== 'done' && list.phase !== 'stopped') {
      await setPhase($, 'needsYou', { needsYou: NEEDS_OK }).catch(() => undefined)
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastError = { kind: String(e.error), details: e.error_details }
    if (enabled && list && list.phase !== 'done') await setPhase($, 'stuck', { stuck: friendlyError(lastError.kind, lastError.details) }).catch(() => undefined)
    return next(e)
  })

  // How the job ended.
  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !enabled || !list || list.phase === 'done') return result
    try {
      const now = await $.clock.now()
      if (e.reason === 'error') {
        list = { ...list, phase: 'stuck', stuckReason: friendlyError(lastError?.kind, lastError?.details), needsYouReason: null, finishedAt: now }
      } else if (e.reason === 'refusal') {
        list = { ...list, phase: 'stuck', stuckReason: REFUSED, needsYouReason: null, finishedAt: now }
      } else if (e.reason === 'aborted' || e.isAborted) {
        list = { ...list, phase: 'stopped', needsYouReason: null, finishedAt: now }
      } else if (list.phase === 'stuck') {
        // keeps its reason
      } else if (hasUnfinished(list)) {
        list = { ...list, phase: 'needsYou', needsYouReason: NEEDS_REPLY }
      } else {
        list = finishAll(list, now)
        scheduleCollapse($, list.jobId)
      }
      lastError = null
      await publish($)
    } catch {
      // the band keeps its last state
    }
    return result
  })

  // 5. Hide the technical rows (ctrl+o still shows them all).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (await isRowShown($, e.props.isExpanded)) return next(e)
    const { Box } = $.ui.resolve(e) as unknown as Els
    return <Box />
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (await isRowShown($, e.props.isExpanded)) return next(e)
    const { Box } = $.ui.resolve(e) as unknown as Els
    return <Box />
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (await isRowShown($, e.props.isExpanded)) return next(e)
    const { Box } = $.ui.resolve(e) as unknown as Els
    return <Box />
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const isOn = (await $.state.get(ENABLED)).value ?? true
    return isOn ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e)
  }).catch(($, e, next) => next(e))

  // The checklist above the prompt, with the button on every screen.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e) as unknown as Els
    const { Box, Text } = els
    const w = Math.max(20, e.props.bodyColumns)
    const isOn = (await $.state.get(ENABLED)).value ?? true
    const l = (await $.state.get(CHECKLIST)).value ?? null
    const tick = (await $.state.get(TICK)).value ?? 0
    const now = await $.clock.now()
    const compact = w < 44
    const btnW = buttonWidth(isOn, compact)
    const button = ToggleButton($, els, isOn, compact)

    if (!isOn || !l) {
      return (
        <Box flexDirection="row" width={w}>
          <Text>{' '.repeat(Math.max(0, w - btnW))}</Text>
          {button}
        </Box>
      )
    }

    const room = Math.max(4, w - btnW - 1)
    const header = Header(els, l, now, room)
    const showRows = !(l.phase === 'done' && l.isCollapsed)
    const firstUpcoming = l.tasks.findIndex(t => t.status === 'upcoming')
    return (
      <Box flexDirection="column" width={w}>
        <Box flexDirection="row" width={w} justifyContent="space-between">
          {header}
          {button}
        </Box>
        {showRows ? l.tasks.map((t, i) => Row(els, t, i === firstUpcoming, l.phase === 'needsYou', w, tick)) : null}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}

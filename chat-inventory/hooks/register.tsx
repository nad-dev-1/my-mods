import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, ConnectorRow, Inventory, Plan } from '../types'
import {
  EMPTY,
  NO_PLAN,
  PROGRESS_TOOL,
  STEPS_TOOL,
  TASK_TOOLS,
  apply,
  hitsOf,
  markdownOf,
  newest,
  shownPlan,
  stepsAfter,
  tasksAfter,
  withAutoFiles,
} from './inventory-logic'
import type { Hit, Use } from './inventory-logic'
import { statusGrid } from './status-grid'
import { offCommand, offPane, switchedHidden, switchedOff, watchSwitch } from './switch'

// Chat Inventory, after "Mod #6" of Ben AI's "9 Insane Claude Mods" video:
// a side pane, In this chat, with live cards for the to-do list, the
// connectors called, the context files read, the skills, the subagents and
// the web pages this chat used. Written from scratch; the idea is his.

const PANE = 'chat-inventory'
const TITLE = 'In this chat'
/** How long a count that just went up stays lit. */
const LIGHT_MS = 4000
/** While the pane is open, the subagents are looked up this often. */
const AGENT_POLL_MS = 3000
/** Context files show this many rows at a time; Up and Down move by FILE_STEP. */
const FILE_WINDOW = 10
const FILE_STEP = 5
/** Rows a card shows before "+N more". */
const MAX_ROWS = 12
/** Calls shown under an unfolded connector. */
const MAX_CALLS_SHOWN = 8

const C = {
  accent: '#D97757',
  teal: '#39C5CF',
  good: '#3FB950',
  info: '#58A6FF',
  muted: '#7D8590',
  border: '#30363D',
  lit: '#F2C46D',
  ink: '#0D1117',
  sub: '#BC8CFF',
  cold: '#F85149',
}

/** Brand colours for the connector badges; others get one from the palette by name. */
const BRAND: Record<string, string> = {
  github: '#8B949E',
  gitlab: '#FC6D26',
  atlassian: '#2684FF',
  supabase: '#3ECF8E',
  render: '#8A05FF',
  maestro: '#6E56CF',
  mailtrap: '#22D172',
  playwright: '#2EAD33',
  'claude-docs': '#D97757',
  chrome: '#4285F4',
  'google-analytics': '#F9AB00',
  dart: '#0175C2',
  graphify: '#F59E0B',
  'terminal-browser': '#39C5CF',
  context7: '#8B5CF6',
}
const PALETTE = ['#58A6FF', '#3FB950', '#D29922', '#BC8CFF', '#F778BA', '#39C5CF', '#FFA657', '#79C0FF']

function badgeColor(key: string): string {
  if (BRAND[key]) return BRAND[key]!
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0

  return PALETTE[h % PALETTE.length]!
}

const inv = atom({ plugin: 'chat-inventory', key: 'inv' } as const, EMPTY, { shape: 'inv-v1' })
const tasksAtom = atom({ plugin: 'chat-inventory', key: 'tasks' } as const, NO_PLAN, { shape: 'plan-v1' })
const stepsAtom = atom({ plugin: 'chat-inventory', key: 'steps' } as const, NO_PLAN, { shape: 'plan-v1' })
const agentsAtom = atom({ plugin: 'chat-inventory', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-v1' })
const foldedAtom = atom({ plugin: 'chat-inventory', key: 'folded' } as const, [] as string[])
const openConnector = atom({ plugin: 'chat-inventory', key: 'openConnector' } as const, '')
const fileTop = atom({ plugin: 'chat-inventory', key: 'fileTop' } as const, 0)
const isOpenAtom = atom({ plugin: 'chat-inventory', key: 'isOpen' } as const, false)
const nowAtom = atom({ plugin: 'chat-inventory', key: 'now' } as const, 0)
const noteAtom = atom({ plugin: 'chat-inventory', key: 'note' } as const, '')

type Timer = { cancel: () => void }

// The module's own; a reload starts them over and the seed rebuilds the lists.
let home = ''
let seq = 0
const seen = new Set<string>()
let skillNames: Set<string> | null = null
let agentTimer: Timer | null = null
let planStamp = 0

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const tilde = (p: string) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
const clockTime = (ms: number) => {
  if (!ms) return ''
  const d = new Date(ms)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Recording ───────────────────────────────────────────────────────────

/** Adds what a call used; a call already counted (by its id) is skipped. */
async function record($: EngineInterface, id: string, hits: Hit[], isSub: boolean) {
  if (!hits.length) return
  if (id) {
    if (seen.has(id)) return
    seen.add(id)
  }
  const at = await $.clock.now()
  const uses: Use[] = hits.map(hit => ({ hit, seq: ++seq, at, isSub }))
  await update($, inv, list => apply(list, uses))
  // Put the light out once it has shone.
  $.clock.after(LIGHT_MS + 50, () => {
    void (async () => update($, nowAtom, () => at + LIGHT_MS + 50))()
  })
}

/** Plan tools of the main chat change the To-do card. */
async function watchPlan($: EngineInterface, tool: string, input: Record<string, unknown>, result: unknown) {
  // Strictly increasing, so two lists changed in the same millisecond still order.
  const at = (planStamp = Math.max(await $.clock.now(), planStamp + 1))
  if (TASK_TOOLS.has(tool)) {
    const cur = await read($, tasksAtom)
    const next = tasksAfter(cur, tool, input, result, at)
    if (next) await update($, tasksAtom, () => next)
  } else if (tool === STEPS_TOOL || tool === PROGRESS_TOOL) {
    const cur = await read($, stepsAtom)
    const next = stepsAfter(cur, tool, input, at)
    if (next) await update($, stepsAtom, () => next)
  }
}

/** The skills this session knows, from its context breakdown, else its commands. */
async function isSkill($: EngineInterface, name: string): Promise<boolean> {
  if (!skillNames) {
    const names = new Set<string>()
    const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
    for (const s of usage?.context.breakdown?.skills?.skillFrontmatter ?? []) names.add(s.name)
    if (!names.size) {
      const cmds = await $.command.list().catch(() => [])
      // Skills you wrote yourself are listed as your own commands.
      for (const c of cmds) if (c.source === 'user') names.add(c.name)
    }
    skillNames = names
  }

  return skillNames.has(name)
}

const SLASH_RE = /<command-name>\/?([\w:.-]+)<\/command-name>/

/**
 * Rebuilds every list from the transcript (the main chat and each subagent's),
 * so a reload or a restart counts nothing twice.
 */
async function seed($: EngineInterface) {
  seen.clear()
  seq = 0
  skillNames = null
  const main = await $.session.messages().catch(() => [])
  const uses: Use[] = []
  let tasks: Plan = NO_PLAN
  let steps: Plan = NO_PLAN
  let tick = 1
  const take = (id: string, tool: string, input: Record<string, unknown>, isSub: boolean) => {
    if (id) {
      if (seen.has(id)) return
      seen.add(id)
    }
    for (const hit of hitsOf(tool, input)) uses.push({ hit, seq: ++seq, at: 0, isSub })
  }
  for (const m of main) {
    if (m.role === 'user') {
      const name = SLASH_RE.exec(m.text ?? '')?.[1]
      if (name && name !== 'inventory' && (await isSkill($, name))) uses.push({ hit: { kind: 'skill', name }, seq: ++seq, at: 0, isSub: false })
    }
    for (const u of m.toolUses) {
      take(u.tool_use_id, u.tool, u.input, false)
      tasks = tasksAfter(tasks, u.tool, u.input, u.result, tick) ?? tasks
      steps = stepsAfter(steps, u.tool, u.input, tick) ?? steps
      tick++
      const child = (u as { agentId?: string }).agentId
      if (child) {
        const theirs = await $.session.messages({ agentId: child }).catch(() => [])
        if (Array.isArray(theirs)) for (const cm of theirs) for (const cu of cm.toolUses) take(cu.tool_use_id, cu.tool, cu.input, true)
      }
    }
  }
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  const auto = (usage?.context.breakdown?.memoryFiles ?? []).map(f => f.path)
  await update($, inv, () => withAutoFiles(apply(EMPTY, uses), auto))
  await update($, tasksAtom, () => tasks)
  await update($, stepsAtom, () => steps)
  await refreshAgents($)
}

async function refreshAgents($: EngineInterface) {
  const list = await $.agent.list().catch(() => [])
  const rows: AgentRow[] = list.map(a => ({ id: a.id, type: a.type, description: a.description, status: a.status }))
  const cur = await read($, agentsAtom)
  if (JSON.stringify(cur) !== JSON.stringify(rows)) await update($, agentsAtom, () => rows)
}

// ── The pane ────────────────────────────────────────────────────────────

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE, columns: 60 })
  await update($, isOpenAtom, () => true)
  await refreshAgents($)
  agentTimer?.cancel()
  agentTimer = $.clock.every(AGENT_POLL_MS, () => {
    void refreshAgents($)
  })
}

async function closePane($: EngineInterface) {
  agentTimer?.cancel()
  agentTimer = null
  await update($, isOpenAtom, () => false)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

async function togglePane($: EngineInterface) {
  if (await read($, isOpenAtom)) return closePane($)
  await openPane($)
}

async function copyAll($: EngineInterface, surface?: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const plan = shownPlan(await read($, tasksAtom), await read($, stepsAtom))
  const text = markdownOf(await read($, inv), plan, await read($, agentsAtom), tilde)
  const r = await $.ui.copy({ text, ...(surface ? { surface } : {}) }).catch(() => ({ isCopied: false }))
  await update($, noteAtom, () => (r.isCopied ? 'Copied the inventory as a Markdown list.' : 'Could not copy here.'))
}

async function openFile($: EngineInterface, path: string) {
  const opened = await $.process.run(['open', path]).catch(() => null)
  if (opened && opened.exitCode === 0) return
  const shown = await $.process.run(['open', '-R', path]).catch(() => null)
  if (!shown || shown.exitCode !== 0) await update($, noteAtom, () => `Could not open ${tilde(path)}.`)
}

async function toggleFold($: EngineInterface, id: string) {
  await update($, foldedAtom, f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id]))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($, 'chat-inventory', 'Chat Inventory')
    const started = await next(e)
    home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    await $.command
      .register({ name: 'inventory', description: 'Show or hide the In this chat pane: to-do, connectors, files, skills, subagents, web pages', immediate: true })
      .catch(() => undefined)
    await seed($).catch(err => update($, noteAtom, () => `The inventory could not read this chat (${errorText(err)}).`))
    if (await read($, isOpenAtom)) {
      agentTimer?.cancel()
      agentTimer = $.clock.every(AGENT_POLL_MS, () => {
        void refreshAgents($)
      })
    }

    return started
  })

  on('command.run', { command: 'inventory' }, async $ => {

    if (switchedOff()) return offCommand() /* switch-guarded */
    await togglePane($)

    return { text: (await read($, isOpenAtom)) ? 'Opened the In this chat pane.' : 'Closed the In this chat pane.' }
  })

  // A skill typed as a slash command.
  on('command.run', async ($, e, next) => {
    if (switchedOff()) return next(e) /* switch-guarded */
    const ran = await next(e)
    if (e.command !== 'inventory' && (await isSkill($, e.command).catch(() => false))) {
      await record($, '', [{ kind: 'skill', name: e.command }], false)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Every tool call, the main chat's and its subagents': it runs first, then it is counted.
  on('tool.call', async ($, e, next) => {
    if (switchedOff()) return next(e) /* switch-guarded */
    const ran = await next(e)
    if ((ran as { deny?: unknown }).deny !== undefined) return ran
    const call = e as unknown as Record<string, unknown> & { tool: string; tool_use_id?: string; agentId?: string }
    const isSub = typeof call.agentId === 'string' && call.agentId !== ''
    await record($, call.tool_use_id ?? '', hitsOf(call.tool, call), isSub)
    if (!isSub) await watchPlan($, call.tool, call, (ran as { result?: unknown }).result)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {

    if (switchedOff()) return next(e) /* switch-guarded */
    const done = await next(e)
    await refreshAgents($)

    return done
  }).catch(($, e, next) => next(e))

  // The status-bar button, in the shared grid.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (switchedOff() || switchedHidden()) return next(e) /* switch-guarded */
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const isOpen = await read($, isOpenAtom)

    return statusGrid(
      { Box, Text },
      below,
      e.props.modes,
      <Button key="open-inventory" plain onPress={() => togglePane($)}>
        <Text color={isOpen ? C.lit : C.teal}>▤ In this chat</Text>
      </Button>,
    ) as never
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {

    if (switchedOff()) return offPane($, e) /* switch-guarded */
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns)
    const inner = width - 4
    const list: Inventory = await read($, inv)
    const plan = shownPlan(await read($, tasksAtom), await read($, stepsAtom))
    const agents = await read($, agentsAtom)
    const folded = await read($, foldedAtom)
    const openKey = await read($, openConnector)
    const note = await read($, noteAtom)
    const now = Math.max(await read($, nowAtom), await $.clock.now())
    const isLit = (r: { bumpedAt: number }) => r.bumpedAt > 0 && now - r.bumpedAt < LIGHT_MS

    /** The count on a row's right: lit while it just went up. */
    const count = (r: { count: number; bumpedAt: number }, word: string) => (
      <Text {...(isLit(r) ? { backgroundColor: C.lit, color: C.ink } : {})}>
        <Text bold color={isLit(r) ? C.ink : C.accent}>{String(r.count)}</Text>
        <Text color={isLit(r) ? C.ink : C.muted}>{` ${word}${r.count === 1 ? '' : 's'}`}</Text>
      </Text>
    )
    const via = (r: { count: number; subCount: number }) =>
      r.subCount === 0 ? null : <Text color={C.sub}>{r.subCount >= r.count ? 'via subagent ' : `${r.subCount} via subagent `}</Text>
    const row = (key: string, left: unknown, right: unknown) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width={inner} gap={1}>
        <Box flexShrink={1}>{left as never}</Box>
        <Box flexShrink={0}>{right as never}</Box>
      </Box>
    )
    const none = (text: string) => <Text color={C.muted}>{text}</Text>
    const capped = <T,>(rows: readonly T[], draw: (r: T) => unknown) => {
      const more = rows.length - MAX_ROWS
      return [...rows.slice(0, MAX_ROWS).map(draw), more > 0 ? <Text key="more" color={C.muted}>{`+${more} more`}</Text> : null]
    }

    /** A card: a header that folds it (▾/▸, icon, title, count) and its body. */
    const card = (id: string, icon: string, title: string, right: string, body: unknown) => {
      const isOpen = !folded.includes(id)
      return (
        <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1} width={width}>
          {row(
            `h-${id}`,
            <Button key={`fold-${id}`} plain onPress={() => toggleFold($, id)}>
              <Text color={C.muted}>{isOpen ? '▾ ' : '▸ '}</Text>
              <Text color={C.accent}>{`${icon} `}</Text>
              <Text bold>{title}</Text>
            </Button>,
            <Text color={C.muted}>{right}</Text>,
          )}
          {isOpen ? (body as never) : null}
        </Box>
      )
    }

    // To-do
    const done = plan.steps.filter(s => s.status === 'completed').length
    const todoBody = plan.steps.length ? (
      <Box flexDirection="column">
        {plan.title ? <Text bold>{plan.title}</Text> : null}
        {plan.steps.map((s, i) => (
          <Text key={`step-${i}`} wrap="wrap">
            {s.status === 'completed' ? <Text color={C.good}>{'✓ '}</Text> : s.status === 'in_progress' ? <Text color={C.accent}>{'◐ '}</Text> : <Text color={C.muted}>{'○ '}</Text>}
            {s.status === 'completed' ? (
              <Text color={C.muted} strikethrough>
                {s.text}
              </Text>
            ) : (
              <Text bold={s.status === 'in_progress'}>{s.text}</Text>
            )}
          </Text>
        ))}
      </Box>
    ) : (
      none('No to-do list yet. Claude makes one for jobs with several steps.')
    )

    // Connectors: a badge, the name and last tool, the calls; pressed, its call list.
    const conns = newest(list.connectors)
    const callList = (c: ConnectorRow) => (
      <Box key={`calls-${c.key}`} flexDirection="column" paddingLeft={4}>
        {c.calls.slice(0, MAX_CALLS_SHOWN).map((call, i) =>
          row(
            `call-${c.key}-${i}`,
            <Text wrap="truncate-end">
              <Text>{call.tool}</Text>
              {call.summary ? <Text color={C.muted}>{`  ${call.summary}`}</Text> : null}
              {call.isSub ? <Text color={C.sub}>{'  via subagent'}</Text> : null}
            </Text>,
            <Text color={C.muted}>{clockTime(call.at)}</Text>,
          ),
        )}
        {c.calls.length > MAX_CALLS_SHOWN ? <Text color={C.muted}>{`+${c.calls.length - MAX_CALLS_SHOWN} earlier`}</Text> : null}
      </Box>
    )
    const connectorBody = conns.length
      ? capped(conns, c => (
          <Box key={`conn-${c.key}`} flexDirection="column">
            {row(
              `crow-${c.key}`,
              <Button key={`conn:${c.key}`} plain onPress={() => update($, openConnector, k => (k === c.key ? '' : c.key))}>
                <Text wrap="truncate-end">
                  <Text backgroundColor={badgeColor(c.key)} color={C.ink} bold>{` ${c.name[0]!.toUpperCase()} `}</Text>
                  <Text bold>{` ${c.name}`}</Text>
                  <Text color={C.muted}>{`  ${c.lastTool}`}</Text>
                </Text>
              </Button>,
              <Text>
                {via(c)}
                {count(c, 'call')}
              </Text>,
            )}
            {openKey === c.key ? callList(c) : null}
          </Box>
        ))
      : none('None used yet')

    // Context files: "Files read", then a window of rows with Up and Down.
    const files = newest(list.files)
    const top = Math.min(await read($, fileTop), Math.max(0, files.length - FILE_WINDOW))
    const shown = files.length > FILE_WINDOW ? files.slice(top, top + FILE_WINDOW) : files
    const fileRows = shown.map(f => {
      const cut = f.path.lastIndexOf('/')
      const name = f.path.slice(cut + 1)
      const parts = tilde(cut > 0 ? f.path.slice(0, cut) : '/').split('/').filter(Boolean)
      const folder = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || '/'
      return (
        row(
          `frow-${f.path}`,
          <Button key={`file:${f.path}`} plain onPress={() => openFile($, f.path)}>
            <Text wrap="truncate-end">
              <Text>{name}</Text>
              <Text color={C.muted}>{`  ${folder}`}</Text>
            </Text>
          </Button>,
          <Text>
            {via(f)}
            {f.auto ? <Text color={C.info}>auto</Text> : f.count > 1 || isLit(f) ? count(f, 'read') : null}
          </Text>,
        )
      )
    })
    const readCount = files.filter(f => !f.auto || f.count > 0).length
    const fileBody = files.length ? (
      <Box flexDirection="column">
        {row('fread', <Text color={C.muted}>Files read</Text>, <Text color={C.muted}>{String(readCount)}</Text>)}
        {fileRows}
        {files.length > FILE_WINDOW
          ? row(
              'fnav',
              <Text color={C.muted}>{`${top + 1} to ${top + shown.length} of ${files.length}`}</Text>,
              <Box flexDirection="row" gap={1}>
                {top === 0 ? (
                  <Text color={C.muted}>▴ Up</Text>
                ) : (
                  <Button key="files-up" plain onPress={() => update($, fileTop, () => Math.max(0, top - FILE_STEP))}>
                    <Text color={C.teal}>▴ Up</Text>
                  </Button>
                )}
                {top + FILE_WINDOW >= files.length ? (
                  <Text color={C.muted}>▾ Down</Text>
                ) : (
                  <Button key="files-down" plain onPress={() => update($, fileTop, () => Math.min(files.length - FILE_WINDOW, top + FILE_STEP))}>
                    <Text color={C.teal}>▾ Down</Text>
                  </Button>
                )}
              </Box>,
            )
          : null}
      </Box>
    ) : (
      none('None read yet')
    )

    const skills = newest(list.skills)
    const skillBody = skills.length
      ? capped(skills, s =>
          row(
            `skill-${s.name}`,
            <Text wrap="truncate-end">
              <Text color={C.accent}>/</Text>
              {s.name}
            </Text>,
            <Text>
              {via(s)}
              {count(s, 'use')}
            </Text>,
          ),
        )
      : none('None used yet')

    const agentBody = agents.length
      ? capped(agents, a => {
          const color = a.status === 'completed' ? C.good : a.status === 'failed' || a.status === 'killed' ? C.cold : a.status === 'running' || a.status === 'pending' ? C.accent : C.muted
          const word = a.status === 'completed' ? 'done' : a.status === 'killed' ? 'stopped' : a.status
          return row(
            `agent-${a.id}`,
            <Text wrap="truncate-end">
              <Text bold>{a.type}</Text>
              <Text color={C.muted}>{`  ${a.description}`}</Text>
            </Text>,
            <Text color={color}>{word}</Text>,
          )
        })
      : none('None ran yet')

    const web = newest(list.web)
    const webBody = web.length
      ? capped(web, w =>
          row(
            `web-${w.site}`,
            <Text wrap="truncate-end">
              <Text>{w.site}</Text>
              <Text color={C.muted}>{`  ${w.detail}`}</Text>
            </Text>,
            <Text>
              {via(w)}
              {count(w, 'time')}
            </Text>,
          ),
        )
      : none('None yet')

    return (
      <Box flexDirection="column" width={width}>
        {row(
          'head',
          <Text bold>{TITLE}</Text>,
          <Box flexDirection="row" gap={1}>
            <Button key="inv-copy" label="Copy" onPress={() => copyAll($, e.surface)} />
            <Button key="inv-hide" label="Hide" onPress={() => closePane($)} />
          </Box>,
        )}
        {note ? <Text color={C.muted}>{note}</Text> : null}
        {card('todo', '☷', 'To-do', plan.steps.length ? `${done} of ${plan.steps.length}` : '', todoBody)}
        {card('connectors', '⏚', 'Connectors', String(conns.length), connectorBody)}
        {card('files', '▤', 'Context files', String(files.length), fileBody)}
        {card('skills', '⚡', 'Skills', String(skills.length), skillBody)}
        {card('subagents', '⑂', 'Subagents', String(agents.length), agentBody)}
        {card('web', '⊕', 'Web pages', String(web.length), webBody)}
      </Box>
    )
  }).catch(($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text color={C.cold}>The inventory could not draw; it keeps counting and draws again on the next change.</Text>
  })
}

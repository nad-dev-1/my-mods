// Agent Dock: every `$` call lives in this file. Pure logic is in ./dock-logic.

import type { EngineInterface, On, PaneOpenArgs, PromptSubmitInput, Timer } from 'claude-code'

import type { Helper, HelperModel, Run } from '../types'
import {
  BAD_SIZE_COMMAND,
  BAD_SIZE_TOAST,
  BIG_TEAM,
  CORAL,
  GOLD,
  NARROW,
  SIZES,
  STOPPED,
  TILE_THRESHOLD,
  TILE_WIDTH,
  atOnce,
  badge,
  capDeny,
  cardsPerRow,
  clock,
  counts,
  helperPercent,
  infoLine,
  initials,
  jobName,
  meterCells,
  missionCells,
  missionPercent,
  mix,
  nudgeText,
  parseSize,
  restoreSize,
  sameTask,
  seatColor,
  spaced,
  splitInstruction,
  summary,
  taskName,
  tilesPerRow,
} from './dock-logic'
import { statusGrid } from './status-grid'

type E$ = EngineInterface

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN = 'ai-employee-kit'
const PANE = 'agent-dock'
const PROGRESS_TOOL = 'mcp__ai-employee-kit__report_progress'
const STORE_SIZE = 'size'
const STORE_MODEL = 'panel.helperModel'
const FAIL = 'Agent Dock could not do that just now. Nothing was changed.'

const SIZE = { plugin: 'ai-employee-kit', key: 'size' } as const
const PENDING = { plugin: 'ai-employee-kit', key: 'pending' } as const
const CUSTOM = { plugin: 'ai-employee-kit', key: 'customOpen' } as const
const MODEL = { plugin: 'ai-employee-kit', key: 'helperModel' } as const
const RUN = { plugin: 'ai-employee-kit', key: 'run' } as const
const TICK = { plugin: 'ai-employee-kit', key: 'dockTick' } as const
const HEADSHOTS = { plugin: 'ai-employee-kit', key: 'headshots' } as const
const AT_ONCE = { plugin: 'ai-employee-kit', key: 'atOnce' } as const
const FOLDED = { plugin: 'ai-employee-kit', key: 'folded' } as const

const PANE_OPEN: PaneOpenArgs = {
  id: PANE,
  title: 'Agent Dock',
  closeOnEscape: true,
  rows: 36,
  columns: 80,
  backgroundColor: '#0D1117',
}

const C = {
  coral: CORAL,
  gold: GOLD,
  hair: '#262B33',
  slate: '#262B33',
  muted: '#7D8590',
  text: '#E6EDF3',
  green: '#3DD68C',
  greenDim: '#1E7A52',
  greenAlt: '#2BB673',
  red: '#F85149',
  ink: '#0D1117',
} as const

// ---------------------------------------------------------------------------
// Module state: the live run is held here and mirrored into $.state for drawing.
// JavaScript runs one hook at a time between awaits, so these never race.
// ---------------------------------------------------------------------------

let run: Run | null = null
let active = 0
let limit = 10
const waiting: string[] = []
const agentOf = new Map<string, string>()
const promptOf = new Map<string, string>()
let ticker: Timer | null = null
let tickN = 0
let filePath: string | null = null
let lastFileCount = -1
/** True while the main loop's turn runs: a run finishes only after it ends. */
let mainTurnOpen = false

function mint(): string {
  return Math.random().toString(36).slice(2, 10)
}

function newRun(job: string, size: number, now: number): Run {
  return { id: mint(), job, size, startedAt: now, endedAt: null, status: 'live', helpers: [], accepted: 0, nudged: false }
}

/** Ids of queued cards an Agent call has already claimed. */
const claimed = new Set<string>()

function addHelper(r: Run, id: string, description: unknown, isCall = false): Helper {
  const found = r.helpers.find(x => x.id === id)
  if (found) {
    if (isCall) claimed.add(found.id)
    return found
  }
  const seat = r.helpers.length
  const name = taskName(typeof description === 'string' ? description : undefined, seat)
  if (isCall) {
    // The call's id may differ from the drawn block's: take the queued card of the same task.
    const twin = r.helpers.find(x => x.state === 'queued' && x.startedAt === null && !claimed.has(x.id) && x.name === name)
    if (twin) {
      twin.id = id
      claimed.add(id)
      return twin
    }
    claimed.add(id)
  }
  const helper: Helper = {
    id,
    name,
    state: 'queued',
    percent: null,
    startedAt: null,
    endedAt: null,
    seat,
  }
  r.helpers.push(helper)
  return helper
}

async function readSize($: E$): Promise<number> {
  return (await $.state.get(SIZE)).value ?? 1
}

async function readFolded($: E$): Promise<boolean> {
  return (await $.state.get(FOLDED)).value ?? false
}

async function showBadge($: E$): Promise<void> {
  if (!(await readFolded($))) {
    $.ui.status(undefined)
    return
  }
  const size = await readSize($)
  $.ui.status(run && run.helpers.length ? `◆ ${badge(counts(run.helpers))}` : `◆ Agent Dock · team of ${size} · /dock to open`)
}

async function writeCountFile($: E$): Promise<void> {
  if (!filePath) return
  const c = run ? counts(run.helpers) : { working: 0, queued: 0, done: 0, stuck: 0 }
  if (c.working === lastFileCount) return
  lastFileCount = c.working
  try {
    await $.fs.write(filePath, JSON.stringify({ agents: c.working, ...c, updatedAt: await $.clock.now() }) + '\n')
  } catch {
    // the status line goes without; the dock still works
  }
}

function animate($: E$): void {
  const isLive = !!run && run.status === 'live' && run.helpers.some(x => x.state === 'working' || x.state === 'queued')
  if (isLive && !ticker) {
    ticker = $.clock.every(600, () => {
      tickN += 1
      void $.state.set(TICK, tickN).catch(() => undefined)
    })
  } else if (!isLive && ticker) {
    ticker.cancel()
    ticker = null
  }
}

/** Mirrors the module's run into $.state (drawing reads it), the status line file and the badge. */
async function publish($: E$): Promise<void> {
  await $.state.set(RUN, run ? (JSON.parse(JSON.stringify(run)) as Run) : null)
  animate($)
  await writeCountFile($)
  await showBadge($)
}

async function setSize($: E$, n: number): Promise<void> {
  await $.state.set(SIZE, n)
  await $.state.set(PENDING, null)
  await $.state.set(CUSTOM, false)
  await $.store.set(STORE_SIZE, n)
  await showBadge($)
}

async function setFolded($: E$, folded: boolean): Promise<void> {
  await $.state.set(FOLDED, folded)
  await showBadge($)
}

async function openPane($: E$): Promise<void> {
  const opened = await $.ui.open(PANE_OPEN)
  if (opened.isPlaced) {
    await setFolded($, false)
    return
  }
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // already gone
  }
  $.ui.toast(NARROW)
  await setFolded($, true)
}

async function toggle($: E$): Promise<void> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await setFolded($, true)
    try {
      await $.ui.close({ id: PANE })
    } catch {
      // a hook kept it open
    }
  } else {
    await openPane($)
  }
}

/** The person's own request: typed (or sent as theirs by another mod), while idle, not a slash command. */
function isTyped(e: PromptSubmitInput): boolean {
  if (e.command !== undefined || e.isMeta === true || e.turnId !== undefined) return false
  const o = e.origin as { kind: string; asUser?: boolean }
  return o.kind === 'composer' || o.kind === 'bridge' || (o.kind === 'plugin' && o.asUser === true)
}

function findHelper(agentId: string, task: string): Helper | undefined {
  if (!run) return undefined
  const known = agentOf.get(agentId)
  if (known) return run.helpers.find(x => x.id === known)
  const mapped = new Set(agentOf.values())
  const open = run.helpers.filter(x => !mapped.has(x.id) && (x.state === 'working' || x.state === 'queued'))
  const byName = task ? open.find(x => sameTask(task, x.name)) : undefined
  const pick = byName ?? (open.filter(x => x.state === 'working').length === 1 ? open.find(x => x.state === 'working') : undefined)
  if (pick) agentOf.set(agentId, pick.id)
  return pick
}

async function finishIfDone($: E$, now: number): Promise<void> {
  if (!run || run.status !== 'live') return
  const c = counts(run.helpers)
  if (run.helpers.length > 0 && c.working === 0 && c.queued === 0) {
    run.status = 'complete'
    run.endedAt = now
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

type Els = { Box: any; Text: any; Button: any; Input?: any; Image?: any }

function clip(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…'
}

function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = word.length > w ? word.slice(0, w) : word
    if (!line) line = piece
    else if (line.length + 1 + piece.length <= w) line += ' ' + piece
    else {
      out.push(line)
      line = piece
    }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

/** Consecutive cells of one color as one Text. */
function runs(els: Els, cells: { ch: string; color: string; bold?: boolean }[]): any[] {
  const out: { text: string; color: string; bold?: boolean }[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last && last.color === c.color && last.bold === c.bold) last.text += c.ch
    else out.push({ text: c.ch, color: c.color, bold: c.bold })
  }
  return out.map(r => (
    <els.Text color={r.color} bold={r.bold}>{r.text}</els.Text>
  ))
}

type Chip = { key: string; label: string; tone: 'picked' | 'gold' | 'slate' | 'plain' | 'quiet'; onPress: () => unknown }

function chipW(c: Chip): number {
  return c.tone === 'quiet' ? c.label.length : c.label.length + 2
}

function ChipEl(els: Els, c: Chip): any {
  const { Button, Text } = els
  if (c.tone === 'quiet') {
    return (
      <Button key={c.key} plain onPress={c.onPress}>
        <Text color={C.muted}>{c.label}</Text>
      </Button>
    )
  }
  const bg = c.tone === 'picked' ? C.coral : c.tone === 'gold' ? C.gold : c.tone === 'slate' ? C.slate : undefined
  const fg = c.tone === 'picked' || c.tone === 'gold' ? C.ink : C.text
  return (
    <Button key={c.key} plain onPress={c.onPress}>
      <Text backgroundColor={bg} color={fg} bold={c.tone === 'picked' || c.tone === 'gold'}>{` ${c.label} `}</Text>
    </Button>
  )
}

/** Chips laid in rows no wider than `w`, `gap` cells apart. */
function ChipRows(els: Els, chips: Chip[], w: number, gap = 1): any {
  const { Box, Text } = els
  const rows: Chip[][] = []
  let row: Chip[] = []
  let used = 0
  for (const c of chips) {
    const cw = chipW(c)
    const need = row.length ? used + gap + cw : cw
    if (row.length && need > w) {
      rows.push(row)
      row = [c]
      used = cw
    } else {
      row.push(c)
      used = need
    }
  }
  if (row.length) rows.push(row)
  return (
    <Box flexDirection="column">
      {rows.map(r => (
        <Box flexDirection="row">
          {r.flatMap((c, i) => (i === 0 ? [ChipEl(els, c)] : [<Text>{' '.repeat(gap)}</Text>, ChipEl(els, c)]))}
        </Box>
      ))}
    </Box>
  )
}

function Masthead(els: Els, w: number, status: 'live' | 'complete' | 'idle', tick: number): any {
  const { Box, Text } = els
  const wide = w >= 64
  const word = wide ? spaced('Agent Dock') : 'AGENT DOCK'
  const right = status === 'live' ? (wide ? '● L I V E' : '● LIVE') : status === 'complete' ? (wide ? 'C O M P L E T E' : 'COMPLETE') : wide ? 'S T A N D I N G   B Y' : 'STANDING BY'
  const left = 3 + word.length
  const showRight = left + 2 + right.length <= w
  const gap = Math.max(0, w - left - (showRight ? right.length : 0))
  const letters = word.split('').map((ch, i) => ({ ch, color: mix(C.coral, C.gold, i / Math.max(1, word.length - 1)), bold: true }))
  const liveColor = tick % 2 === 0 ? C.green : C.greenDim
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={C.coral} bold>{'◆  '}</Text>
        {runs(els, letters)}
        <Text>{' '.repeat(gap)}</Text>
        {showRight && status === 'live' ? (
          <Box flexDirection="row">
            <Text color={liveColor}>{'● '}</Text>
            <Text color={C.green} bold>{right.slice(2)}</Text>
          </Box>
        ) : null}
        {showRight && status === 'complete' ? <Text color={C.green} bold>{right}</Text> : null}
        {showRight && status === 'idle' ? <Text color={C.muted}>{right}</Text> : null}
      </Box>
      <Text color={C.hair} wrap="truncate">{'─'.repeat(w)}</Text>
    </Box>
  )
}

function TeamSize($: E$, els: Els, size: number, customOpen: boolean, w: number): any {
  const { Box, Text } = els
  const label = w >= 60 ? spaced('Team Size') : 'TEAM SIZE'
  const sizeChips: Chip[] = SIZES.map(n => ({
    key: `size-${n}`,
    label: String(n),
    tone: n === size ? 'picked' : 'plain',
    onPress: () => pickSize($, n),
  }))
  const isCustomSize = !SIZES.includes(size)
  const custom: Chip = {
    key: 'size-custom',
    label: isCustomSize ? `Custom ${size}` : 'Custom',
    tone: isCustomSize ? 'picked' : customOpen ? 'slate' : 'plain',
    onPress: async () => {
      try {
        await $.state.set(CUSTOM, !customOpen)
      } catch {
        // next press tries again
      }
    },
  }
  const sizesW = sizeChips.reduce((n, c) => n + chipW(c), 0)
  const controlW = 2 + sizesW + 3 + chipW(custom) + 2
  const oneLine = label.length + 3 + controlW <= w
  const control =
    controlW <= w ? (
      <Box flexDirection="row">
        <Text color={C.hair}>{'╭ '}</Text>
        {sizeChips.map(c => ChipEl(els, c))}
        <Text color={C.hair}>{' │ '}</Text>
        {ChipEl(els, custom)}
        <Text color={C.hair}>{' ╮'}</Text>
      </Box>
    ) : (
      ChipRows(els, [...sizeChips, custom], w, 0)
    )
  return (
    <Box flexDirection={oneLine ? 'row' : 'column'} marginTop={1}>
      <Text color={C.muted}>{oneLine ? label + '   ' : label}</Text>
      {control}
    </Box>
  )
}

async function pickSize($: E$, n: number): Promise<void> {
  try {
    if (n > BIG_TEAM) {
      await $.state.set(PENDING, n)
      await $.state.set(CUSTOM, false)
    } else {
      await setSize($, n)
    }
  } catch {
    $.ui.toast(FAIL)
  }
}

function Info(els: Els, size: number, together: number, model: HelperModel, w: number): any {
  const parts = infoLine(size, together, model)
  const line = parts.join('  ·  ')
  return (
    <els.Box flexDirection="column">
      {wrap(line, w).map(l => (
        <els.Text color={C.muted} wrap="truncate">{l}</els.Text>
      ))}
    </els.Box>
  )
}

function CustomBox($: E$, els: Els, w: number): any {
  const { Box, Text, Input } = els
  if (!Input) return <Text color={C.muted} wrap="truncate">{clip('Type /dock 25 to pick a custom size.', w)}</Text>
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.hair} paddingX={1} width={Math.min(w, 44)} marginTop={1}>
      <Text color={C.text} wrap="truncate">How many helpers?</Text>
      <Input
        key="custom-size"
        placeholder="1 to 100"
        submitLabel="set"
        autoFocus
        onSubmit={async (value: string) => {
          const n = parseSize(value)
          if (n === null) {
            $.ui.toast(BAD_SIZE_TOAST)
            return
          }
          await pickSize($, n)
        }}
      />
    </Box>
  )
}

function BigTeam($: E$, els: Els, n: number, w: number): any {
  const { Box, Text } = els
  const inner = Math.max(8, w - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.gold} paddingX={1} width={w} marginTop={1}>
      {wrap('Big team: this uses your plan quickly. Continue?', inner).map(l => (
        <Text color={C.gold} bold wrap="truncate">{l}</Text>
      ))}
      <Box marginTop={1}>
        {ChipRows(
          els,
          [
            { key: 'big-continue', label: `Continue with ${n}`, tone: 'gold', onPress: () => setSize($, n).catch(() => $.ui.toast(FAIL)) },
            { key: 'big-cancel', label: 'Cancel', tone: 'quiet', onPress: () => $.state.set(PENDING, null).catch(() => undefined) },
          ],
          inner,
          2,
        )}
      </Box>
    </Box>
  )
}

function ModelRow($: E$, els: Els, model: HelperModel, w: number): any {
  const { Box, Text } = els
  const label = 'Helper agents'
  const chips: Chip[] = [
    { key: 'model-fast', label: 'Fast & Cheap', tone: model === 'fast' ? 'picked' : 'plain', onPress: () => setModel($, 'fast') },
    { key: 'model-same', label: 'Same as me', tone: model === 'same' ? 'picked' : 'plain', onPress: () => setModel($, 'same') },
  ]
  const chipsW = chips.reduce((n, c) => n + chipW(c), 0) + 1
  const oneLine = label.length + 3 + chipsW <= w
  return (
    <Box flexDirection={oneLine ? 'row' : 'column'} marginTop={1}>
      <Text color={C.muted}>{oneLine ? label + '   ' : label}</Text>
      {ChipRows(els, chips, w)}
    </Box>
  )
}

async function setModel($: E$, model: HelperModel): Promise<void> {
  try {
    await $.state.set(MODEL, model)
    await $.store.set(STORE_MODEL, model)
  } catch {
    $.ui.toast(FAIL)
  }
}

function Mission(els: Els, r: Run, now: number, tick: number, w: number): any {
  const { Box, Text } = els
  const label = w >= 60 ? spaced('Mission') : 'MISSION'
  const pct = `${missionPercent(r)}%`
  const time = clock((r.endedAt ?? now) - r.startedAt)
  const right = `${pct.padStart(4)}   ${time}`
  const jobRoom = Math.max(4, w - label.length - 3 - right.length - 2)
  const job = clip(r.job, jobRoom)
  const gap = Math.max(1, w - label.length - 3 - job.length - right.length)

  const cells = missionCells(r, w)
  const bar: { ch: string; color: string }[] = []
  // Done: a coral-to-gold sweep, in eight color steps so the row stays a few Texts.
  for (let i = 0; i < cells.done; i++) bar.push({ ch: '━', color: mix(C.coral, C.gold, Math.floor((i / Math.max(1, w - 1)) * 8) / 8) })
  for (let i = 0; i < cells.working; i++) bar.push({ ch: '━', color: (i + tick) % 4 < 2 ? C.green : C.greenAlt })
  for (let i = 0; i < cells.rest; i++) bar.push({ ch: '─', color: C.hair })

  const c = counts(r.helpers)
  const full = [
    { text: `● ${c.working} working`, color: C.green },
    { text: `○ ${c.queued} queued`, color: C.muted },
    { text: `✓ ${c.done} done`, color: C.gold },
    { text: `✕ ${c.stuck} stuck`, color: c.stuck ? C.red : C.muted },
  ]
  const fullW = full.reduce((n, p) => n + p.text.length, 0) + 4 * 3
  const parts = fullW <= w ? full : full.map(p => ({ ...p, text: p.text.replace(/ (working|queued|done|stuck)$/, '').replace(' ', '') }))
  const sep = fullW <= w ? '    ' : ' '

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={C.muted}>{label + '   '}</Text>
        <Text color={C.text} bold wrap="truncate">{job}</Text>
        <Text>{' '.repeat(gap)}</Text>
        <Text color={C.text}>{right}</Text>
      </Box>
      <Box flexDirection="row">{runs(els, bar)}</Box>
      <Box flexDirection="row">
        {parts.flatMap((p, i) => {
          const el = <Text color={p.color}>{p.text}</Text>
          return i === 0 ? [el] : [<Text>{sep}</Text>, el]
        })}
      </Box>
      {r.status === 'complete' && r.helpers.length < r.size ? (
        <Text color={C.muted} wrap="truncate">{clip(`${r.helpers.length} of ${r.size} helpers launched`, w)}</Text>
      ) : null}
      {r.status === 'live' && r.helpers.length === 0 ? (
        <Text color={C.muted} wrap="truncate">{clip('Waiting for Claude to split the work…', w)}</Text>
      ) : null}
    </Box>
  )
}

function Face(els: Els, x: Helper, headshot: string | undefined, isTerminal: boolean): any {
  const { Box, Text, Image } = els
  const ini = initials(x.name)
  if (headshot && isTerminal && Image) {
    return <Image key={`face-${x.id}`} source={{ file: headshot, format: 'png' }} columns={4} rows={2} alt={ini} />
  }
  const isQueued = x.state === 'queued'
  return (
    <Box flexDirection="column">
      <Text backgroundColor={isQueued ? C.slate : seatColor(x.seat)} color={isQueued ? C.muted : C.ink} bold>{` ${ini} `}</Text>
      <Text>{'    '}</Text>
    </Box>
  )
}

function meterRow(els: Els, x: Helper, barW: number, tick: number): any[] {
  if (x.state === 'queued') return runs(els, [{ ch: '─'.repeat(barW), color: C.hair }])
  if (x.state === 'working' && x.percent === null) {
    // Not reported yet: a short bright sweep that moves across the track.
    const pos = (tick % (barW + 3)) - 3
    const cells = Array.from({ length: barW }, (_, i) => ({ ch: i >= pos && i < pos + 3 ? '━' : '─', color: i >= pos && i < pos + 3 ? C.green : C.hair }))
    return runs(els, cells)
  }
  const pct = helperPercent(x)
  const filled = meterCells(pct, barW)
  const color = x.state === 'done' ? C.gold : x.state === 'stuck' ? C.red : C.green
  return runs(els, [
    { ch: '━'.repeat(filled), color },
    { ch: '─'.repeat(barW - filled), color: C.hair },
  ].filter(c => c.ch.length > 0))
}

function Card(els: Els, x: Helper, cardW: number, now: number, tick: number, headshot: string | undefined, isTerminal: boolean): any {
  const { Box, Text } = els
  const inner = Math.max(10, cardW - 4)
  const textW = inner - 5
  const isQueued = x.state === 'queued'
  const timer = x.startedAt === null ? '' : clock((x.endedAt ?? now) - x.startedAt)
  const timerW = timer ? Math.max(4, timer.length) : 0
  const nameW = Math.max(3, textW - (timerW ? 1 + timerW : 0))
  const name = clip(x.name, nameW).padEnd(nameW)
  const pctLabel =
    x.state === 'queued' ? '    ' : x.state === 'stuck' ? 'stuck'.slice(0, 4).padStart(4) : x.percent === null && x.state === 'working' ? '  ··' : `${helperPercent(x)}%`.padStart(4)
  const barW = Math.max(1, textW - 5)
  return (
    <Box
      key={`card-${x.id}`}
      flexDirection="row"
      borderStyle="round"
      borderColor={x.state === 'stuck' ? C.red : C.hair}
      hover={{ borderColor: C.coral }}
      paddingX={1}
      width={cardW}
    >
      {Face(els, x, headshot, isTerminal)}
      <Text> </Text>
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={isQueued ? C.muted : C.text} bold={!isQueued} wrap="truncate">{name}</Text>
          {timerW ? <Text color={C.muted}>{' ' + timer.padStart(timerW)}</Text> : null}
        </Box>
        <Box flexDirection="row">
          {meterRow(els, x, barW, tick)}
          <Text color={x.state === 'stuck' ? C.red : isQueued ? C.muted : C.text}>{' ' + pctLabel}</Text>
        </Box>
      </Box>
    </Box>
  )
}

function Cards(els: Els, r: Run, w: number, now: number, tick: number, headshots: string[], isTerminal: boolean): any {
  const { Box, Text } = els
  const perRow = cardsPerRow(w)
  const cardW = Math.floor((w - (perRow - 1)) / perRow)
  const rows: Helper[][] = []
  for (let i = 0; i < r.helpers.length; i += perRow) rows.push(r.helpers.slice(i, i + perRow))
  const shot = (x: Helper) => (headshots.length ? headshots[x.seat % headshots.length] : undefined)
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map(row => (
        <Box flexDirection="row">
          {row.flatMap((x, i) => {
            const card = Card(els, x, cardW, now, tick, shot(x), isTerminal)
            return i === 0 ? [card] : [<Text> </Text>, card]
          })}
        </Box>
      ))}
    </Box>
  )
}

function Tile(els: Els, x: Helper, tick: number): any {
  const { Box, Text } = els
  const ini = initials(x.name)
  const bg = x.state === 'queued' ? C.slate : x.state === 'stuck' ? C.red : seatColor(x.seat)
  const fg = x.state === 'queued' ? C.muted : C.ink
  const barW = TILE_WIDTH - 2
  return (
    <Box key={`tile-${x.id}`} flexDirection="column" width={TILE_WIDTH}>
      <Text backgroundColor={bg} color={fg} bold>{` ${ini}`.padEnd(TILE_WIDTH)}</Text>
      <Box flexDirection="row">
        <Text> </Text>
        {meterRow(els, x, barW, tick)}
        <Text> </Text>
      </Box>
    </Box>
  )
}

function Tiles(els: Els, r: Run, w: number, tick: number): any {
  const { Box, Text } = els
  const perRow = tilesPerRow(w)
  const rows: Helper[][] = []
  for (let i = 0; i < r.helpers.length; i += perRow) rows.push(r.helpers.slice(i, i + perRow))
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map(row => (
        <Box flexDirection="row">
          {row.flatMap((x, i) => (i === 0 ? [Tile(els, x, tick)] : [<Text> </Text>, Tile(els, x, tick)]))}
        </Box>
      ))}
    </Box>
  )
}

function Summary(els: Els, r: Run, w: number): any {
  const { Box, Text } = els
  const inner = Math.max(8, w - 4)
  return (
    <Box key="summary" flexDirection="column" borderStyle="round" borderColor={C.green} paddingX={1} width={w} marginTop={1}>
      {wrap(summary(r), inner - 2).map((l, i) => (
        <Box flexDirection="row">
          <Text color={C.green} bold>{i === 0 ? '✓ ' : '  '}</Text>
          <Text color={C.text} wrap="truncate">{l}</Text>
        </Box>
      ))}
    </Box>
  )
}

function Idle(els: Els, size: number, w: number): any {
  const { Box, Text } = els
  const seats = Math.min(size, 25, Math.max(1, Math.floor((w + 1) / 2)))
  // A still twinkle: every third seat brighter. No timer runs while idle.
  const cells = Array.from({ length: seats }, (_, i) => ({ ch: i === 0 ? '●' : ' ●', color: i % 3 === 0 ? seatColor(i) : mix(seatColor(i), C.ink, 0.45) }))
  const line1 = `Your team of ${size} is standing by`
  const line2 = size <= 1 ? 'Send a request and Claude decides how many helpers to use.' : `Send a request and it splits across ${size} helpers.`
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">{runs(els, cells)}</Box>
      <Box flexDirection="column" marginTop={1}>
        {wrap(line1, w).map(l => (
          <Text color={C.text} bold wrap="truncate">{l}</Text>
        ))}
        {wrap(line2, w).map(l => (
          <Text color={C.muted} wrap="truncate">{l}</Text>
        ))}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDock(on: On): void {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dock',
      description: 'Agent Dock: open or fold the dock, or set the Team Size (/dock 10)',
      argumentHint: '[team size 1-100]',
      immediate: true,
    })
    // report_progress is registered by Clean View, which owns it; the dock answers helpers' calls.

    try {
      await $.state.set(SIZE, restoreSize(await $.store.get(STORE_SIZE)))
      await $.state.set(MODEL, (await $.store.get(STORE_MODEL)) === 'same' ? 'same' : 'fast')
      limit = atOnce(await $.env.get('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'), await $.env.get('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'))
      await $.state.set(AT_ONCE, limit)

      const home = await $.env.get('HOME')
      const sessionId = await $.session.id().catch(() => 'session')
      if (home) filePath = `${home}/.claude/ai-employee-kit-data/agents-now/${sessionId}.json`

      const shots: string[] = []
      for (const dir of [`${$.plugin.root}/employee-headshots`, home ? `${home}/.claude/ai-employee-kit-data/employee-headshots` : '']) {
        if (!dir) continue
        try {
          for (const f of await $.fs.list(dir)) if (/\.png$/i.test(f.name)) shots.push(`${dir}/${f.name}`)
        } catch {
          // no such folder: badges instead
        }
      }
      shots.sort()
      await $.state.set(HEADSHOTS, shots)

      // A reload keeps $.state but starts the module over: pick the run back up.
      const held = (await $.state.get(RUN)).value
      if (held && !run) run = held as Run
      lastFileCount = -1
      await publish($)
    } catch {
      // the dock starts idle
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = null
    if (filePath) await $.fs.write(filePath, JSON.stringify({ agents: 0, working: 0, queued: 0, done: 0, stuck: 0 }) + '\n').catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'dock' }, ($, e) => {
    try {
      const arg = e.args.trim()
      if (arg) {
        const n = parseSize(arg)
        if (n === null) return { text: BAD_SIZE_COMMAND }
        if (n > BIG_TEAM) {
          void (async () => {
            try {
              await $.state.set(PENDING, n)
              await openPane($)
            } catch {
              $.ui.toast(FAIL)
            }
          })()
          return { text: `Confirm the team of ${n} in the Agent Dock.` }
        }
        void setSize($, n).catch(() => $.ui.toast(FAIL))
        return { text: n === 1 ? 'Team Size is 1: Claude decides how many helpers.' : `Team Size is ${n}: each request splits across ${n} helpers.` }
      }
      void toggle($).catch(() => $.ui.toast(FAIL))
      return { text: 'Agent Dock: switching between the pane and the status-bar badge.' }
    } catch {
      return { text: FAIL }
    }
  }).catch(() => ({ text: FAIL }))

  // 1. Tell Claude to split the work.
  on('prompt.submit', async ($, e, next) => {
    const o = e.origin as { kind: string; name?: string }
    if (o.kind === 'plugin' && o.name === PLUGIN) return next(e) // the dock's own nudge
    if (!isTyped(e)) return next(e)
    const size = await readSize($)
    const withSplit = size > 1 ? { ...e, context: [...(e.context ?? []), splitInstruction(size, PROGRESS_TOOL)] } : e
    const result = await next(withSplit)
    if (result.drop === undefined) {
      run = newRun(jobName(e.text), size, await $.clock.now())
      mainTurnOpen = true
      agentOf.clear()
      promptOf.clear()
      claimed.clear()
      await publish($)
    }
    return result
  }).catch(($, e, next) => next(e))

  // 4. Queued cards as soon as Claude writes the Agent calls.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && run && run.status === 'live') {
      const blocks = (Array.isArray(e.message.content) ? e.message.content : []) as { type?: string; id?: string; name?: string; input?: { description?: unknown } }[]
      let added = false
      for (const b of blocks) {
        if (b.type !== 'tool_use' || b.name !== 'Agent' || !b.id) continue
        if (run.size > 1 && run.helpers.length >= run.size && !run.helpers.some(x => x.id === b.id)) continue
        if (!run.helpers.some(x => x.id === b.id)) {
          addHelper(run, b.id, b.input?.description)
          added = true
        }
      }
      if (added) await publish($)
    }
    return stored
  }).catch(($, e, next) => next(e))

  // 2 and 3. Cap at Team Size, force the helper model, and hold calls past the engine's limit.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // a helper's own helpers are not the team
    const input = e as unknown as { tool_use_id: string; description?: string; prompt?: string; model?: string }
    const now = await $.clock.now()
    if (!run || run.status === 'complete') run = newRun(jobName(input.description ?? 'Helpers at work'), await readSize($), now)
    const r = run
    if (r.size > 1 && r.accepted >= r.size) return { deny: capDeny(r.size) }
    r.accepted += 1
    const helper = addHelper(r, input.tool_use_id, input.description, true)
    if (typeof input.prompt === 'string') promptOf.set(helper.id, input.prompt)
    await publish($)

    const model = (await $.state.get(MODEL)).value ?? 'fast'
    const sent = model === 'fast' && r.size > 1 && !input.model ? { ...e, model: 'haiku' as const } : e

    waiting.push(helper.id)
    try {
      while (active >= limit || waiting[0] !== helper.id) {
        if (next.signal.aborted) {
          r.helpers = r.helpers.filter(x => x.id !== helper.id)
          r.accepted -= 1
          await publish($)
          return { deny: STOPPED }
        }
        await $.process.run(['/bin/sleep', '1'])
      }
    } finally {
      const at = waiting.indexOf(helper.id)
      if (at >= 0) waiting.splice(at, 1)
    }

    active += 1
    helper.state = 'working'
    helper.startedAt = await $.clock.now()
    await publish($)
    let result: Awaited<ReturnType<typeof next>> | undefined
    try {
      result = await next(sent)
    } finally {
      active -= 1
      const end = await $.clock.now()
      const failed = !result || result.deny !== undefined || result.isError === true
      if (result && result.deny !== undefined) {
        // Refused before it ran (another mod's rule): it never launched, so it is no helper.
        r.helpers = r.helpers.filter(x => x.id !== helper.id)
        r.accepted = Math.max(0, r.accepted - 1)
      }
      helper.state = failed ? 'stuck' : 'done'
      helper.endedAt = end
      if (!failed) helper.percent = 100
      if (!mainTurnOpen) await finishIfDone($, end).catch(() => undefined)
      await publish($).catch(() => undefined)
    }
    return result
  }).catch(($, e, next) => next(e))

  // 4. Helpers' progress moves their meters.
  on('tool.call', { tool: PROGRESS_TOOL, agentId: /./ }, async ($, e) => {
    const input = e as unknown as { task?: unknown; percent?: unknown; agentId?: string }
    const pct = Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0)))
    if (input.agentId !== undefined && run) {
      const helper = findHelper(input.agentId, typeof input.task === 'string' ? input.task : '')
      if (helper && (helper.state === 'working' || helper.state === 'queued')) {
        helper.percent = pct
        if (helper.state === 'queued') helper.state = 'working'
        await publish($)
      }
    }
    return { result: `Progress noted: ${pct}%.` }
  }).catch(() => ({ result: 'Progress noted.' }))

  // Helpers skip Clean View's plan.
  on('tool.call', { tool: /plan_steps$/, agentId: /./ }, async ($, e, next) => {
    if (e.agentId !== undefined) return { result: 'Helpers skip the plan. Just call report_progress as you work.' }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Which helper is which: a helper's first turn starts with its Agent call's prompt.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainTurnOpen = true
    if (e.agentId !== undefined && run && !agentOf.has(e.agentId)) {
      for (const [id, text] of promptOf) {
        if (text === e.text) {
          agentOf.set(e.agentId, id)
          break
        }
      }
    }
    return next(e)
  })

  // 2. The nudge, and the summary once every helper is back.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) mainTurnOpen = false
    if (e.agentId !== undefined || !run || run.status !== 'live') return result
    const r = run
    const c = counts(r.helpers)
    if (e.reason === 'answer' && r.size > 1 && !r.nudged && r.accepted < r.size) {
      r.nudged = true
      await publish($)
      void $.prompt.submit({ text: nudgeText(r.accepted, r.size) }).catch(() => undefined)
      return result
    }
    if (c.working === 0 && c.queued === 0) {
      if (r.helpers.length === 0) run = null
      else await finishIfDone($, await $.clock.now())
      await publish($)
    }
    return result
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') await setFolded($, true).catch(() => undefined)
    return closed
  }).catch(($, e, next) => next(e))

  // The ◆ Dock button in the status bar, beside whatever is drawn there.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e) as unknown as Els
    const below = await next(e)
    const modes = e.props.modes
    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-agent-dock"
          plain
          onPress={async () => {
            try {
              await openPane($)
            } catch {
              $.ui.toast(FAIL)
            }
          }}
        >
          <Text color={C.coral}>◆ Dock</Text>
        </Button>,
      undefined,
      e.viewport?.columns,
    ) as never
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const { Box } = els
    const w = Math.max(24, e.props.bodyColumns)
    const size = (await $.state.get(SIZE)).value ?? 1
    const pending = (await $.state.get(PENDING)).value ?? null
    const customOpen = (await $.state.get(CUSTOM)).value ?? false
    const model = (await $.state.get(MODEL)).value ?? 'fast'
    const r = (await $.state.get(RUN)).value ?? null
    const tick = (await $.state.get(TICK)).value ?? 0
    const headshots = (await $.state.get(HEADSHOTS)).value ?? []
    const together = (await $.state.get(AT_ONCE)).value ?? 10
    const now = await $.clock.now()
    const status = r && r.status === 'live' && r.helpers.length > 0 ? 'live' : r && r.status === 'complete' ? 'complete' : 'idle'
    const hasRun = !!r && (r.helpers.length > 0 || r.status === 'live')
    return (
      <Box flexDirection="column" width={w}>
        {Masthead(els, w, status, tick)}
        {TeamSize($, els, size, customOpen, w)}
        {Info(els, size, together, model, w)}
        {pending !== null ? BigTeam($, els, pending, w) : null}
        {customOpen ? CustomBox($, els, w) : null}
        {ModelRow($, els, model, w)}
        {hasRun && r ? Mission(els, r, now, tick, w) : null}
        {hasRun && r && r.helpers.length > 0
          ? r.helpers.length > TILE_THRESHOLD
            ? Tiles(els, r, w, tick)
            : Cards(els, r, w, now, tick, headshots, e.surface === 'terminal')
          : null}
        {r && r.status === 'complete' ? Summary(els, r, w) : null}
        {!hasRun ? Idle(els, size, w) : null}
      </Box>
    )
  }).catch(($, e) => {
    const { Box, Text } = $.ui.resolve(e) as unknown as Els
    return (
      <Box flexDirection="column">
        <Text color={C.red}>Agent Dock could not draw this view.</Text>
        <Text color={C.text}>Your helpers keep working. Type /dock twice to redraw.</Text>
      </Box>
    )
  })
}

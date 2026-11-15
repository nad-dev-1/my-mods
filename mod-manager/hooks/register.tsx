import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModFilter, ModInfo } from '../types'

const PANE = 'mod-manager'
const TITLE = 'Mods'

// Change the shape tag when ModInfo's fields change: it declines what an
// earlier version stored, which outlives a reload.
const mods = atom({ plugin: 'mod-manager', key: 'mods' } as const, [], {
  shape: 'mods-3',
})
const note = atom({ plugin: 'mod-manager', key: 'note' } as const, '')
const busy = atom({ plugin: 'mod-manager', key: 'busy' } as const, '')
const isReloadPending = atom(
  { plugin: 'mod-manager', key: 'isReloadPending' } as const,
  false,
)
const filter = atom(
  { plugin: 'mod-manager', key: 'filter' } as const,
  'all' as ModFilter,
)
const query = atom({ plugin: 'mod-manager', key: 'query' } as const, '')
const cursor = atom({ plugin: 'mod-manager', key: 'cursor' } as const, '')
const collapsed = atom(
  { plugin: 'mod-manager', key: 'collapsed' } as const,
  [] as string[],
)
const isSheetOpen = atom(
  { plugin: 'mod-manager', key: 'isSheetOpen' } as const,
  false,
)

/** Colours: violet for the button (the Dock's is coral), green/grey switches. */
const C = {
  violet: '#A371F7',
  violetBright: '#C9A8FF',
  ink: '#0D1117',
  sheet: '#161B22',
  on: '#2EA043',
  off: '#30363D',
  knob: '#FFFFFF',
  muted: '#7D8590',
  yellow: '#D29922',
}

/**
 * A switch is this many cells wide, on or off, so the rows line up. As in
 * the Employee Control Panel video: a filled green "● On", a plain "○ Off".
 */
const SWITCH = {
  on: ' ● On  ',
  off: ' ○ Off ',
  busy: '  ···  ',
} as const
const SWITCH_WIDTH = 7

const HELP = [
  'Usage:',
  '  /mods                 open the Mods panel (j/k move, t toggles, Enter too)',
  '  /mods list            print every mod and its status',
  '  /mods status <name>   show one mod',
  '  /mods enable <name>   turn a mod on',
  '  /mods disable <name>  turn a mod off',
  '  /mods toggle <name>   flip a mod',
  '  /mods reload          apply changes to this session (/reload-plugins)',
  '<name> is the full id (name@marketplace) or the part before the @.',
].join('\n')

type CliEntry = {
  id?: unknown
  scope?: unknown
  version?: unknown
  enabled?: unknown
  projectPath?: unknown
  installPath?: unknown
  readFromFolder?: unknown
}

/** The first sentence of a description, for a one-line row. */
function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const end = one.search(/[.!?](\s|$)/)

  return end > 0 ? one.slice(0, end) : one
}

/** The mod's own description, from the manifest in its folder; '' when none. */
async function descriptionOf($: EngineInterface, entry: CliEntry): Promise<string> {
  const folders = [entry.readFromFolder, entry.installPath].filter((f): f is string => typeof f === 'string' && f !== '')
  for (const folder of folders) {
    try {
      const manifest = JSON.parse(String(await $.fs.read(`${folder}/.claude-plugin/plugin.json`))) as { description?: unknown }
      if (typeof manifest.description === 'string') return firstSentence(manifest.description)
    } catch {
      // no manifest there: try the next folder
    }
  }

  return ''
}

/** The session's folder: local- and project-scope installs elsewhere are hidden. */
let sessionCwd = ''

async function claudeCli($: EngineInterface, args: readonly string[]) {
  return $.process.run(['claude', 'plugin', ...args], { timeoutMs: 60_000 })
}

function belongsHere(entry: CliEntry): boolean {
  if (typeof entry.projectPath !== 'string' || sessionCwd === '') return true
  const root = entry.projectPath.replace(/\/+$/, '')

  return sessionCwd === root || sessionCwd.startsWith(`${root}/`)
}

/** Reads every installed plugin that applies here from `claude plugin list --json`. */
async function loadMods($: EngineInterface): Promise<ModInfo[]> {
  const { exitCode, stdout, stderr } = await claudeCli($, ['list', '--json'])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `claude plugin list exited ${exitCode}`)
  }
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('unexpected plugin list output')

  const seen = new Set<string>()
  const kept: { p: CliEntry; id: string; scope: string }[] = []
  for (const p of parsed as CliEntry[]) {
    if (typeof p.id !== 'string' || !belongsHere(p)) continue
    const scope = typeof p.scope === 'string' ? p.scope : 'user'
    const key = `${p.id}#${scope}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push({ p, id: p.id, scope })
  }
  const list: ModInfo[] = await Promise.all(
    kept.map(async ({ p, id, scope }) => ({
      id,
      scope,
      version: typeof p.version === 'string' ? p.version : '',
      isEnabled: p.enabled === true,
      description: await descriptionOf($, p),
    })),
  )

  return list.sort((a, b) => a.id.localeCompare(b.id))
}

async function refresh($: EngineInterface): Promise<ModInfo[]> {
  const list = await loadMods($)
  await update($, mods, () => list)

  return list
}

/** Finds one mod by full id or bare name; an error message otherwise. */
function find(list: ModInfo[], name: string): ModInfo | string {
  const exact = list.filter(m => m.id === name)
  const matches =
    exact.length > 0 ? exact : list.filter(m => m.id.split('@')[0] === name)
  const [only] = matches
  if (!only) return `No installed mod named "${name}".`
  if (matches.length > 1) {
    const ids = matches.map(m => `${m.id} (${m.scope})`).join(', ')

    return `"${name}" matches several mods: ${ids}. Use the full id.`
  }

  return only
}

function describe(m: ModInfo): string {
  const state = m.isEnabled ? 'ON ' : 'off'
  const version = m.version ? ` v${m.version}` : ''

  return `[${state}] ${m.id}${version} (${m.scope})`
}

function rowKey(m: ModInfo): string {
  return `${m.id}#${m.scope}`
}

/** Turns one mod on or off through the CLI, then re-reads the list. */
async function setEnabled(
  $: EngineInterface,
  mod: ModInfo,
  isOn: boolean,
): Promise<string> {
  if (mod.isEnabled === isOn) {
    return `${mod.id} is already ${isOn ? 'enabled' : 'disabled'}.`
  }
  await update($, busy, () => rowKey(mod))
  try {
    const verb = isOn ? 'enable' : 'disable'
    const { exitCode, stdout, stderr } = await claudeCli($, [
      verb,
      mod.id,
      '--scope',
      mod.scope,
    ])
    if (exitCode !== 0) {
      const why = (stderr || stdout).trim() || `exit code ${exitCode}`

      return `Could not ${verb} ${mod.id}: ${why}`
    }
    await update($, isReloadPending, () => true)
    await refresh($)

    return `${isOn ? 'Enabled' : 'Disabled'} ${mod.id}. Press Apply (or /mods reload) to load it into this session.`
  } finally {
    await update($, busy, () => '')
  }
}

async function reloadPlugins($: EngineInterface): Promise<string> {
  await $.command.run({ command: 'reload-plugins' })
  await update($, isReloadPending, () => false)

  return 'Plugins reloaded.'
}

async function report($: EngineInterface, text: string): Promise<string> {
  await update($, note, () => text)

  return text
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const KEYS_HINT =
  'Keys: j/k or ↑/↓ move · t or Enter toggles (on a group: folds it) · f/u fold/unfold all · 1/2/3 filter · r refresh · a apply · Esc closes'

type GroupId = 'mine' | 'official' | 'community' | 'synced'

/** The sheet's groups, in the order drawn. */
const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: 'mine', label: 'My mods' },
  { id: 'official', label: 'Official' },
  { id: 'community', label: 'Community' },
  { id: 'synced', label: 'Synced' },
]
const OFFICIAL_MARKETS = new Set(['claude-plugins-official', 'anthropic-agent-skills'])

/** `$.store` key holding the folded group ids, kept across sessions. */
const COLLAPSED_STORE = 'collapsed-groups'

function groupOf(m: ModInfo): GroupId {
  const market = m.id.split('@')[1] ?? ''
  if (market === 'my-mods') return 'mine'
  if (m.scope === 'synced' || market === 'synced') return 'synced'
  if (OFFICIAL_MARKETS.has(market)) return 'official'

  return 'community'
}

function groupKey(id: GroupId): string {
  return `group#${id}`
}

type GroupView = {
  id: GroupId
  label: string
  total: number
  onCount: number
  isOpen: boolean
  /** The mods this group shows: none while folded. */
  members: ModInfo[]
}

/**
 * The groups that have a mod passing the filter and search, each with its
 * shown members. A search unfolds every group, so a match is never hidden.
 */
function groupViews(
  list: ModInfo[],
  shown: ModFilter,
  typed: string,
  folded: readonly string[],
): GroupView[] {
  const rows = visibleMods(list, shown, typed)
  const isSearching = typed.trim() !== ''
  const views: GroupView[] = []
  for (const g of GROUPS) {
    const all = list.filter(m => groupOf(m) === g.id)
    const matching = rows.filter(m => groupOf(m) === g.id)
    if (matching.length === 0) continue
    const isOpen = isSearching || !folded.includes(g.id)
    views.push({
      id: g.id,
      label: g.label,
      total: all.length,
      onCount: all.filter(m => m.isEnabled).length,
      isOpen,
      members: isOpen ? matching : [],
    })
  }

  return views
}

/** One focusable row of the sheet: a group's header or a mod. */
type Entry =
  | { kind: 'group'; key: string; group: GroupView }
  | { kind: 'mod'; key: string; mod: ModInfo }

function entriesOf(views: GroupView[]): Entry[] {
  return views.flatMap(g => [
    { kind: 'group' as const, key: groupKey(g.id), group: g },
    ...g.members.map(m => ({ kind: 'mod' as const, key: rowKey(m), mod: m })),
  ])
}

/** Opens the Mods sheet as a dialog: it takes the keys and Esc closes it. */
async function openPane($: EngineInterface) {
  const opened = await $.ui.open({
    id: PANE,
    title: TITLE,
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: 30,
    columns: 64,
    backgroundColor: C.sheet,
  })
  await update($, isSheetOpen, () => true)

  return opened
}

/** Fits `text` into exactly `width` cells: cut with an ellipsis, or padded. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length > width) return `${text.slice(0, Math.max(0, width - 1))}…`

  return text.padEnd(width)
}

function visibleMods(list: ModInfo[], shown: ModFilter, typed: string) {
  const search = typed.trim().toLowerCase()

  return list.filter(m => {
    if (shown === 'on' && !m.isEnabled) return false
    if (shown === 'off' && m.isEnabled) return false

    return search === '' || m.id.toLowerCase().includes(search)
  })
}

/** The highlighted row's index: the stored key's, else the first mod's. */
function cursorIndex(entries: Entry[], key: string): number {
  const at = entries.findIndex(x => x.key === key)
  if (at >= 0) return at
  const firstMod = entries.findIndex(x => x.kind === 'mod')

  return firstMod < 0 ? 0 : firstMod
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await $.command.register({
      name: 'mods',
      description: 'Open the Mods panel to turn plugins and mods on or off',
      argumentHint: '[list|status|enable|disable|toggle|reload] [name]',
    })
    const started = await next(e)
    // Bring back the groups folded in an earlier session.
    const kept = await $.store.get(COLLAPSED_STORE).catch(() => undefined)
    if (Array.isArray(kept)) {
      const ids = kept.filter((x): x is string => typeof x === 'string')
      await update($, collapsed, () => ids)
    }
    // Fill the button's count in the background; a failure leaves it blank.
    void refresh($).catch(() => undefined)

    return started
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isSheetOpen, () => false)

    return closed
  }).catch(($, e, next) => next(e))

  // The ≡ Mods button in the status bar, beside the ◆ Dock button: a violet
  // pill (half blocks round its ends). A press opens the sheet, or closes it.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const list = await read($, mods)
    const isOpen = await read($, isSheetOpen)
    const pending = await read($, isReloadPending)
    const onCount = list.filter(m => m.isEnabled).length
    const count = list.length > 0 ? ` ${onCount}/${list.length}` : ''
    const fill = isOpen ? C.violetBright : C.violet
    const modes = e.props.modes

    return (
      <Box flexDirection="row">
        {below ?? (modes.length > 0 ? <Text dimColor>{modes.join(' & ')}</Text> : null)}
        <Text>{'  '}</Text>
        <Button
          key="open-mod-manager"
          plain
          onPress={async () => {
            try {
              if (await read($, isSheetOpen)) {
                await $.ui.close({ id: PANE })
                await update($, isSheetOpen, () => false)

                return
              }
              await refresh($).catch(() => undefined)
              const opened = await openPane($)
              if (!opened.isPlaced) $.ui.toast(`Mods: ${opened.reason}`)
            } catch (err) {
              $.ui.toast(`Mods could not open: ${errorText(err)}`)
            }
          }}
        >
          <Text color={fill}>▐</Text>
          <Text backgroundColor={fill} color={C.ink} bold>
            {`≡ Mods${count}${pending ? ' •' : ''}`}
          </Text>
          <Text color={fill}>▌</Text>
        </Button>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mods' }, async ($, e) => {
    // A plugin's `$.command.run` may leave `args` out.
    const args: string = e.args ?? ''
    const [verb = 'panel', name] = args.trim().split(/\s+/).filter(Boolean)

    try {
      if (verb === 'help') return { text: HELP }

      if (verb === 'reload') {
        return { text: await report($, await reloadPlugins($)) }
      }

      const list = await refresh($)
      const onCount = list.filter(m => m.isEnabled).length

      if (verb === 'panel' || verb === 'ui') {
        const opened = await openPane($)
        const lines = [`${onCount} of ${list.length} mods on.`]
        if (!opened.isPlaced) {
          lines.push(`The panel is waiting for room: ${opened.reason}`)
        }
        lines.push(KEYS_HINT)
        lines.push(
          'If the keys do nothing, press ctrl+x then Tab to put the keyboard in the panel.',
        )
        if (e.presentation && !e.presentation.isFullscreen) {
          lines.push(
            'Mouse clicks reach the panel only in fullscreen mode; this session draws on the main screen.',
          )
        }

        return { text: lines.join('\n') }
      }

      if (verb === 'list') {
        const header = `${onCount} of ${list.length} mods enabled:`

        return { text: [header, ...list.map(describe)].join('\n') }
      }

      const isKnownVerb = ['status', 'enable', 'disable', 'toggle'].includes(verb)
      if (!isKnownVerb || !name) return { text: HELP }

      const mod = find(list, name)
      if (typeof mod === 'string') return { text: mod }

      if (verb === 'status') return { text: describe(mod) }

      const isOn = verb === 'toggle' ? !mod.isEnabled : verb === 'enable'

      return { text: await report($, await setEnabled($, mod, isOn)) }
    } catch (err) {
      return { text: `mods: ${errorText(err)}` }
    }
  })

  // Tab and the arrows move the engine's focus ring: the cursor follows it,
  // so j/k, t and Enter always act on the same row.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const element = e.element
    if (element !== undefined && element.includes('#')) {
      await update($, cursor, () => element)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The mobile app draws no text field yet: no search box there.
    const Input = 'Input' in elements ? elements.Input : undefined

    const list = await read($, mods)
    const working = await read($, busy)
    const pending = await read($, isReloadPending)
    const last = await read($, note)
    const shown = await read($, filter)
    const typed = await read($, query)
    const folded = await read($, collapsed)
    const onCount = list.filter(m => m.isEnabled).length

    const width = Math.max(30, e.props.bodyColumns ?? 64)
    // Every row is drawn: the engine scrolls the body (wheel, arrows) when the
    // list is taller than the sheet, and keeps the focused row in view.
    const views = groupViews(list, shown, typed, folded)
    const entries = entriesOf(views)
    const at = cursorIndex(entries, await read($, cursor))
    const selected = entries[at]
    const cursorKey = selected?.key ?? ''

    const toggleMod = (m: ModInfo) => async () => {
      if (working) return
      await update($, cursor, () => rowKey(m))
      try {
        await report($, await setEnabled($, m, !m.isEnabled))
      } catch (err) {
        await report($, `Could not change ${m.id}: ${errorText(err)}`)
      }
    }

    const toggleGroup = (id: GroupId) => async () => {
      await update($, cursor, () => groupKey(id))
      const nextFolded = await update($, collapsed, ids =>
        (ids ?? []).includes(id) ? (ids ?? []).filter(x => x !== id) : [...(ids ?? []), id],
      )
      await $.store.set(COLLAPSED_STORE, nextFolded).catch(() => undefined)
    }

    const pressEntry = (x: Entry) =>
      x.kind === 'group' ? toggleGroup(x.group.id) : toggleMod(x.mod)

    const move = (step: number) => async () => {
      const target = entries[Math.min(entries.length - 1, Math.max(0, at + step))]
      if (!target) return
      await update($, cursor, () => target.key)
      // Move the ring too, so Enter presses the highlighted row, and keep the
      // row in view as the list scrolls.
      await $.ui.focus({ requestId: PANE, key: target.key }).catch(() => {})
      await $.ui.scroll({ to: { key: target.key }, in: PANE }).catch(() => {})
    }

    const setAllFolded = (isFolded: boolean) => async () => {
      const ids = isFolded ? GROUPS.map(g => g.id as string) : []
      await update($, collapsed, () => ids)
      await $.store.set(COLLAPSED_STORE, ids).catch(() => undefined)
    }

    const refreshNow = async () => {
      try {
        await refresh($)
        await report($, 'List refreshed.')
      } catch (err) {
        await report($, `Could not list mods: ${errorText(err)}`)
      }
    }

    const apply = async () => {
      if (working) return
      await update($, busy, () => 'reload')
      try {
        await report($, await reloadPlugins($))
      } catch (err) {
        await report($, `Reload failed: ${errorText(err)}`)
      } finally {
        await update($, busy, () => '')
      }
    }

    const filterButton = (value: ModFilter, label: string, hotkey: string) => (
      <Button
        key={`filter-${value}`}
        label={label}
        hotkey={hotkey}
        variant={shown === value ? 'primary' : 'secondary'}
        onPress={() => update($, filter, () => value)}
      />
    )

    const groupRow = (g: GroupView) => {
      const isCursor = cursorKey === groupKey(g.id)

      return (
        <Button
          key={groupKey(g.id)}
          plain
          autoFocus={isCursor ? true : undefined}
          label={`${g.isOpen ? 'Fold' : 'Unfold'} ${g.label}`}
          onPress={toggleGroup(g.id)}
        >
          <Text color={C.violet} bold>
            {isCursor ? '▶ ' : '  '}
          </Text>
          <Text color={C.violetBright} bold>
            {g.isOpen ? '▾ ' : '▸ '}
            {g.label}
          </Text>
          <Text dimColor>
            {'  '}
            {g.onCount}/{g.total} on
          </Text>
        </Button>
      )
    }

    const modRow = (m: ModInfo) => {
      const isCursor = cursorKey === rowKey(m)
      const isWorking = working === rowKey(m)
      const [name = m.id] = m.id.split('@')
      const switchText = isWorking ? SWITCH.busy : m.isEnabled ? SWITCH.on : SWITCH.off
      // As in the Employee Control Panel video: a status dot, the name, a dim
      // one-line description, and the switch at the right edge of the sheet.
      const textWidth = Math.max(8, width - 4 - SWITCH_WIDTH - 2)
      const nameText = fit(name, Math.min(name.length, textWidth))
      const descText = m.description ? fit(`  ${m.description}`, Math.max(0, textWidth - nameText.length)) : ''
      const pad = ' '.repeat(Math.max(0, textWidth - nameText.length - descText.length))

      return (
        <Box key={`wrap-${rowKey(m)}`} flexDirection="column">
          <Button
            key={rowKey(m)}
            plain
            autoFocus={isCursor ? true : undefined}
            label={`${m.isEnabled ? 'Turn off' : 'Turn on'} ${m.id}`}
            onPress={toggleMod(m)}
          >
            <Text color={C.violet} bold>
              {isCursor ? '▶ ' : '  '}
            </Text>
            <Text color={m.isEnabled ? C.on : C.muted}>{m.isEnabled ? '● ' : '○ '}</Text>
            <Text bold={isCursor || m.isEnabled} dimColor={!m.isEnabled && !isCursor}>
              {nameText}
            </Text>
            <Text color={C.muted}>{descText}</Text>
            <Text>{`${pad}  `}</Text>
            <Text
              backgroundColor={isWorking ? C.yellow : m.isEnabled ? C.on : undefined}
              color={m.isEnabled || isWorking ? C.knob : C.muted}
              bold={m.isEnabled || isWorking}
            >
              {switchText}
            </Text>
          </Button>
          {isCursor && (
            <Text key={`detail-${rowKey(m)}`} color={C.muted} wrap="truncate-end">
              {`      ${m.id} · ${m.scope}${m.version ? ` · v${m.version}` : ''}`}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap">
          <Text bold>
            <Text color={C.violet}>≡ Mods  </Text>
            <Text color={C.on}>{onCount} on</Text>
            <Text dimColor> · </Text>
            <Text dimColor>{list.length - onCount} off</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {filterButton('all', 'All', '1')}
            {filterButton('on', 'On', '2')}
            {filterButton('off', 'Off', '3')}
            <Button key="refresh" label="Refresh" hotkey="r" onPress={refreshNow} />
            {pending && (
              <Button
                key="apply"
                label="Apply"
                hotkey="a"
                variant="primary"
                onPress={apply}
              />
            )}
          </Box>
        </Box>

        {pending && (
          <Text color="yellow">
            Saved. Press a (Apply) to load the change into this session.
          </Text>
        )}

        <Box flexDirection="column" marginY={1}>
          {list.length === 0 && (
            <Text dimColor>No mods listed yet. Press r to refresh.</Text>
          )}
          {list.length > 0 && views.length === 0 && (
            <Text dimColor>No mods match.</Text>
          )}
          {views.map((g, i) => (
            <Box key={`box-${g.id}`} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
              {groupRow(g)}
              {g.members.map(modRow)}
            </Box>
          ))}
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="up" label="↑" hotkey="k" plain onPress={move(-1)} />
          <Button key="down" label="↓" hotkey="j" plain onPress={move(1)} />
          <Button
            key="toggle"
            label="Toggle"
            hotkey="t"
            plain
            onPress={selected ? pressEntry(selected) : () => {}}
          />
          <Button key="fold-all" label="Fold all" hotkey="f" plain onPress={setAllFolded(true)} />
          <Button key="unfold-all" label="Unfold all" hotkey="u" plain onPress={setAllFolded(false)} />
          <Text dimColor>· Enter flips a switch or folds a group · Esc closes</Text>
        </Box>

        {Input && (
          <Input
            key="search"
            placeholder="Search mods…"
            value={typed}
            submitLabel="Find"
            onInput={(value: string) => update($, query, () => value)}
            onSubmit={(value: string) => update($, query, () => value)}
          />
        )}

        {last !== '' && <Text dimColor>{last}</Text>}
      </Box>
    )
  })
}

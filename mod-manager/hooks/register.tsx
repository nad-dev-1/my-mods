import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModFilter, ModInfo } from '../types'
import { factsOf, firstSentence, hintOf, iconOf, isOn, isSwitchedHidden, sortMods, titleOf, withHidden, withOff } from './mods-logic'
import type { Switches } from './mods-logic'
import { statusGrid } from './status-grid'
import { SWITCHES, parseSwitches } from './switch'

// The Mods pane, after "Mod #9" (Switchboard) of Ben AI's "9 Insane Claude
// Mods" video: one row per mod with its icon, a one-line description, how to
// reach it, an eye (Shown/Hidden) and an On/Off switch. Your own mods read a
// shared switch file, so a change reaches every chat within 3 seconds; other
// mods are enabled or disabled through the CLI and need a reload.

const PANE = 'mod-manager'
const TITLE = 'Mods'
/** While the pane is open, the switch file is read this often and the mod list this often. */
const SWITCH_POLL_MS = 3000
const SCAN_MS = 10_000
const OWN_MARKET = 'my-mods'

const mods = atom({ plugin: 'mod-manager', key: 'mods' } as const, [] as ModInfo[], { shape: 'mods-v2' })
const switchesAtom = atom({ plugin: 'mod-manager', key: 'switches' } as const, {} as Record<string, unknown>, { shape: 'switches-v1' })
const note = atom({ plugin: 'mod-manager', key: 'note' } as const, '')
const busy = atom({ plugin: 'mod-manager', key: 'busy' } as const, '')
const isReloadPending = atom({ plugin: 'mod-manager', key: 'isReloadPending' } as const, false)
const pendingIds = atom({ plugin: 'mod-manager', key: 'pendingIds' } as const, [] as string[])
const filter = atom({ plugin: 'mod-manager', key: 'filter' } as const, 'all' as ModFilter)
const query = atom({ plugin: 'mod-manager', key: 'query' } as const, '')
const cursor = atom({ plugin: 'mod-manager', key: 'cursor' } as const, '')
const isSheetOpen = atom({ plugin: 'mod-manager', key: 'isSheetOpen' } as const, false)

const C = {
  violet: '#A371F7',
  violetBright: '#C9A8FF',
  ink: '#0D1117',
  on: '#2EA043',
  onText: '#3FB950',
  off: '#30363D',
  knob: '#FFFFFF',
  muted: '#7D8590',
  yellow: '#D29922',
  info: '#58A6FF',
}

const HELP = [
  'Usage:',
  '  /mods                 open or close the Mods pane (j/k move, t switches, h hides, o opens)',
  '  /mods list            print every mod and its state',
  '  /mods status <name>   show one mod',
  '  /mods enable <name>   turn a mod on',
  '  /mods disable <name>  turn a mod off',
  '  /mods toggle <name>   flip a mod',
  '  /mods hide <name>     keep a mod on but out of sight',
  '  /mods show <name>     show a hidden mod again',
  '  /mods reload          apply plugin changes to this session (/reload-plugins)',
  '<name> is the mod\'s name, its id (name@marketplace) or its title.',
].join('\n')

const FOOTER = 'Off means off in every chat. Hidden keeps it on but out of sight. Changes apply within 3 seconds. New mods appear here by themselves.'

type Timer = { cancel: () => void }

let home = ''
let sessionCwd = ''
let switchTimer: Timer | null = null
let scanTimer: Timer | null = null

type CliEntry = { id?: unknown; scope?: unknown; version?: unknown; enabled?: unknown; projectPath?: unknown; installPath?: unknown; readFromFolder?: unknown }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function claudeCli($: EngineInterface, args: readonly string[]) {
  return $.process.run(['claude', 'plugin', ...args], { timeoutMs: 60_000 })
}

/** Local- and project-scope installs of another folder are not this chat's. */
function belongsHere(entry: CliEntry): boolean {
  if (typeof entry.projectPath !== 'string' || sessionCwd === '') return true
  const root = entry.projectPath.replace(/\/+$/, '')

  return sessionCwd === root || sessionCwd.startsWith(`${root}/`)
}

/** Every hooks source file of a folder, tests left out, joined. */
async function hooksSource($: EngineInterface, folder: string): Promise<string> {
  const entries = await $.fs.list(`${folder}/hooks`).catch(() => [])
  const files = entries.filter(f => f.kind === 'file' && /\.(t|j)sx?$/.test(f.name) && !/\.test\./.test(f.name) && f.name !== 'switch.tsx')
  const texts = await Promise.all(files.map(f => $.fs.read(`${folder}/hooks/${f.name}`).catch(() => '')))

  return texts.join('\n')
}

/** One installed plugin as a row, or null when it is not a mod (no hooks module). */
async function inspect($: EngineInterface, entry: CliEntry): Promise<ModInfo | null> {
  if (typeof entry.id !== 'string') return null
  const folders = [entry.readFromFolder, entry.installPath].filter((f): f is string => typeof f === 'string' && f !== '')
  let folder = ''
  for (const f of folders) {
    const hooks = await $.fs.read(`${f}/hooks/hooks.json`).catch(() => '')
    if (/"modules"\s*:/.test(hooks)) {
      folder = f
      break
    }
  }
  if (!folder) return null
  const manifest = await $.fs.read(`${folder}/.claude-plugin/plugin.json`).catch(() => '')
  let description = ''
  try {
    const d = (JSON.parse(manifest) as { description?: unknown }).description
    if (typeof d === 'string') description = firstSentence(d)
  } catch {
    // No readable manifest: no description.
  }
  const [name = entry.id, market = ''] = entry.id.split('@')
  const facts = factsOf(await hooksSource($, folder))

  return {
    id: entry.id,
    name,
    title: titleOf(name),
    icon: iconOf(name),
    scope: typeof entry.scope === 'string' ? entry.scope : 'user',
    version: typeof entry.version === 'string' ? entry.version : '',
    isEnabled: entry.enabled === true,
    description,
    isOwn: market === OWN_MARKET,
    // The panel itself is never switched off from its own row.
    isSwitchable: facts.isSwitchable && name !== 'mod-manager',
    draws: facts.draws,
    hasPane: facts.hasPane,
    command: facts.command,
  }
}

/** Every installed mod that applies here, from `claude plugin list --json`. */
async function loadMods($: EngineInterface): Promise<ModInfo[]> {
  const { exitCode, stdout, stderr } = await claudeCli($, ['list', '--json'])
  if (exitCode !== 0) throw new Error(stderr.trim() || `claude plugin list exited ${exitCode}`)
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('unexpected plugin list output')
  const seen = new Set<string>()
  const kept: CliEntry[] = []
  for (const p of parsed as CliEntry[]) {
    if (typeof p.id !== 'string' || !belongsHere(p) || seen.has(p.id)) continue
    seen.add(p.id)
    kept.push(p)
  }
  const rows = await Promise.all(kept.map(p => inspect($, p)))

  return sortMods(rows.filter((m): m is ModInfo => m !== null))
}

async function refresh($: EngineInterface): Promise<ModInfo[]> {
  const list = await loadMods($)
  const cur = await read($, mods)
  if (JSON.stringify(cur) !== JSON.stringify(list)) await update($, mods, () => list)

  return list
}

const switchesPath = () => `${home}/${SWITCHES}`

async function readSwitches($: EngineInterface): Promise<Switches> {
  const json = parseSwitches(await $.fs.read(switchesPath()).catch(() => ''))
  const cur = await read($, switchesAtom)
  if (JSON.stringify(cur) !== JSON.stringify(json)) await update($, switchesAtom, () => json)

  return json
}

/** Reads the file again just before writing, so a change made in another chat is kept. */
async function writeSwitches($: EngineInterface, change: (s: Switches) => Switches) {
  const next = change(await readSwitches($))
  await $.fs.write(switchesPath(), `${JSON.stringify(next, null, 2)}\n`)
  await update($, switchesAtom, () => next)
}

async function say($: EngineInterface, text: string): Promise<string> {
  await update($, note, () => text)

  return text
}

/** Turns a mod on or off: your mods through the switch, at once; others through the CLI, after a reload. */
async function setOn($: EngineInterface, m: ModInfo, on: boolean): Promise<string> {
  if (m.name === 'mod-manager') return say($, 'The Mods panel stays on: it is how you switch the others.')
  if (m.isSwitchable) {
    await writeSwitches($, s => withOff(s, m.name, !on))
    if (on && !m.isEnabled) return cliSet($, m, true)

    return say($, `${m.title} is ${on ? 'on' : 'off'} in every chat.`)
  }

  return cliSet($, m, on)
}

async function cliSet($: EngineInterface, m: ModInfo, on: boolean): Promise<string> {
  await update($, busy, () => m.id)
  try {
    const verb = on ? 'enable' : 'disable'
    const r = await claudeCli($, [verb, m.id, '--scope', m.scope])
    if (r.exitCode !== 0) return say($, `Could not ${verb} ${m.title}: ${(r.stderr || r.stdout).trim() || `exit code ${r.exitCode}`}`)
    await update($, isReloadPending, () => true)
    await update($, pendingIds, ids => (ids.includes(m.id) ? ids : [...ids, m.id]))
    await refresh($)

    return say($, `${m.title} is ${on ? 'enabled' : 'disabled'}. It applies after a reload: press Apply.`)
  } finally {
    await update($, busy, () => '')
  }
}

async function setHidden($: EngineInterface, m: ModInfo, hidden: boolean): Promise<string> {
  if (!m.isSwitchable || !m.draws) return say($, `${m.title} has nothing to hide from the Mods panel.`)
  await writeSwitches($, s => withHidden(s, m.name, hidden))

  return say($, hidden ? `${m.title} is hidden in every chat. It keeps working, out of sight.` : `${m.title} is shown in every chat.`)
}

async function openMod($: EngineInterface, m: ModInfo) {
  if (!m.command) return
  await $.command.run({ command: m.command, args: '' }).catch(err => say($, `Could not open ${m.title}: ${errorText(err)}`))
}

async function reloadPlugins($: EngineInterface): Promise<string> {
  await update($, busy, () => 'reload')
  try {
    await $.command.run({ command: 'reload-plugins' })
    await update($, isReloadPending, () => false)
    await update($, pendingIds, () => [])

    return say($, 'Plugins reloaded.')
  } finally {
    await update($, busy, () => '')
  }
}

function startPolling($: EngineInterface) {
  switchTimer?.cancel()
  scanTimer?.cancel()
  switchTimer = $.clock.every(SWITCH_POLL_MS, () => {
    void readSwitches($).catch(() => undefined)
  })
  // New mods, installed or built meanwhile, appear by themselves.
  scanTimer = $.clock.every(SCAN_MS, () => {
    void refresh($).catch(() => undefined)
  })
}

function stopPolling() {
  switchTimer?.cancel()
  scanTimer?.cancel()
  switchTimer = null
  scanTimer = null
}

async function openPane($: EngineInterface) {
  await Promise.all([refresh($).catch(err => say($, `Could not list mods: ${errorText(err)}`)), readSwitches($)])
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, columns: 64 })
  await update($, isSheetOpen, () => true)
  startPolling($)

  return opened
}

async function closePane($: EngineInterface) {
  stopPolling()
  await update($, isSheetOpen, () => false)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

/** Finds a mod by name, id or title. */
function find(list: ModInfo[], name: string): ModInfo | string {
  const key = name.toLowerCase()
  const matches = list.filter(m => m.id.toLowerCase() === key || m.name.toLowerCase() === key || m.title.toLowerCase() === key)
  const [only] = matches
  if (!only) return `No installed mod named "${name}".`
  if (matches.length > 1) return `"${name}" matches several mods: ${matches.map(m => m.id).join(', ')}. Use the full id.`

  return only
}

function describe(m: ModInfo, s: Switches): string {
  const state = isOn(m, s) ? 'ON ' : 'off'
  const hidden = m.isSwitchable && isSwitchedHidden(s, m.name) ? ', hidden' : ''

  return `[${state}] ${m.title} (${m.id}${m.version ? ` v${m.version}` : ''}${hidden})`
}

function visibleMods(list: ModInfo[], s: Switches, shown: ModFilter, typed: string) {
  const search = typed.trim().toLowerCase()

  return list.filter(m => {
    if (shown === 'on' && !isOn(m, s)) return false
    if (shown === 'off' && isOn(m, s)) return false

    return search === '' || `${m.id} ${m.title} ${m.description}`.toLowerCase().includes(search)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    await $.command.register({
      name: 'mods',
      description: 'Open the Mods pane: turn each mod on or off, or hide it, in every chat',
      argumentHint: '[list|status|enable|disable|toggle|hide|show|reload] [name]',
    })
    const started = await next(e)
    void readSwitches($).catch(() => undefined)
    // Fill the button's count in the background; a failure leaves it blank.
    void refresh($).catch(() => undefined)
    if (await read($, isSheetOpen)) startPolling($)

    return started
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    stopPolling()
    await update($, isSheetOpen, () => false)

    return closed
  }).catch(($, e, next) => next(e))

  // The ≡ Mods button in the status bar: a violet pill with how many are on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const list = await read($, mods)
    const s = await read($, switchesAtom)
    const isOpen = await read($, isSheetOpen)
    const pending = await read($, isReloadPending)
    const onCount = list.filter(m => isOn(m, s)).length
    const count = list.length > 0 ? ` ${onCount}/${list.length}` : ''
    const fill = isOpen ? C.violetBright : C.violet

    return statusGrid(
      { Box, Text },
      below,
      e.props.modes,
      <Button
        key="open-mod-manager"
        plain
        onPress={async () => {
          try {
            if (await read($, isSheetOpen)) return closePane($)
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
      </Button>,
    ) as never
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mods' }, async ($, e) => {
    // A plugin's `$.command.run` may leave `args` out.
    const args: string = e.args ?? ''
    const [verb = 'panel', ...rest] = args.trim().split(/\s+/).filter(Boolean)
    const name = rest.join(' ')
    try {
      if (verb === 'help') return { text: HELP }
      if (verb === 'reload') return { text: await reloadPlugins($) }
      if (verb === 'panel' || verb === 'ui') {
        if (await read($, isSheetOpen)) {
          await closePane($)

          return { text: 'Closed the Mods pane.' }
        }
        const opened = await openPane($)
        const list = await read($, mods)
        const s = await read($, switchesAtom)
        const lines = [`${list.filter(m => isOn(m, s)).length} of ${list.length} mods on.`]
        if (!opened.isPlaced) lines.push(`The pane is waiting for room: ${opened.reason}`)
        lines.push('Keys: j/k move · t switches on/off · h hides/shows · o opens · Esc closes')

        return { text: lines.join('\n') }
      }
      const list = await refresh($)
      const s = await readSwitches($)
      if (verb === 'list') return { text: [`${list.filter(m => isOn(m, s)).length} of ${list.length} mods on:`, ...list.map(m => describe(m, s))].join('\n') }
      if (!['status', 'enable', 'disable', 'toggle', 'hide', 'show'].includes(verb) || !name) return { text: HELP }
      const mod = find(list, name)
      if (typeof mod === 'string') return { text: mod }
      if (verb === 'status') return { text: describe(mod, s) }
      if (verb === 'hide' || verb === 'show') return { text: await setHidden($, mod, verb === 'hide') }
      const want = verb === 'toggle' ? !isOn(mod, s) : verb === 'enable'

      return { text: await setOn($, mod, want) }
    } catch (err) {
      return { text: `mods: ${errorText(err)}` }
    }
  })

  // Tab and the arrows move the engine's focus ring: the cursor follows it.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const element = e.element
    if (element !== undefined && element.startsWith('mod:')) await update($, cursor, () => element.slice(4))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The mobile app draws no text field yet: no search box there.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, mods)
    const s = await read($, switchesAtom)
    const working = await read($, busy)
    const pending = await read($, isReloadPending)
    const pendingList = await read($, pendingIds)
    const last = await read($, note)
    const shown = await read($, filter)
    const typed = await read($, query)
    const width = Math.max(36, e.props.bodyColumns ?? 64)
    const rows = visibleMods(list, s, shown, typed)
    const storedCursor = await read($, cursor)
    const selected = rows.find(m => m.id === storedCursor) ?? rows[0]
    const onCount = list.filter(m => isOn(m, s)).length

    const flip = (m: ModInfo) => async () => {
      if (working) return
      await update($, cursor, () => m.id)
      try {
        await setOn($, m, !isOn(m, s))
      } catch (err) {
        await say($, `Could not change ${m.title}: ${errorText(err)}`)
      }
    }
    const eye = (m: ModInfo) => async () => {
      await update($, cursor, () => m.id)
      await setHidden($, m, !isSwitchedHidden(s, m.name)).catch(err => say($, `Could not change ${m.title}: ${errorText(err)}`))
    }
    const move = (step: number) => async () => {
      const i = Math.max(0, rows.findIndex(m => m.id === selected?.id))
      const target = rows[Math.min(rows.length - 1, Math.max(0, i + step))]
      if (!target) return
      await update($, cursor, () => target.id)
      await $.ui.focus({ requestId: PANE, key: `mod:${target.id}` }).catch(() => {})
      await $.ui.scroll({ to: { key: `mod:${target.id}` }, in: PANE }).catch(() => {})
    }
    const filterButton = (value: ModFilter, label: string, hotkey: string) => (
      <Button key={`filter-${value}`} label={label} hotkey={hotkey} variant={shown === value ? 'primary' : 'secondary'} onPress={() => update($, filter, () => value)} />
    )

    const modRow = (m: ModInfo) => {
      const isCursor = selected?.id === m.id
      const isWorking = working === m.id
      const live = isOn(m, s)
      const hidden = m.isSwitchable && isSwitchedHidden(s, m.name)
      const isSelf = m.name === 'mod-manager'
      const waits = pendingList.includes(m.id)
      const hint = waits ? 'applies after reload' : hintOf(m)

      return (
        <Box key={`row-${m.id}`} flexDirection="column" marginBottom={1} width={width}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Button key={`mod:${m.id}`} plain autoFocus={isCursor ? true : undefined} label={`${live ? 'Turn off' : 'Turn on'} ${m.title}`} onPress={isSelf ? () => undefined : flip(m)}>
              <Text color={C.violet} bold>
                {isCursor ? '▶ ' : '  '}
              </Text>
              <Text color={live ? C.violetBright : C.muted}>{`${m.icon} `}</Text>
              <Text bold dimColor={!live}>
                {m.title}
              </Text>
            </Button>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {m.hasPane && m.command && live ? <Button key={`open:${m.id}`} label="Open" onPress={() => openMod($, m)} /> : null}
              {m.isSwitchable && m.draws ? (
                <Button key={`eye:${m.id}`} plain label={hidden ? `Show ${m.title}` : `Hide ${m.title}`} onPress={eye(m)}>
                  <Text color={hidden ? C.muted : C.info}>{hidden ? '◌ Hidden' : '◉ Shown '}</Text>
                </Button>
              ) : null}
              {isSelf ? (
                <Text color={C.muted}>this pane</Text>
              ) : (
                <Button key={`switch:${m.id}`} plain label={`${live ? 'Turn off' : 'Turn on'} ${m.title}`} onPress={flip(m)}>
                  <Text backgroundColor={isWorking ? C.yellow : live ? C.on : C.off} color={live || isWorking ? C.knob : C.muted} bold>
                    {isWorking ? '  ···  ' : live ? ' ● On  ' : ' ○ Off '}
                  </Text>
                </Button>
              )}
            </Box>
          </Box>
          {m.description ? (
            <Text color={C.muted} wrap="truncate-end">
              {`    ${m.description}`}
            </Text>
          ) : null}
          {hint ? (
            <Text color={waits ? C.yellow : C.muted} italic wrap="truncate-end">
              {`    ${hint}`}
            </Text>
          ) : null}
        </Box>
      )
    }

    const yours = rows.filter(m => m.isOwn)
    const others = rows.filter(m => !m.isOwn)

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap">
          <Text bold>
            <Text color={C.violet}>{'≡ Mods  '}</Text>
            <Text color={C.onText}>{`${onCount} on`}</Text>
            <Text dimColor>{` · ${list.length - onCount} off`}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {filterButton('all', 'All', '1')}
            {filterButton('on', 'On', '2')}
            {filterButton('off', 'Off', '3')}
            {pending ? <Button key="apply" label="Apply" hotkey="a" variant="primary" onPress={() => reloadPlugins($).catch(err => say($, `Reload failed: ${errorText(err)}`))} /> : null}
          </Box>
        </Box>
        {Input ? (
          <Input
            key="search"
            placeholder="Search mods…"
            value={typed}
            submitLabel="Find"
            onInput={(value: string) => update($, query, () => value)}
            onSubmit={(value: string) => update($, query, () => value)}
          />
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {list.length === 0 ? <Text dimColor>Looking for your mods…</Text> : null}
          {list.length > 0 && rows.length === 0 ? <Text dimColor>No mods match.</Text> : null}
          {yours.length ? <Text color={C.muted}>Your mods</Text> : null}
          {yours.map(modRow)}
          {others.length ? <Text color={C.muted}>Other mods · on/off applies after a reload</Text> : null}
          {others.map(modRow)}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="up" label="↑" hotkey="k" plain onPress={move(-1)} />
          <Button key="down" label="↓" hotkey="j" plain onPress={move(1)} />
          <Button key="toggle" label="Switch" hotkey="t" plain onPress={selected && selected.name !== 'mod-manager' ? flip(selected) : () => undefined} />
          <Button key="hide" label="Hide/Show" hotkey="h" plain onPress={selected ? eye(selected) : () => undefined} />
          <Button key="open" label="Open" hotkey="o" plain onPress={selected ? () => openMod($, selected) : () => undefined} />
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {last ? <Text color={C.onText}>{last}</Text> : null}
          <Text dimColor wrap="wrap">
            {FOOTER}
          </Text>
        </Box>
      </Box>
    )
  })
}

import { expect, mock, test } from 'claude-code/testing'

import { factsOf, hintOf, withHidden, withOff } from '../hooks/mods-logic'

const PANE = {
  plugin: 'mod-manager',
  component: 'Pane',
  requestId: 'mod-manager',
  props: { title: 'Mods', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const STATUS_BAR = { plugin: 'mod-manager', component: 'SessionMode', props: { modes: [] } } as const

const HOME = '/Users/tester'
const SWITCH_FILE = `${HOME}/.claude/mods/switches.json`

/** Installed plugins: three of yours, one other mod, and a skills pack (not a mod). */
const PLUGINS: Record<string, { source: string; description: string; isMod?: boolean }> = {
  'chat-inventory@my-mods': {
    description: 'A side pane, In this chat, with live cards. More words.',
    source: "await watchSwitch($, 'chat-inventory', 'Chat Inventory')\n$.command.register({ name: 'inventory' })\non('ui.render', { component: 'SessionMode' })\non('ui.render', { component: 'Pane' })",
  },
  'cache-handoff@my-mods': {
    description: 'A Cache Clock card above the prompt. Other things.',
    source: "await watchSwitch($, 'cache-handoff', 'x')\nawait $.command\n      .register({ name: 'handoff-new', description: '' })\non('ui.render', { component: 'AbovePrompt' })",
  },
  'mod-manager@my-mods': {
    description: 'A Mods button.',
    source: "$.command.register({ name: 'mods' })\non('ui.render', { component: 'Pane' })\non('ui.render', { component: 'SessionMode' })",
  },
  'reflect-mod@claude-reflect-marketplace': {
    description: 'Turns your corrections into CLAUDE.md rules. And more.',
    source: "on('ui.render', { component: 'AbovePrompt' })",
  },
  'superpowers@claude-plugins-official': { description: 'Skills.', source: '', isMod: false },
}

type World = {
  clock: ReturnType<typeof mock.clock>
  enabled: Record<string, boolean>
  files: Record<string, string>
  cli: string[][]
  commands: { command: string; args?: string }[]
  opens: string[]
  closes: string[]
}

function world(on: any, extra: Record<string, { source: string; description: string }> = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  const all = { ...PLUGINS, ...extra }
  const w: Omit<World, 'clock'> = {
    enabled: Object.fromEntries(Object.keys(all).map(id => [id, true])),
    files: {},
    cli: [],
    commands: [],
    opens: [],
    closes: [],
  }
  const folderOf = (id: string) => `/inst/${id.split('@')[0]}`
  for (const [id, p] of Object.entries(all)) {
    const f = folderOf(id)
    w.files[`${f}/.claude-plugin/plugin.json`] = JSON.stringify({ name: id.split('@')[0], description: p.description })
    w.files[`${f}/hooks/hooks.json`] = (p as { isMod?: boolean }).isMod === false ? '{"hooks":{}}' : '{ "modules": ["./register.tsx"] }'
    w.files[`${f}/hooks/register.tsx`] = p.source
  }
  on('env.get', () => ({ value: HOME }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    w.cli.push(argv)
    const [, , verb, id] = argv
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (verb === 'list') {
      return ok(JSON.stringify(Object.keys({ ...PLUGINS, ...extra }).map(key => ({ id: key, scope: 'user', version: '1.0.0', enabled: w.enabled[key], installPath: folderOf(key) }))))
    }
    if ((verb === 'enable' || verb === 'disable') && id) {
      w.enabled[id] = verb === 'enable'
      return ok()
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_: unknown, e: any) => {
    if (!(e.path in w.files)) throw new Error(`ENOENT ${e.path}`)
    return { value: w.files[e.path] }
  })
  on('fs.write', (_: unknown, e: any) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', (_: unknown, e: any) => {
    const prefix = `${e.path}/`
    const names = Object.keys(w.files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(p => p.slice(prefix.length))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('command.run', (_: unknown, e: any) => {
    w.commands.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  on('ui.open', (_: unknown, e: any) => {
    w.opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: any) => {
    w.closes.push(e.id)
    return { value: undefined }
  })
  on('ui.focus', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))

  return Object.assign(w, { clock }) as World
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const mods = ($: any, args = '') => $.command.run({ command: 'mods', args, origin: { kind: 'composer' } })
const switches = (w: World) => JSON.parse(w.files[SWITCH_FILE] ?? '{}')

async function openPane($: any) {
  await mods($)
  return $.ui.mount({ ...PANE, surface: 'terminal' } as any)
}

const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    .map((t: any) => [t.text, t.label, t.props?.label].filter(Boolean).join(' '))
    .join('\n')

// ── What a mod's source says ────────────────────────────────────────────

test('a mod\'s source tells whether it reads the switch, draws, has a pane, and its command', () => {
  expect(factsOf(PLUGINS['chat-inventory@my-mods']!.source)).toEqual({ isSwitchable: true, draws: true, hasPane: true, command: 'inventory' })
  expect(factsOf(PLUGINS['cache-handoff@my-mods']!.source)).toEqual({ isSwitchable: true, draws: true, hasPane: false, command: 'handoff-new' })
  expect(factsOf(PLUGINS['reflect-mod@claude-reflect-marketplace']!.source).isSwitchable).toBe(false)
  expect(hintOf({ command: 'inventory', hasPane: true })).toBe('/inventory to open')
  expect(hintOf({ command: 'handoff-new', hasPane: false })).toBe('/handoff-new to run')
  expect(withOff({}, 'a', true)).toEqual({ a: false })
  expect(withOff({ a: false, b: false }, 'a', false)).toEqual({ b: false })
  expect(withHidden({}, 'a', true)).toEqual({ 'a:hidden': true })
})

// ── The pane ────────────────────────────────────────────────────────────

test('the pane lists only mods: yours first, then others, each with icon, description and how to reach it', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPane($)
  expect(w.opens).toEqual(['mod-manager'])
  const all = await texts(ui)
  expect(all).toMatch(/Your mods/)
  expect(all).toMatch(/▤ Chat Inventory/)
  expect(all).toMatch(/A side pane, In this chat, with live cards$/m)
  expect(all).toMatch(/\/inventory to open/)
  expect(all).toMatch(/◷ Cache Clock & Handoff/)
  expect(all).toMatch(/\/handoff-new to run/)
  expect(all).toMatch(/Other mods/)
  expect(all).toMatch(/↻ Reflect/)
  expect(all).not.toMatch(/Superpowers|superpowers/)
  expect(all.indexOf('Chat Inventory')).toBeLessThan(all.indexOf('Reflect'))
  expect(all).toMatch(/Off means off in every chat\. Hidden keeps it on but out of sight\. Changes apply within 3 seconds\. New mods appear here by themselves\./)
  await ui.unmount()
})

test('turning one of your mods off writes the switch file at once, with no CLI call, and the footer confirms it', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPane($)
  const before = w.cli.length
  await ui.press({ key: 'switch:chat-inventory@my-mods' })
  expect(switches(w)).toEqual({ 'chat-inventory': false })
  expect(w.cli.slice(before).filter(a => a[2] !== 'list')).toEqual([])
  const all = await texts(ui)
  expect(all).toMatch(/Chat Inventory is off in every chat\./)
  expect(all).toMatch(/○ Off/)
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeFalsy()
  await ui.press({ key: 'switch:chat-inventory@my-mods' })
  expect(switches(w)).toEqual({})
  expect(await texts(ui)).toMatch(/Chat Inventory is on in every chat\./)
  await ui.unmount()
})

test('the eye hides one of your mods in every chat, keeping it on', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPane($)
  await ui.press({ key: 'eye:cache-handoff@my-mods' })
  expect(switches(w)).toEqual({ 'cache-handoff:hidden': true })
  const all = await texts(ui)
  expect(all).toMatch(/Cache Clock & Handoff is hidden in every chat\. It keeps working, out of sight\./)
  expect(all).toMatch(/◌ Hidden/)
  expect(all).toMatch(/≡ Mods\s+4 on/)
  await ui.press({ key: 'eye:cache-handoff@my-mods' })
  expect(switches(w)).toEqual({})
  // Mods that cannot hide have no eye.
  expect(await ui.find({ type: 'Button', key: 'eye:reflect-mod@claude-reflect-marketplace' })).toBeFalsy()
  await ui.unmount()
})

test('another mod is really disabled through the CLI and says it applies after a reload, with Apply', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPane($)
  await ui.press({ key: 'switch:reflect-mod@claude-reflect-marketplace' })
  expect(w.cli).toContainEqual(['claude', 'plugin', 'disable', 'reflect-mod@claude-reflect-marketplace', '--scope', 'user'])
  expect(w.files[SWITCH_FILE]).toBeUndefined()
  const all = await texts(ui)
  expect(all).toMatch(/applies after reload/)
  expect(all).toMatch(/Reflect is disabled\. It applies after a reload: press Apply\./)
  await ui.press({ key: 'apply' })
  expect(w.commands.map(c => c.command)).toContain('reload-plugins')
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeFalsy()
  await ui.unmount()
})

test('a change made in another chat shows within 3 seconds', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPane($)
  w.files[SWITCH_FILE] = JSON.stringify({ 'chat-inventory': false })
  await w.clock.advance(3000)
  expect(await texts(ui)).toMatch(/≡ Mods\s+3 on · 1 off/)
  await ui.unmount()
})

test('a new mod appears by itself while the pane is open', async ($, on) => {
  const extra: Record<string, { source: string; description: string }> = {}
  const w = world(on, extra)
  await start($)
  const ui = await openPane($)
  expect(await texts(ui)).not.toMatch(/Brand New/)
  extra['brand-new@my-mods'] = { description: 'Just built.', source: "await watchSwitch($, 'brand-new', 'x')" }
  w.enabled['brand-new@my-mods'] = true
  w.files['/inst/brand-new/.claude-plugin/plugin.json'] = JSON.stringify({ description: 'Just built.' })
  w.files['/inst/brand-new/hooks/hooks.json'] = '{ "modules": ["./register.tsx"] }'
  w.files['/inst/brand-new/hooks/register.tsx'] = "await watchSwitch($, 'brand-new', 'x')"
  await w.clock.advance(10_000)
  expect(await texts(ui)).toMatch(/Brand New/)
  await ui.unmount()
})

test('Open runs a pane mod\'s command; the Mods row itself has no switch', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPane($)
  await ui.press({ key: 'open:chat-inventory@my-mods' })
  expect(w.commands).toContainEqual({ command: 'inventory', args: '' })
  expect(await ui.find({ type: 'Button', key: 'open:cache-handoff@my-mods' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'switch:mod-manager@my-mods' })).toBeFalsy()
  expect(await texts(ui)).toMatch(/this pane/)
  await ui.unmount()
})

test('search and the On/Off filter narrow the list', async ($, on) => {
  const w = world(on)
  w.files[SWITCH_FILE] = JSON.stringify({ 'cache-handoff': false })
  await start($)
  const ui = await openPane($)
  await ui.press({ key: 'filter-off' })
  let all = await texts(ui)
  expect(all).toMatch(/Cache Clock/)
  expect(all).not.toMatch(/Chat Inventory/)
  await ui.press({ key: 'filter-all' })
  await ui.input({ key: 'search', text: 'reflect' } as any)
  all = await texts(ui)
  expect(all).toMatch(/Reflect/)
  expect(all).not.toMatch(/Chat Inventory/)
  await ui.unmount()
})

test('j moves the cursor and t switches the highlighted mod', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPane($)
  await ui.press({ key: 'down' })
  await ui.press({ key: 'toggle' })
  // Your mods A to Z by title: Cache Clock & Handoff, then Chat Inventory.
  expect(switches(w)).toEqual({ 'chat-inventory': false })
  await ui.unmount()
})

test('/mods text commands: list, disable, hide and show', async ($, on) => {
  const w = world(on)
  await start($)
  let r = await mods($, 'disable chat-inventory')
  expect(r.text).toBe('Chat Inventory is off in every chat.')
  r = await mods($, 'hide Cache Clock & Handoff')
  expect(r.text).toMatch(/hidden in every chat/)
  r = await mods($, 'list')
  expect(r.text).toMatch(/^3 of 4 mods on:/)
  expect(r.text).toMatch(/\[off\] Chat Inventory/)
  expect(r.text).toMatch(/\[ON \] Cache Clock & Handoff \(cache-handoff@my-mods v1\.0\.0, hidden\)/)
  r = await mods($, 'show cache-handoff')
  expect(switches(w)).toEqual({ 'chat-inventory': false })
  r = await mods($, 'status nothing-here')
  expect(r.text).toMatch(/No installed mod named "nothing-here"/)
})

test('the status-bar button shows how many are on and opens and closes the pane', async ($, on) => {
  const w = world(on)
  w.files[SWITCH_FILE] = JSON.stringify({ 'cache-handoff': false })
  await start($)
  await w.clock.advance(1)
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /≡ Mods 3\/4/ })).toBeTruthy()
  await bar.press({ key: 'open-mod-manager' })
  expect(w.opens).toEqual(['mod-manager'])
  await bar.press({ key: 'open-mod-manager' })
  expect(w.closes).toEqual(['mod-manager'])
  await bar.unmount()
})

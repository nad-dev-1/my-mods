import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'mod-manager',
  component: 'Pane',
  requestId: 'mod-manager',
  props: {
    title: 'Mods',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const CWD = '/work/app'

function fakeCli(
  on: any,
  calls: string[][],
  opens: any[] = [],
  extra: Record<string, boolean> = {},
) {
  const enabled: Record<string, boolean> = {
    'alpha@market': true,
    'beta@market': false,
    ...extra,
  }
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    calls.push(argv)
    const [, , verb, id] = argv
    if (verb === 'list') {
      const list: object[] = Object.entries(enabled).map(([key, isOn]) => ({
        id: key,
        scope: 'user',
        version: '1.0.0',
        enabled: isOn,
      }))
      // Installed for another project, twice: never shown here.
      const elsewhere = {
        id: 'gamma@market',
        scope: 'local',
        version: '1.0.0',
        enabled: false,
        projectPath: '/work/other',
      }
      list.push(elsewhere, elsewhere)
      // Installed for this project: shown once.
      const here = { ...elsewhere, id: 'delta@market', projectPath: CWD }
      list.push(here, here)

      return { value: { exitCode: 0, stdout: JSON.stringify(list), stderr: '' } }
    }
    if ((verb === 'enable' || verb === 'disable') && id) {
      enabled[id] = verb === 'enable'

      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }

    return { value: { exitCode: 1, stdout: '', stderr: 'unknown' } }
  })
  on('command.register', () => ({ value: { command: 'mods' } }))
  on('ui.open', (_: unknown, e: any) => {
    opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
}

async function start($: any) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

test('/mods list prints the mods that apply here, once each', async ($, on) => {
  fakeCli(on, [])
  await start($)

  const { text } = await $.command.run({ command: 'mods', args: 'list' })

  expect(text).toContain('1 of 3 mods enabled')
  expect(text).toContain('[ON ] alpha@market')
  expect(text).toContain('[off] beta@market')
  expect(text).toContain('[off] delta@market v1.0.0 (local)')
  expect(text).not.toContain('gamma')
  expect(text!.split('delta@market').length).toBe(2)
})

test('/mods opens the panel and says how to use it', async ($, on) => {
  fakeCli(on, [])
  await start($)

  const { text } = await $.command.run({ command: 'mods' })

  expect(text).toContain('1 of 3 mods on')
  expect(text).toContain('Enter toggles')
})

test('/mods disable <short name> runs the CLI and reports it', async ($, on) => {
  const calls: string[][] = []
  fakeCli(on, calls)
  await start($)

  const { text } = await $.command.run({ command: 'mods', args: 'disable alpha' })

  expect(text).toContain('Disabled alpha@market')
  expect(calls).toContainEqual([
    'claude', 'plugin', 'disable', 'alpha@market', '--scope', 'user',
  ])
  const status = await $.command.run({ command: 'mods', args: 'status alpha' })
  expect(status.text).toContain('[off] alpha@market')
})

test('/mods status on an unknown name says so', async ($, on) => {
  fakeCli(on, [])
  await start($)

  const { text } = await $.command.run({ command: 'mods', args: 'status nope' })

  expect(text).toContain('No installed mod named "nope"')
})

test('a row in the panel is a switch: a press turns the mod on', async ($, on) => {
  const calls: string[][] = []
  fakeCli(on, calls)
  await start($)
  await $.command.run({ command: 'mods' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'beta@market#user' })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / ● OFF / })).toBeTruthy()
  await ui.press({ key: 'beta@market#user' })

  expect(calls).toContainEqual([
    'claude', 'plugin', 'enable', 'beta@market', '--scope', 'user',
  ])
  expect(await ui.find({ type: 'Text', text: /^2 on$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeTruthy()
  await ui.unmount()
})

test('the Off filter hides the mods that are on', async ($, on) => {
  fakeCli(on, [])
  await start($)
  await $.command.run({ command: 'mods' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'filter-off' })

  expect(await ui.find({ type: 'Button', key: 'alpha@market#user' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'beta@market#user' })).toBeTruthy()
  await ui.unmount()
})

test('j moves the cursor down and t toggles the highlighted mod', async ($, on) => {
  const calls: string[][] = []
  fakeCli(on, calls)
  await start($)
  await $.command.run({ command: 'mods' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Sorted: alpha, beta, delta. The cursor starts on alpha.
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeTruthy()

  await ui.press({ key: 'down' })
  await ui.press({ key: 'toggle' })

  expect(calls).toContainEqual([
    'claude', 'plugin', 'enable', 'beta@market', '--scope', 'user',
  ])
  expect(calls.some(c => c[2] === 'disable')).toBe(false)

  await ui.press({ key: 'up' })
  await ui.press({ key: 'toggle' })
  expect(calls).toContainEqual([
    'claude', 'plugin', 'disable', 'alpha@market', '--scope', 'user',
  ])
  await ui.unmount()
})

const STATUS_BAR = {
  plugin: 'mod-manager',
  component: 'SessionMode',
  props: { modes: [] },
} as const

test('the status-bar Mods button shows the count and opens the sheet', async ($, on) => {
  const opens: any[] = []
  fakeCli(on, [], opens)
  await start($)
  await $.command.run({ command: 'mods', args: 'list' })

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' })
  expect(await bar.find({ type: 'Text', text: /≡ Mods 1\/3/ })).toBeTruthy()

  await bar.press({ key: 'open-mod-manager' })
  expect(opens.some(o => o.id === 'mod-manager' && o.focus === true && o.closeOnEscape === true)).toBe(true)
  await bar.unmount()
})

test('a second press on the Mods button closes the sheet', async ($, on) => {
  const closes: any[] = []
  fakeCli(on, [])
  on('ui.close', (_: unknown, e: any) => {
    closes.push(e)

    return { value: undefined }
  })
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' })
  await bar.press({ key: 'open-mod-manager' })
  await bar.press({ key: 'open-mod-manager' })

  expect(closes.some(c => c.id === 'mod-manager')).toBe(true)
  await bar.unmount()
})

test('each sheet row ends in a switch that reads ON or OFF', async ($, on) => {
  fakeCli(on, [])
  await start($)
  await $.command.run({ command: 'mods' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ {2}ON ● $/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^ ● OFF $/ })).toBeTruthy()
  await ui.unmount()
})

test('the sheet groups mods: My mods, Official, Community', async ($, on) => {
  fakeCli(on, [], [], {
    'mine@my-mods': true,
    'kit@claude-plugins-official': false,
  })
  await start($)
  await $.command.run({ command: 'mods' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'group#mine' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'group#official' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'group#community' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'group#synced' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /My mods/ })).toBeTruthy()
  await ui.unmount()
})

test('pressing a group header folds it, and again unfolds it', async ($, on) => {
  fakeCli(on, [], [], { 'mine@my-mods': true })
  await start($)
  await $.command.run({ command: 'mods' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'alpha@market#user' })).toBeTruthy()

  await ui.press({ key: 'group#community' })
  expect(await ui.find({ type: 'Button', key: 'alpha@market#user' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'group#community' })).toBeTruthy()
  // The other group stays open.
  expect(await ui.find({ type: 'Button', key: 'mine@my-mods#user' })).toBeTruthy()

  await ui.press({ key: 'group#community' })
  expect(await ui.find({ type: 'Button', key: 'alpha@market#user' })).toBeTruthy()
  await ui.unmount()
})

test('Fold all hides every mod; Unfold all brings them back', async ($, on) => {
  fakeCli(on, [], [], { 'mine@my-mods': true })
  await start($)
  await $.command.run({ command: 'mods' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fold-all' })
  expect(await ui.find({ type: 'Button', key: 'alpha@market#user' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'mine@my-mods#user' })).toBeFalsy()

  await ui.press({ key: 'unfold-all' })
  expect(await ui.find({ type: 'Button', key: 'mine@my-mods#user' })).toBeTruthy()
  await ui.unmount()
})

test('every mod is drawn, even past the sheet height, so the list scrolls', async ($, on) => {
  const many: Record<string, boolean> = {}
  for (let i = 0; i < 40; i++) many[`m${String(i).padStart(2, '0')}@market`] = i % 2 === 0
  fakeCli(on, [], [], many)
  await start($)
  await $.command.run({ command: 'mods' })

  const short = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 8 } } }
  const ui = await $.ui.mount({ ...short, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'm00@market#user' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'm39@market#user' })).toBeTruthy()
  await ui.unmount()
})

test('/mods tells the person which keys drive the panel', async ($, on) => {
  fakeCli(on, [])
  await start($)

  const { text } = await $.command.run({ command: 'mods' })

  expect(text).toContain('j/k')
  expect(text).toContain('ctrl+x then Tab')
})

import { expect, mock, test } from 'claude-code/testing'

const STATUS_BAR = { plugin: 'filetree-button', component: 'SessionMode', props: { modes: [] } } as const
const TREE = { name: 'filetree', description: '', source: 'plugin', plugin: 'filetree', isFullscreen: false }

function world(on: any, commands: object[] = [TREE], answer = 'File tree on ~/work.') {
  const clock = mock.clock(on, { now: 1_000_000 })
  const runs: string[] = []
  const toasts: string[] = []
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.list', () => ({ value: commands }))
  on('command.run', (_: unknown, e: any) => {
    runs.push(e.command)

    return { text: answer }
  })
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text ?? String(e))

    return { value: undefined }
  })

  return { clock, runs, toasts }
}

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

test('the status bar shows a Files button, and a press runs /filetree', async ($, on) => {
  const w = world(on)
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /^▤ Files$/ })).toBeTruthy()
  await bar.press({ key: 'toggle-filetree' })
  await w.clock.settle()
  expect(w.runs).toEqual(['filetree'])
  expect(w.toasts).toEqual([])
  await bar.unmount()
})

test('when the tree cannot show, the reason comes up as a toast', async ($, on) => {
  const w = world(on, [TREE], 'filetree shows in the sidebar, which needs the fullscreen layout. Run /tui fullscreen, then /filetree.')
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  await bar.press({ key: 'toggle-filetree' })
  await w.clock.settle()
  expect(w.toasts.some(t => /fullscreen/.test(t))).toBe(true)
  await bar.unmount()
})

test('with filetree off, a press says so', async ($, on) => {
  const w = world(on, [])
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  await bar.press({ key: 'toggle-filetree' })
  await w.clock.settle()
  expect(w.runs).toEqual([])
  expect(w.toasts.some(t => /not on/.test(t))).toBe(true)
  await bar.unmount()
})

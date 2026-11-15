import { expect, mock, test } from 'claude-code/testing'

const STATUS_BAR = {
  plugin: 'replay-button',
  component: 'SessionMode',
  props: { modes: [] },
} as const

const REPLAY = { name: 'replay', description: '', source: 'plugin', plugin: 'replay-theater', isFullscreen: false }

function world(on: any, commands: object[] = [REPLAY], answer = 'Replay Theater: 2 edits') {
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
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_: unknown, e: any) => ({ text: e.text, turnId: e.turnId ?? 't' }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))

  return { clock, runs, toasts }
}

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

async function turnWithEdits($: any, n: number) {
  await $.turn.start({ text: 'go', turnId: 't' })
  for (let i = 0; i < n; i++) {
    await $.tool.call({ tool: 'Edit', file_path: `/work/f${i}.ts`, old_string: 'a', new_string: 'b' })
  }
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
}

test('the status bar shows a Replay button before any edits', async ($, on) => {
  world(on)
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Button', key: 'open-replay' })).toBeTruthy()
  expect(await bar.find({ type: 'Text', text: /^▶ Replay$/ })).toBeTruthy()
  await bar.unmount()
})

test('after a turn that edits files, the button counts the edits', async ($, on) => {
  world(on)
  await start($)
  await turnWithEdits($, 3)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /^▶ Replay 3$/ })).toBeTruthy()
  await bar.unmount()
})

test('a turn with no edits keeps the last count', async ($, on) => {
  world(on)
  await start($)
  await turnWithEdits($, 2)
  await turnWithEdits($, 0)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /^▶ Replay 2$/ })).toBeTruthy()
  await bar.unmount()
})

test('pressing the button runs /replay', async ($, on) => {
  const w = world(on)
  await start($)
  await turnWithEdits($, 2)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  await bar.press({ key: 'open-replay' })
  await w.clock.settle()
  expect(w.runs).toEqual(['replay'])
  await bar.unmount()
})

test('with Replay Theater off, a press says so instead', async ($, on) => {
  const w = world(on, [])
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  await bar.press({ key: 'open-replay' })
  await w.clock.settle()
  expect(w.runs).toEqual([])
  expect(w.toasts.some(t => /not on/.test(t))).toBe(true)
  await bar.unmount()
})

test('with nothing to replay, a press says there are no edits', async ($, on) => {
  const w = world(on, [REPLAY], 'Replay Theater: no edits in the last turn.')
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  await bar.press({ key: 'open-replay' })
  await w.clock.settle()
  expect(w.toasts.some(t => /no file edits/.test(t))).toBe(true)
  await bar.unmount()
})

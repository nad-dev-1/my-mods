import { expect, mock, test } from 'claude-code/testing'

// The Mods panel's switch (hooks/switch.tsx): off or hidden in
// ~/.claude/mods/switches.json, this mod draws nothing within 3 seconds.

const NAME = 'git-review'
const BUTTON = 'open-git-review'
const COMMAND = 'git-review'
const FILE = '/Users/tester/.claude/mods/switches.json'
const BAR = { plugin: NAME, component: 'SessionMode', props: { modes: [] } } as const

function world(on: any) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  const w = { file: '{}' }
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/Users/tester' : undefined }))
  on('fs.read', (_: unknown, e: any) => {
    if (e.path === FILE) return { value: w.file }
    throw new Error('ENOENT')
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))

  return Object.assign(w, { clock })
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }).catch(() => undefined)
const button = async ($: any) => {
  const bar = await $.ui.mount({ ...BAR, surface: 'terminal' } as any)
  const found = await bar.find({ type: 'Button', key: BUTTON })
  await bar.unmount()

  return Boolean(found)
}

test('switched off or hidden in /mods, the status-bar button goes within 3 seconds; back on, it returns', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await button($)).toBe(true)
  w.file = JSON.stringify({ [NAME]: false })
  await w.clock.advance(3000)
  expect(await button($)).toBe(false)
  w.file = JSON.stringify({ [`${NAME}:hidden`]: true })
  await w.clock.advance(3000)
  expect(await button($)).toBe(false)
  w.file = '{}'
  await w.clock.advance(3000)
  expect(await button($)).toBe(true)
})

test('while off, its command says so and does nothing else', async ($, on) => {
  if (!COMMAND) return
  const w = world(on)
  w.file = JSON.stringify({ [NAME]: false })
  await start($)
  const r = await ($ as any).command.run({ command: COMMAND, args: '', origin: { kind: 'composer' } })
  expect(r.text).toBe('Git Review is off. Turn it on in /mods.')
})

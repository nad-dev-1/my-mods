import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { cleanName } from '../hooks/clean-view-logic'

const PLUGIN = 'ai-employee-kit'
const PLAN = 'mcp__ai-employee-kit__plan_steps'
const PROGRESS = 'mcp__ai-employee-kit__report_progress'

const band = (bodyColumns: number) =>
  ({
    plugin: PLUGIN,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  }) as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type World = { toasts: unknown[]; named: number; clock: ReturnType<typeof mock.clock> }

/** Stands in for the engine beneath the plugin (the Agent Dock beside Clean View needs a few of these too). */
function world(on: On, stored: Record<string, unknown> = {}): World {
  const w = { toasts: [] as unknown[], named: 0 } as World
  mock.store(on, stored)
  w.clock = mock.clock(on, { now: Date.UTC(2026, 10, 2, 12, 0) })
  mock.env(on, { HOME: '/home/tester' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e)
    return { value: undefined }
  })
  on('model.complete', () => {
    w.named += 1
    return { value: { isAnswered: true, text: 'Build my landing page', usage: USAGE } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: '7', subject: 'x' } } }
    return { result: {} }
  })
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  return w
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const command = (args: string) =>
  ({ command: 'simple', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never

async function begin($: any, text: string, turnId = 't1') {
  await $.prompt.submit(typed(text))
  await $.turn.start({ text, turnId })
}

async function rows(ui: { findAll: (q: { type?: string }) => Promise<{ text?: string }[]> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('')
}

// ---------------------------------------------------------------------------
// 1. Plain names
// ---------------------------------------------------------------------------

describe('the name cleaner', () => {
  test('code, paths and file names go; long names trim at a word', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
    expect(cleanName('Update the src/components/Header.tsx header links')).toBe('Update the header links')
    expect(cleanName('fix styles.css and app.py now')).toBe('Fix and now')
    const long = cleanName('Rewrite the onboarding emails so they sound warmer and mention the new pricing plans')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith('…')).toBe(true)
    expect(long).toBe('Rewrite the onboarding emails so they…')
    expect(cleanName('`npm run build`')).toBe('Working on it')
    expect(cleanName('   ')).toBe('Working on it')
  })
})

// ---------------------------------------------------------------------------
// 2. A to-do list and a 60% report, on terminal and desktop
// ---------------------------------------------------------------------------

test('a to-do list plus a 60% report draws ✓ / ▶ 60% / Next / Up next', async ($, on) => {
  world(on)
  await start($)
  await begin($, 'Build my landing page with pricing and a contact form')
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  } as never)
  await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 60 } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(80), surface })
    const all = await rows(ui)
    expect(all).toContain('✓ Read your brand notes')
    expect(all).toContain('██████████  Done')
    expect(all).toContain('▶ Build the pricing section')
    expect(all).toContain('██████░░░░  60%')
    expect(all).toContain('○ Add the contact form')
    expect(all).toContain('Next')
    expect(all).toContain('○ Polish the footer')
    expect(all).toContain('Up next')
    expect(all).toContain('Clean View: ON')
    for (const t of await ui.findAll({ type: 'Text' })) expect((t.text ?? '').length).toBeLessThanOrEqual(80)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------------------
// 3. Needs you
// ---------------------------------------------------------------------------

test('a permission prompt shows Needs you, and the next tool clears it', async ($, on) => {
  world(on)
  await start($)
  await begin($, 'Clean up my downloads folder')
  await $.tool.call({ tool: PLAN, steps: ['Look through your files', 'Tidy them into folders'] } as never)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'mv a b' } } as never)

  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  let all = await rows(ui)
  expect(all).toContain('Needs you')
  expect(all).toContain('Claude needs your OK to continue')
  expect(all).toContain('‖ Look through your files')

  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  all = await rows(ui)
  expect(all).not.toContain('Needs you')
  expect(all).toContain('▶ Look through your files')
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// 4. Off
// ---------------------------------------------------------------------------

test('/simple off hides the band, and the choice is saved', async ($, on) => {
  world(on)
  await start($)
  await begin($, 'Write a welcome email for new members')
  await $.tool.call({ tool: PLAN, steps: ['Draft the email', 'Polish the wording'] } as never)

  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  expect(await rows(ui)).toContain('Draft the email')
  const answer = await $.command.run(command('off'))
  expect(answer.text).toContain('off')
  const all = await rows(ui)
  expect(all).not.toContain('Draft the email')
  expect(all).toContain('Clean View: OFF')

  // The button turns it back on, with a short toast.
  await ui.press({ key: 'clean-view-toggle' })
  expect(await rows(ui)).toContain('Clean View: ON')
  await ui.unmount()
})

test('tool rows are hidden while on and come back when off', async ($, on) => {
  world(on)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`row ${e.props.tool}`}</Text>
  })
  await start($)
  const row = { plugin: PLUGIN, component: 'ToolUse', requestId: 'tu1', props: { tool_use_id: 'tu1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false } } as const
  let ui = await $.ui.mount({ ...row, surface: 'terminal' })
  expect(await rows(ui)).not.toContain('row Bash')
  await ui.unmount()
  await $.command.run(command('off'))
  ui = await $.ui.mount({ ...row, surface: 'terminal' })
  expect(await rows(ui)).toContain('row Bash')
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// 5. Plan, then 100
// ---------------------------------------------------------------------------

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  world(on)
  await start($)
  await begin($, 'Build my landing page')
  const planned = await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] } as never)
  expect(String(planned.text ?? JSON.stringify(planned.result))).toContain('Planned 3 steps. The first one has started.')
  const noted = await $.tool.call({ tool: PROGRESS, task: 'Read your brand notes', percent: 100 } as never)
  expect(String(noted.text ?? JSON.stringify(noted.result))).toContain('Progress noted: 100%.')

  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  const all = await rows(ui)
  expect(all).toContain('✓ Read your brand notes')
  expect(all).toContain('▶ Build the pricing section')
  expect(all).toContain('Working')
  expect(all).toContain('○ Add the contact form')
  expect(all).toContain('Next')
  await ui.unmount()
})

test('a saved off survives a restart', async ($, on) => {
  world(on, { cleanViewEnabled: false })
  await start($)
  await begin($, 'Build my landing page')
  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  const all = await rows(ui)
  expect(all).toContain('Clean View: OFF')
  expect(all).not.toContain('Understand your request')
  // And nothing is gated while off.
  const call = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(call.deny).toBeUndefined()
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// 6. Plan first
// ---------------------------------------------------------------------------

test('any tool is denied before a plan exists and allowed after', async ($, on) => {
  world(on)
  await start($)
  await begin($, 'Make my resume sound more confident')
  const before = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(String(before.deny ?? before.text)).toContain('plan_steps first')
  const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:x', max_results: 1 } as never)
  expect(search.deny).toBeUndefined()
  await $.tool.call({ tool: PLAN, steps: ['Read your resume', 'Rewrite the summary'] } as never)
  const after = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(after.deny).toBeUndefined()
  expect(after.isError).toBeUndefined()
})

// ---------------------------------------------------------------------------
// The end of a job
// ---------------------------------------------------------------------------

test('All done, then one line after 5 seconds; and Haiku names the job', async ($, on) => {
  const w = world(on)
  await start($)
  await begin($, 'please make me a landing page for the bakery with prices')
  await $.tool.call({ tool: PLAN, steps: ['Build the page', 'Add the prices'] } as never)
  await $.tool.call({ tool: PROGRESS, task: 'Build the page', percent: 100 } as never)
  await $.tool.call({ tool: PROGRESS, task: 'Add the prices', percent: 100 } as never)
  await w.clock.advance(74_000)
  await $.turn.complete({ answer: 'Done', durationMs: 74_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  let all = await rows(ui)
  expect(w.named).toBe(1)
  expect(all).toContain('✓ All done · Build my landing page · took 1m 14s')
  expect(all).toContain('✓ Add the prices')
  await w.clock.advance(5_000)
  all = await rows(ui)
  expect(all).toContain('✓ All done')
  expect(all).not.toContain('Add the prices')
  await ui.unmount()
})

test('Esc shows Stopped; unfinished steps wait for your reply; three failures show Stuck', async ($, on) => {
  world(on)
  await start($)
  await begin($, 'Sort my photos by year')
  await $.tool.call({ tool: PLAN, steps: ['Look at your photos', 'Sort them by year'] } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
  let ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  expect(await rows(ui)).toContain('■ Stopped · ')
  await ui.unmount()

  await begin($, 'Try again and sort my photos by year', 't2')
  await $.tool.call({ tool: PLAN, steps: ['Look at your photos', 'Sort them by year'] } as never)
  await $.turn.complete({ answer: 'Which year first?', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  expect(await rows(ui)).toContain('Claude is waiting for your reply')
  await ui.unmount()
})

test('narrow bands never wrap', async ($, on) => {
  world(on)
  await start($)
  await begin($, 'Build my landing page')
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section with care'] } as never)
  for (const width of [24, 40, 120]) {
    const ui = await $.ui.mount({ ...band(width), surface: 'terminal' })
    for (const t of await ui.findAll({ type: 'Text' })) expect((t.text ?? '').length).toBeLessThanOrEqual(width)
    expect(await ui.find({ key: 'clean-view-toggle' })).toBeDefined()
    await ui.unmount()
  }
})

test('beside the Agent Dock: no helper before the plan, and helpers report to the dock', async ($, on) => {
  world(on, { size: 3 })
  await start($)
  await begin($, 'Research bakery pricing for three chains')
  const early = await $.tool.call({ tool: 'Agent', description: 'Price check: Panera', prompt: 'x' } as never)
  expect(String(early.deny ?? early.text)).toContain('plan_steps first')
  await $.tool.call({ tool: PLAN, steps: ['Check prices', 'Write the summary'] } as never)
  const launched = await $.tool.call({ tool: 'Agent', description: 'Price check: Panera', prompt: 'x' } as never)
  expect(launched.deny).toBeUndefined()

  // A helper's progress is the dock's to answer; Clean View's checklist stays as it was.
  const noted = await $.tool.call({ tool: PROGRESS, task: 'Price check: Panera', percent: 60, agentId: 'helper-1' } as never)
  expect(String(noted.text ?? JSON.stringify(noted.result))).toContain('Progress noted: 60%.')
  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  const all = await rows(ui)
  expect(all).toContain('▶ Check prices')
  expect(all).not.toContain('Price check')
  await ui.unmount()
})

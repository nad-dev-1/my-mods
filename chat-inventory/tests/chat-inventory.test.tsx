import { expect, mock, test } from 'claude-code/testing'

import { cliHits, hitsOf, splitMcp } from '../hooks/inventory-logic'

const PANE = {
  plugin: 'chat-inventory',
  component: 'Pane',
  requestId: 'chat-inventory',
  props: { title: 'In this chat', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const STATUS_BAR = { plugin: 'chat-inventory', component: 'SessionMode', props: { modes: [] } } as const

const HOME = '/Users/tester'
const JIRA = 'mcp__claude_ai_Atlassian_MCP__getJiraIssue'
const SEARCH_JIRA = 'mcp__claude_ai_Atlassian_MCP__searchJiraIssuesUsingJql'

type World = {
  clock: ReturnType<typeof mock.clock>
  messages: Record<string, any[]>
  agents: any[]
  memoryFiles: string[]
  opens: string[]
  closes: string[]
  copies: string[]
  ran: string[][]
}

function world(on: any): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 15, 9, 30) })
  mock.store(on, {})
  const w: Omit<World, 'clock'> = { messages: { main: [] }, agents: [], memoryFiles: [], opens: [], closes: [], copies: [], ran: [] }
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('command.register', () => ({ value: undefined }))
  on('command.list', () => ({ value: [{ name: 'graphify', description: '', source: 'user', isFullscreen: false }] }))
  on('command.run', () => ({ text: '' }))
  on('session.messages', (_: unknown, e: any) => ({ value: w.messages[e?.agentId ?? 'main'] ?? [] }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, tokens: 1000, percent: 1, breakdown: { memoryFiles: w.memoryFiles.map(path => ({ path, type: 'Project', tokens: 10 })), skills: { skillFrontmatter: [{ name: 'graphify' }] } } },
      rateLimits: [],
    },
  }))
  on('agent.list', () => ({ value: w.agents }))
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(10 + e.subject.length), subject: e.subject } } }
    return { result: {} }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', (_: unknown, e: any) => {
    w.opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: any) => {
    w.closes.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', (_: unknown, e: any) => {
    w.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('process.run', (_: unknown, e: any) => {
    w.ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return Object.assign(w, { clock }) as World
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const call = ($: any, input: Record<string, unknown>) => $.tool.call(input as never)
const mount = ($: any) => $.ui.mount({ ...PANE, surface: 'terminal' } as any)

/** Every text the pane shows, button captions included. */
const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    .map((t: any) => [t.text, t.label, t.props?.label].filter(Boolean).join(' '))
    .join('\n')

// ── What a call counts as ───────────────────────────────────────────────

test('MCP servers get the names people know', () => {
  expect(splitMcp(JIRA)).toMatchObject({ server: 'Atlassian', tool: 'getJiraIssue' })
  expect(splitMcp('mcp__claude_ai_gitlab__get_merge_request')?.server).toBe('GitLab')
  expect(splitMcp('mcp__plugin_supabase_supabase__execute_sql')?.server).toBe('Supabase')
  expect(splitMcp('mcp__plugin_dart-flutter_dart-mcp-server__hot_reload')?.server).toBe('Dart')
  expect(splitMcp('mcp__qa-flow__run_api')?.server).toBe('QA Flow')
  expect(splitMcp('mcp__some_new_server__do_it')?.server).toBe('Some New Server')
  expect(splitMcp('Bash')).toBe(null)
})

test('your command-line tools count as connectors, through rtk and env, but plain shell does not', () => {
  expect(cliHits('gh pr view 12 --json title')).toEqual([{ kind: 'connector', name: 'GitHub', tool: 'pr view', summary: 'pr view 12' }])
  expect(cliHits('cd web && rtk glab mr list')[0]).toMatchObject({ name: 'GitLab', tool: 'mr list' })
  expect(cliHits('FOO=1 supabase db push')[0]).toMatchObject({ name: 'Supabase' })
  expect(cliHits('git status && npm test && ls')).toEqual([])
  expect(cliHits('echo ghost')).toEqual([])
  const tb = cliHits('terminal-browser open https://example.com/a --split right')
  expect(tb.map(h => h.kind)).toEqual(['connector', 'web'])
  expect(tb[1]).toMatchObject({ site: 'example.com' })
})

test('reads are context files, SKILL.md reads are skills, and scratch files are skipped', () => {
  expect(hitsOf('Read', { file_path: '/work/a.ts' })).toEqual([{ kind: 'file', path: '/work/a.ts' }])
  expect(hitsOf('Read', { file_path: '/x/skills/graphify/SKILL.md' })).toEqual([{ kind: 'skill', name: 'graphify' }])
  expect(hitsOf('Read', { file_path: '/Users/t/.claude/projects/p/s/tool-results/b1.txt' })).toEqual([])
  expect(hitsOf('Read', { file_path: '/private/tmp/x.txt' })).toEqual([])
  expect(hitsOf('WebFetch', { url: 'https://www.anthropic.com/news', prompt: 'x' })).toEqual([{ kind: 'web', site: 'anthropic.com', detail: 'https://www.anthropic.com/news' }])
  expect(hitsOf('mcp__ai-employee-kit__plan_steps', { steps: ['a'] })).toEqual([])
  expect(hitsOf('TodoWrite', { todos: [] })).toEqual([])
})

// ── The pane ────────────────────────────────────────────────────────────

test('an empty chat shows the six cards with their empty lines, and Copy and Hide', async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($)
  const all = await texts(ui)
  for (const title of ['In this chat', 'To-do', 'Connectors', 'Context files', 'Skills', 'Subagents', 'Web pages']) expect(all).toContain(title)
  expect(all).toMatch(/No to-do list yet/)
  expect(all).toMatch(/None used yet/)
  expect(all).toMatch(/None read yet/)
  expect(all).toMatch(/None ran yet/)
  expect(await ui.find({ type: 'Button', key: 'inv-copy' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'inv-hide' })).toBeTruthy()
  await ui.unmount()
})

test('connector calls count live, show the last tool, and the new count lights up for a few seconds', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await mount($)
  await call($, { tool: JIRA, issueIdOrKey: 'SA-1' })
  await call($, { tool: SEARCH_JIRA, jql: 'project = SA' })
  await call($, { tool: 'Bash', command: 'rtk gh pr view 12' })
  await call($, { tool: 'Bash', command: 'git status' })
  const all = await texts(ui)
  expect(all).toMatch(/Atlassian\s+searchJiraIssuesUsingJql/)
  expect(all).toMatch(/2 calls/)
  expect(all).toMatch(/GitHub\s+pr view/)
  expect(all).toMatch(/1 call/)
  expect(all).not.toMatch(/\bgit\b/)
  const lit = async () => (await ui.findAll({ type: 'Text' })).filter((t: any) => t.props?.backgroundColor === '#F2C46D').length
  expect(await lit()).toBeGreaterThan(0)
  await w.clock.advance(5000)
  expect(await lit()).toBe(0)
  await ui.unmount()
})

test('a connector pressed unfolds its calls with what each asked for; pressed again it folds', async ($, on) => {
  world(on)
  await start($)
  await call($, { tool: JIRA, issueIdOrKey: 'SA-1' })
  await call($, { tool: SEARCH_JIRA, jql: 'project = SA' })
  const ui = await mount($)
  expect(await texts(ui)).not.toMatch(/SA-1/)
  await ui.press({ key: 'conn:atlassian' })
  const all = await texts(ui)
  expect(all).toMatch(/getJiraIssue\s+SA-1/)
  expect(all).toMatch(/searchJiraIssuesUsingJql\s+project = SA/)
  expect(all).toMatch(/\b\d\d:\d\d\b/)
  await ui.press({ key: 'conn:atlassian' })
  expect(await texts(ui)).not.toMatch(/SA-1/)
  await ui.unmount()
})

test('what a subagent used is tagged via subagent', async ($, on) => {
  world(on)
  await start($)
  await call($, { tool: JIRA, issueIdOrKey: 'SA-1', agentId: 'a1' })
  await call($, { tool: 'Read', file_path: '/work/notes.md', agentId: 'a1' })
  await call($, { tool: 'Read', file_path: '/work/main.ts' })
  const ui = await mount($)
  const all = await texts(ui)
  expect(all).toMatch(/via subagent\s*1 call/)
  const tags = (await ui.findAll({ type: 'Text' })).filter((t: any) => t.text === 'via subagent ')
  expect(tags).toHaveLength(2)
  await ui.unmount()
})

test('context files: files read newest first, auto-loaded ones tagged, a window of 10 with Up and Down, and a press opens the file', async ($, on) => {
  const w = world(on)
  w.memoryFiles = [`${HOME}/.claude/CLAUDE.md`]
  await start($)
  for (let i = 1; i <= 12; i++) await call($, { tool: 'Read', file_path: `/work/src/f${i}.ts` })
  const ui = await mount($)
  let all = await texts(ui)
  expect(all).toMatch(/Files read\s*12/)
  expect(all).toMatch(/f12\.ts/)
  expect(all).not.toMatch(/CLAUDE\.md/)
  expect(all).toMatch(/1 to 10 of 13/)
  await ui.press({ key: 'files-down' })
  all = await texts(ui)
  expect(all).toMatch(/CLAUDE\.md\s+~?\/?\.?claude|CLAUDE\.md/)
  expect(all).toMatch(/auto/)
  expect(all).toMatch(/4 to 13 of 13/)
  await ui.press({ key: `file:/work/src/f3.ts` })
  expect(w.ran).toEqual([['open', '/work/src/f3.ts']])
  await ui.unmount()
})

test('the To-do card follows the list that changed last: Claude\'s tasks or Clean View\'s steps', async ($, on) => {
  world(on)
  await start($)
  await call($, {
    tool: 'TodoWrite',
    todos: [
      { content: 'Find the call', status: 'completed', activeForm: 'x' },
      { content: 'Read the thread', status: 'in_progress', activeForm: 'x' },
      { content: 'Write the brief', status: 'pending', activeForm: 'x' },
    ],
  })
  const ui = await mount($)
  expect(await texts(ui)).toMatch(/1 of 3/)
  const struck = (await ui.findAll({ type: 'Text' })).filter((t: any) => t.props?.strikethrough).map((t: any) => t.text)
  expect(struck).toEqual(['Find the call'])

  await call($, { tool: 'mcp__ai-employee-kit__plan_steps', steps: ['Look at the files', 'Tidy them'] })
  await call($, { tool: 'mcp__ai-employee-kit__report_progress', task: 'Look at the files', percent: 100 })
  const all = await texts(ui)
  expect(all).toMatch(/1 of 2/)
  expect(all).toMatch(/Tidy them/)
  expect(all).not.toMatch(/Write the brief/)
  // Clean View's own tools are not connectors.
  expect(all).not.toMatch(/Ai Employee Kit/)

  await call($, { tool: 'TaskCreate', subject: 'Ship it', description: 'x' })
  expect(await texts(ui)).toMatch(/Ship it/)
  await ui.unmount()
})

test('a subagent\'s to-do list does not replace the chat\'s', async ($, on) => {
  world(on)
  await start($)
  await call($, { tool: 'TodoWrite', todos: [{ content: 'Main job', status: 'pending', activeForm: 'x' }] })
  await call($, { tool: 'TodoWrite', todos: [{ content: 'Helper job', status: 'pending', activeForm: 'x' }], agentId: 'a1' })
  const ui = await mount($)
  expect(await texts(ui)).toMatch(/Main job/)
  expect(await texts(ui)).not.toMatch(/Helper job/)
  await ui.unmount()
})

test('skills from the Skill tool and typed skill commands, subagents from the agent list, and web pages', async ($, on) => {
  const w = world(on)
  await start($)
  await call($, { tool: 'Skill', skill: 'graphify' })
  await ($ as any).command.run({ command: 'graphify', args: 'query x', origin: { kind: 'composer' } })
  await call($, { tool: 'WebFetch', url: 'https://docs.example.com/a', prompt: 'x' })
  await call($, { tool: 'WebFetch', url: 'https://docs.example.com/b', prompt: 'x' })
  await call($, { tool: 'WebSearch', query: 'claude mods' })
  w.agents = [
    { id: 'a1', type: 'Explore', description: 'Find the config', status: 'running', parentId: undefined },
    { id: 'a2', type: 'general-purpose', description: 'Write tests', status: 'completed' },
  ]
  const ui = await mount($)
  await ($ as any).turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  const all = await texts(ui)
  expect(all).toMatch(/\/\s*graphify[\s\S]*2 uses/)
  expect(all).toMatch(/Explore\s+Find the config/)
  expect(all).toMatch(/running/)
  expect(all).toMatch(/done/)
  expect(all).toMatch(/docs\.example\.com\s+https:\/\/docs\.example\.com\/b/)
  expect(all).toMatch(/2 times/)
  expect(all).toMatch(/Web search\s+claude mods/)
  await ui.unmount()
})

test('a card folds from its header', async ($, on) => {
  world(on)
  await start($)
  await call($, { tool: JIRA, issueIdOrKey: 'SA-1' })
  const ui = await mount($)
  expect(await texts(ui)).toMatch(/Atlassian/)
  await ui.press({ key: 'fold-connectors' })
  expect(await texts(ui)).not.toMatch(/Atlassian/)
  expect(await texts(ui)).toMatch(/▸/)
  await ui.press({ key: 'fold-connectors' })
  expect(await texts(ui)).toMatch(/Atlassian/)
  await ui.unmount()
})

test('Copy puts the whole inventory on the clipboard as a Markdown list', async ($, on) => {
  const w = world(on)
  await start($)
  await call($, { tool: JIRA, issueIdOrKey: 'SA-1' })
  await call($, { tool: 'Read', file_path: `${HOME}/notes/a.md` })
  const ui = await mount($)
  await ui.press({ key: 'inv-copy' })
  expect(w.copies).toHaveLength(1)
  expect(w.copies[0]).toMatch(/^# In this chat\n/)
  expect(w.copies[0]).toMatch(/## Connectors \(1\)\n- Atlassian: getJiraIssue, 1 call/)
  expect(w.copies[0]).toMatch(/- ~\/notes\/a\.md/)
  expect(await texts(ui)).toMatch(/Copied the inventory/)
  await ui.unmount()
})

test('a restart rebuilds the lists from the transcript, subagents included, and counts nothing twice', async ($, on) => {
  const w = world(on)
  w.messages = {
    main: [
      { role: 'user', text: '<command-name>/graphify</command-name>', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'u1', tool: JIRA, input: { issueIdOrKey: 'SA-1' } },
          { tool_use_id: 'u2', tool: 'Agent', input: { description: 'x' }, agentId: 'a1' },
          { tool_use_id: 'u3', tool: 'TodoWrite', input: { todos: [{ content: 'Seeded step', status: 'pending' }] } },
        ],
      },
    ],
    a1: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 's1', tool: 'Read', input: { file_path: '/work/helper.md' } }] }],
  }
  await start($)
  await start($)
  // The live hook hears a call the transcript already holds: not counted again.
  await call($, { tool: JIRA, issueIdOrKey: 'SA-1', tool_use_id: 'u1' })
  const ui = await mount($)
  const all = await texts(ui)
  expect(all).toMatch(/Atlassian[\s\S]*1 call/)
  expect(all).not.toMatch(/2 calls/)
  expect(all).toMatch(/helper\.md[\s\S]*via subagent/)
  expect(all).toMatch(/\/\s*graphify/)
  expect(all).toMatch(/Seeded step/)
  await ui.unmount()
})

test('the status-bar button and /inventory open the pane, and close it again', async ($, on) => {
  const w = world(on)
  await start($)
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /In this chat/ })).toBeTruthy()
  await bar.press({ key: 'open-inventory' })
  expect(w.opens).toEqual(['chat-inventory'])
  await bar.press({ key: 'open-inventory' })
  expect(w.closes).toEqual(['chat-inventory'])
  await bar.unmount()
  const r = await ($ as any).command.run({ command: 'inventory', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/Opened/)
  expect(w.opens).toHaveLength(2)
  const ui = await mount($)
  await ui.press({ key: 'inv-hide' })
  expect(w.closes).toHaveLength(2)
  await ui.unmount()
})

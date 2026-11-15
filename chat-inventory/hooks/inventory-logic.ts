// The inventory's pure parts: what a tool call counts as (a connector, a file,
// a skill, a web page), how the to-do lists change, and the Markdown copy.
// Nothing here calls the engine, so the tests can drive it directly.

import type { AgentRow, CallRow, ConnectorRow, FileRow, Inventory, Plan, PlanStep, SkillRow, WebRow } from '../types'

export const EMPTY: Inventory = { connectors: [], files: [], skills: [], web: [] }
export const NO_PLAN: Plan = { title: '', steps: [], updatedAt: 0 }

/** Calls kept per connector for its unfolded list. */
const MAX_CALLS = 30

/** Clean View's checklist tools: they feed the To-do card, not Connectors. */
export const STEPS_TOOL = 'mcp__ai-employee-kit__plan_steps'
export const PROGRESS_TOOL = 'mcp__ai-employee-kit__report_progress'
/** Claude's own task list tools. */
export const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
/** MCP servers that only report progress: not services the chat used. */
const QUIET_SERVERS = new Set(['ai-employee-kit', 'savvy-progress'])

/** One thing a call used. */
export type Hit =
  | { kind: 'connector'; name: string; tool: string; summary: string }
  | { kind: 'file'; path: string }
  | { kind: 'skill'; name: string }
  | { kind: 'web'; site: string; detail: string }

// ── Names ───────────────────────────────────────────────────────────────

/** Server names spelled as people know them, by the server part of `mcp__<server>__<tool>`. */
const SERVER_NAMES: Record<string, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
  atlassian: 'Atlassian',
  supabase: 'Supabase',
  context7: 'Context7',
  'dart-mcp-server': 'Dart',
  'qa-flow': 'QA Flow',
  'analytics-mcp': 'Google Analytics',
  'claude-in-chrome': 'Chrome',
  claude_docs: 'Claude Docs',
  devdox: 'DevDox',
  mailtrap: 'Mailtrap',
  maestro: 'Maestro',
  marionette: 'Marionette',
  playwright: 'Playwright',
  render: 'Render',
  easel: 'Easel',
  newrelic: 'New Relic',
  'plugin-authoring': 'Plugin Authoring',
}

/** `mcp__claude_ai_Atlassian_MCP__getJiraIssue` → `{ server: 'Atlassian', tool: 'getJiraIssue' }`. */
export function splitMcp(tool: string): { server: string; raw: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m) return null
  const raw = m[1]!
  let s = raw
  if (s.startsWith('claude_ai_')) s = s.slice('claude_ai_'.length)
  // A plugin's server: mcp__plugin_<plugin>_<server>__tool; the server part names it.
  const plugin = /^plugin_([^_]+)_(.+)$/.exec(s)
  if (plugin) s = plugin[2]!
  s = s.replace(/[_-]mcp$/i, '').replace(/^mcp[_-]/i, '')
  const known = SERVER_NAMES[s.toLowerCase()] ?? SERVER_NAMES[`${s.toLowerCase()}-mcp`]
  const server =
    known ??
    s
      .split(/[_-]+/)
      .filter(Boolean)
      .map(w => (w.length <= 3 && w === w.toUpperCase() ? w : w[0]!.toUpperCase() + w.slice(1)))
      .join(' ')

  return { server, raw, tool: m[2]! }
}

/** Command-line tools that count as connectors when run through Bash. */
export const CLI_TOOLS: Record<string, string> = {
  gh: 'GitHub',
  glab: 'GitLab',
  supabase: 'Supabase',
  render: 'Render',
  maestro: 'Maestro',
  'terminal-browser': 'Terminal Browser',
  graphify: 'Graphify',
}

/** A command word at the start of a command, after a separator, after env assignments or an `rtk` wrapper. */
const CLI_RE = new RegExp(
  String.raw`(?:^|[;&|(\n` + '`' + String.raw`]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:rtk\s+(?:proxy\s+)?)?(` +
    Object.keys(CLI_TOOLS)
      .map(k => k.replace(/-/g, '\\-'))
      .join('|') +
    String.raw`)(?=\s|$)([^;&|\n` + '`' + String.raw`)]*)`,
  'g',
)

const URL_RE = /\bhttps?:\/\/[^\s'"`<>)]+/

export function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#:]+)/i.exec(url.trim())

  return m ? m[1]!.replace(/^www\./, '') : ''
}

const clip = (s: string, n = 48) => {
  const one = s.replace(/\s+/g, ' ').trim()

  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** The input values worth showing for a call, best first. */
const ARG_KEYS = [
  'issueIdOrKey', 'issueKey', 'key', 'jql', 'cql', 'query', 'q', 'search', 'url', 'path', 'file_path',
  'project_id', 'projectId', 'project', 'merge_request_iid', 'name', 'title', 'subject', 'id', 'device_id', 'table', 'sql',
]

export function summaryOf(input: Record<string, unknown>): string {
  for (const k of ARG_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return clip(v)
    if (typeof v === 'number') return `${k} ${v}`
  }
  for (const [k, v] of Object.entries(input)) {
    if (k === 'tool' || k === 'tool_use_id' || k === 'agentId' || k === 'consent') continue
    if (typeof v === 'string' && v.trim() && v.length < 80) return clip(v)
  }

  return ''
}

/** The words after a command-line tool's name, flags dropped: `pr view 12`. */
function cliSummary(rest: string): string {
  const words = rest
    .trim()
    .split(/\s+/)
    .filter(w => w && !w.startsWith('-'))
    .slice(0, 3)

  return clip(words.join(' '), 40)
}

/** Paths a person never handed Claude: big tool results spilled to disk, temp copies. */
export function isScratch(path: string): boolean {
  return /\/tool-results\//.test(path) || /^\/(private\/)?tmp\//.test(path) || /^\/var\/folders\//.test(path) || /\/\.claude\/jobs\/[^/]+\/tmp\//.test(path)
}

const skillOfPath = (p: string) => /\/([^/]+)\/SKILL\.md$/.exec(p)?.[1] ?? ''

/** What one tool call used. */
export function hitsOf(tool: string, input: Record<string, unknown>): Hit[] {
  if (TASK_TOOLS.has(tool) || tool === STEPS_TOOL || tool === PROGRESS_TOOL) return []
  const mcp = splitMcp(tool)
  if (mcp) {
    if (QUIET_SERVERS.has(mcp.raw)) return []
    const hits: Hit[] = [{ kind: 'connector', name: mcp.server, tool: mcp.tool, summary: summaryOf(input) }]
    // A browser server's page loads are web pages too.
    if (/navigate|open_url|goto/i.test(mcp.tool) && typeof input.url === 'string') {
      const site = hostOf(input.url)
      if (site) hits.push({ kind: 'web', site, detail: clip(input.url, 60) })
    }

    return hits
  }
  if (tool === 'Read' || tool === 'NotebookRead') {
    const path = input.file_path ?? input.notebook_path
    if (typeof path !== 'string' || !path) return []
    const skill = skillOfPath(path)
    if (skill) return [{ kind: 'skill', name: skill }]

    return isScratch(path) ? [] : [{ kind: 'file', path }]
  }
  if (tool === 'Skill' && typeof input.skill === 'string' && input.skill.trim()) return [{ kind: 'skill', name: input.skill.trim() }]
  if (tool === 'WebFetch' && typeof input.url === 'string') {
    const site = hostOf(input.url)

    return site ? [{ kind: 'web', site, detail: clip(input.url, 60) }] : []
  }
  if (tool === 'WebSearch' && typeof input.query === 'string') return [{ kind: 'web', site: 'Web search', detail: clip(input.query, 60) }]
  if (tool === 'Bash' && typeof input.command === 'string') return cliHits(input.command)

  return []
}

/** The connector tools a shell command ran, and the pages terminal-browser opened. */
export function cliHits(command: string): Hit[] {
  const hits: Hit[] = []
  for (const m of command.matchAll(CLI_RE)) {
    const word = m[1]!
    const rest = m[2] ?? ''
    const summary = cliSummary(rest)
    hits.push({ kind: 'connector', name: CLI_TOOLS[word]!, tool: summary.split(' ').slice(0, 2).join(' ') || word, summary })
    if (word === 'terminal-browser') {
      const url = URL_RE.exec(rest)?.[0] ?? /\b(?:open|new-tab)\s+([a-z0-9.-]+\.[a-z]{2,}\S*)/i.exec(rest)?.[1]
      const site = url ? hostOf(url.includes('://') ? url : `https://${url}`) : ''
      if (url && site) hits.push({ kind: 'web', site, detail: clip(url, 60) })
    }
  }

  return hits
}

// ── The inventory ───────────────────────────────────────────────────────

/** One use, stamped: its order, its time (0 when unknown), and whether a subagent made it. */
export type Use = { hit: Hit; seq: number; at: number; isSub: boolean }

const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

function bump<T extends { seq: number; count: number; subCount: number; bumpedAt: number }>(row: T, u: Use): T {
  return { ...row, seq: u.seq, count: row.count + 1, subCount: row.subCount + (u.isSub ? 1 : 0), bumpedAt: u.at }
}

/** The inventory with these uses added, each row moved to the front by its newest use. */
export function apply(inv: Inventory, uses: readonly Use[]): Inventory {
  let { connectors, files, skills, web } = inv
  for (const u of uses) {
    const h = u.hit
    if (h.kind === 'connector') {
      const key = keyOf(h.name)
      const call: CallRow = { tool: h.tool, summary: h.summary, at: u.at, isSub: u.isSub }
      const old = connectors.find(c => c.key === key)
      const row: ConnectorRow = old
        ? { ...bump(old, u), lastTool: h.tool, calls: [call, ...old.calls].slice(0, MAX_CALLS) }
        : { key, name: h.name, lastTool: h.tool, count: 1, subCount: u.isSub ? 1 : 0, seq: u.seq, bumpedAt: u.at, calls: [call] }
      connectors = [...connectors.filter(c => c.key !== key), row]
    } else if (h.kind === 'file') {
      const old = files.find(f => f.path === h.path)
      const row: FileRow = old ? bump(old, u) : { path: h.path, auto: false, count: 1, subCount: u.isSub ? 1 : 0, seq: u.seq, bumpedAt: u.at }
      files = [...files.filter(f => f.path !== h.path), row]
    } else if (h.kind === 'skill') {
      const old = skills.find(s => s.name === h.name)
      const row: SkillRow = old ? bump(old, u) : { name: h.name, count: 1, subCount: u.isSub ? 1 : 0, seq: u.seq, bumpedAt: u.at }
      skills = [...skills.filter(s => s.name !== h.name), row]
    } else {
      const old = web.find(w => w.site === h.site)
      const row: WebRow = old
        ? { ...bump(old, u), detail: h.detail }
        : { site: h.site, detail: h.detail, count: 1, subCount: u.isSub ? 1 : 0, seq: u.seq, bumpedAt: u.at }
      web = [...web.filter(w => w.site !== h.site), row]
    }
  }

  return { connectors, files, skills, web }
}

/** Instruction and memory files loaded at the start, tagged `auto`; a SKILL.md among them is an always-loaded skill. */
export function withAutoFiles(inv: Inventory, paths: readonly string[]): Inventory {
  const files = [...inv.files]
  paths.forEach((path, i) => {
    if (skillOfPath(path) || !path) return
    const at = files.findIndex(f => f.path === path)
    if (at >= 0) files[at] = { ...files[at]!, auto: true }
    else files.push({ path, auto: true, count: 0, subCount: 0, seq: -1000 + i, bumpedAt: 0 })
  })

  return { ...inv, files }
}

export const newest = <T extends { seq: number }>(rows: readonly T[]) => [...rows].sort((a, b) => b.seq - a.seq)

// ── To-do ───────────────────────────────────────────────────────────────

const STATUSES = new Set(['pending', 'in_progress', 'completed'])
const statusOf = (v: unknown): PlanStep['status'] => (typeof v === 'string' && STATUSES.has(v) ? (v as PlanStep['status']) : 'pending')
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** Claude's task list after one of its tools ran; null when the call changed nothing. */
export function tasksAfter(cur: Plan, tool: string, input: Record<string, unknown>, result: unknown, time: number): Plan | null {
  if (tool === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos : []
    const steps = todos
      .map(t => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}))
      .map(t => ({ text: str(t.content), status: statusOf(t.status) }))
      .filter(s => s.text)

    return { title: '', steps, updatedAt: time }
  }
  if (tool === 'TaskCreate') {
    const text = str(input.subject)
    if (!text) return null
    const made = (result as { task?: { id?: unknown } } | undefined)?.task?.id
    const id = str(made) || String(cur.steps.length + 1)

    return { ...cur, steps: [...cur.steps, { text, status: 'pending', id }], updatedAt: time }
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId)
    let at = cur.steps.findIndex(s => s.id === id)
    if (at < 0 && /^\d+$/.test(id) && !cur.steps.some(s => s.id)) at = Number(id) - 1
    const old = cur.steps[at]
    if (!old) return null
    if (input.status === 'deleted') return { ...cur, steps: cur.steps.filter((_, i) => i !== at), updatedAt: time }
    const steps = cur.steps.map((s, i) =>
      i === at ? { ...s, text: str(input.subject) || s.text, status: input.status === undefined ? s.status : statusOf(input.status) } : s,
    )

    return { ...cur, steps, updatedAt: time }
  }

  return null
}

/** Clean View's checklist after plan_steps or report_progress; null when the call changed nothing. */
export function stepsAfter(cur: Plan, tool: string, input: Record<string, unknown>, time: number): Plan | null {
  if (tool === STEPS_TOOL) {
    const list = Array.isArray(input.steps) ? input.steps.map(str).filter(Boolean) : []
    if (!list.length) return null
    // The first step starts right away, as Clean View's checklist shows it.
    return { title: '', steps: list.map((text, i) => ({ text, status: i === 0 ? 'in_progress' : 'pending' })), updatedAt: time }
  }
  if (tool === PROGRESS_TOOL) {
    const task = str(input.task).toLowerCase()
    const at = cur.steps.findIndex(s => s.text.toLowerCase() === task)
    if (at < 0) return null
    const done = Number(input.percent) >= 100
    const steps = cur.steps.map((s, i) => (i === at ? { ...s, status: done ? ('completed' as const) : ('in_progress' as const) } : s))
    // A finished step starts the next one, as the checklist does.
    if (done && steps[at + 1]?.status === 'pending') steps[at + 1] = { ...steps[at + 1]!, status: 'in_progress' }

    return { ...cur, steps, updatedAt: time }
  }

  return null
}

/** The list the To-do card shows: whichever changed last. */
export const shownPlan = (tasks: Plan, steps: Plan): Plan => (steps.updatedAt > tasks.updatedAt ? steps : tasks)

// ── Copy as a list ──────────────────────────────────────────────────────

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const viaText = (r: { count: number; subCount: number }) => (r.subCount === 0 ? '' : r.subCount >= r.count ? ' (via subagent)' : ` (${r.subCount} via subagent)`)

export function markdownOf(inv: Inventory, plan: Plan, agents: readonly AgentRow[], tilde: (p: string) => string): string {
  const out: string[] = ['# In this chat', '']
  const done = plan.steps.filter(s => s.status === 'completed').length
  out.push(`## To-do${plan.steps.length ? ` (${done} of ${plan.steps.length})` : ''}`)
  if (plan.title) out.push(plan.title)
  out.push(...(plan.steps.length ? plan.steps.map(s => `- [${s.status === 'completed' ? 'x' : ' '}] ${s.text}`) : ['- None yet']), '')
  out.push(`## Connectors (${inv.connectors.length})`)
  out.push(
    ...(inv.connectors.length
      ? newest(inv.connectors).map(c => `- ${c.name}: ${c.lastTool}, ${plural(c.count, 'call')}${viaText(c)}`)
      : ['- None used yet']),
    '',
  )
  out.push(`## Context files (${inv.files.length})`)
  out.push(...(inv.files.length ? newest(inv.files).map(f => `- ${tilde(f.path)}${f.auto ? ' (auto)' : ''}${viaText(f)}`) : ['- None read yet']), '')
  out.push(`## Skills (${inv.skills.length})`)
  out.push(...(inv.skills.length ? newest(inv.skills).map(s => `- /${s.name}: ${plural(s.count, 'use')}${viaText(s)}`) : ['- None used yet']), '')
  out.push(`## Subagents (${agents.length})`)
  out.push(...(agents.length ? agents.map(a => `- ${a.type}: ${a.description} (${a.status})`) : ['- None ran yet']), '')
  out.push(`## Web pages (${inv.web.length})`)
  out.push(...(inv.web.length ? newest(inv.web).map(w => `- ${w.site}: ${w.detail}, ${plural(w.count, 'time')}${viaText(w)}`) : ['- None yet']))

  return `${out.join('\n')}\n`
}

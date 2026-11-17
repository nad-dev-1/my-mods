// Team Board: the Claude Code side. Commands hand Claude a short procedure;
// Claude reads the board's database with the ArtifactData tool (into a local
// cache), the tools here apply the shared rules (core.js, the same file the
// dashboard runs) and answer the exact writes, and Claude sends them only
// after the person confirms the preview. Nothing here writes to Jira.

import type { EngineInterface, Register } from 'claude-code'

import {
  DEFAULT_SETTINGS,
  JIRA_FIELDS,
  PERIODS,
  PRIORITIES,
  STAGE_LABEL,
  applyChange,
  byPriority,
  byQueue,
  computeReport,
  convertIdea,
  flagsFor,
  isOngoing,
  isOpenTask,
  issuesFrom,
  jiraChunks,
  jiraSnapshot,
  newItem,
  nextId,
  noteEvent,
  openBlockers,
  reportCsv,
  reportMarkdown,
  statusLine,
  summaryFacts,
  todayIn,
  wipOver,
} from './core.js'

type E$ = EngineInterface
type Json = Record<string, any>
type Doc = Json & { id: string }

export const SERVER = 'claude_ai_Atlassian_MCP'
const COLLS = ['config', 'members', 'projects', 'items', 'events', 'jira', 'reports'] as const
const TOOL = (name: string) => `mcp__team-board__${name}`
const PLAN_TOOL = 'mcp__team-board__board_plan'
const SUMMARY_TOOL = 'mcp__team-board__board_summary'
const REPORT_TOOL = 'mcp__team-board__board_report'
const CONNECT_TOOL = 'mcp__team-board__board_connect'

// ── local files ────────────────────────────────────────────────────────

let home = ''
async function homeDir($: E$): Promise<string> {
  if (!home) home = (await $.env.get('HOME')) || '/tmp'

  return home
}
export async function boardDir($: E$): Promise<string> {
  return `${await homeDir($)}/.team-board`
}
async function cacheDir($: E$): Promise<string> {
  return `${await boardDir($)}/cache`
}

export type LocalConfig = { adapter: 'artifact-db'; artifactUrl: string; artifactSlug: string; lastToastDate: string | null; lastFlagged: string[] }

export async function loadConfig($: E$): Promise<LocalConfig | null> {
  try {
    const c = JSON.parse(await $.fs.read(`${await boardDir($)}/config.json`)) as Partial<LocalConfig>
    if (!c.artifactUrl) return null

    return { adapter: 'artifact-db', artifactUrl: c.artifactUrl, artifactSlug: c.artifactSlug || slugOf(c.artifactUrl), lastToastDate: c.lastToastDate ?? null, lastFlagged: c.lastFlagged ?? [] }
  } catch {
    return null
  }
}
async function saveConfig($: E$, c: LocalConfig): Promise<void> {
  await $.fs.write(`${await boardDir($)}/config.json`, JSON.stringify(c, null, 2) + '\n')
}
function slugOf(url: string): string {
  return (/artifact\/([A-Za-z0-9_-]+)/.exec(url) || [])[1] || ''
}

export type Board = { settings: Json; counters: Json; members: Doc[]; projects: Doc[]; items: Doc[]; events: Doc[]; jira: Record<string, Json>; reports: Doc[]; fetchedAt: Record<string, number> }

/** The board as the cache holds it (what Claude last listed). */
export async function loadBoard($: E$): Promise<Board> {
  const dir = await cacheDir($)
  const read = async (coll: string): Promise<{ docs: Doc[]; at: number }> => {
    try {
      const list = await $.fs.list(`${dir}/${coll}`)
      const docs: Doc[] = []
      let at = 0
      for (const f of list) {
        if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
        try {
          const id = f.name.slice(0, -5)
          docs.push({ ...JSON.parse(await $.fs.read(`${dir}/${coll}/${f.name}`)), id })
          const st = await $.fs.stat(`${dir}/${coll}/${f.name}`).catch(() => null)
          if (st && typeof (st as Json).mtimeMs === 'number') at = Math.max(at, (st as Json).mtimeMs)
        } catch {
          // a half-written file is skipped
        }
      }

      return { docs, at }
    } catch {
      return { docs: [], at: 0 }
    }
  }
  const got = Object.fromEntries(await Promise.all(COLLS.map(async c => [c, await read(c)] as const))) as Record<string, { docs: Doc[]; at: number }>
  const cfg = got.config!.docs

  return {
    settings: { ...DEFAULT_SETTINGS, ...(cfg.find(d => d.id === 'settings') || {}) },
    counters: cfg.find(d => d.id === 'counters') || { idea: 0, task: 0 },
    members: got.members!.docs,
    projects: got.projects!.docs,
    items: got.items!.docs,
    events: got.events!.docs,
    jira: Object.fromEntries(got.jira!.docs.map(d => [d.id, d])),
    reports: got.reports!.docs,
    fetchedAt: Object.fromEntries(COLLS.map(c => [c, got[c]!.at])),
  }
}

async function now($: E$): Promise<number> {
  return $.clock.now().catch(() => Date.now())
}
async function todayOf($: E$, b: Board): Promise<string> {
  return todayIn(b.settings.timezone || 'Asia/Beirut', await now($))
}
async function ctxOf($: E$, b: Board) {
  const ms = await now($)

  return { today: todayIn(b.settings.timezone || 'Asia/Beirut', ms), nowIso: new Date(ms).toISOString(), members: b.members, items: b.items }
}

// ── the procedures handed to Claude ────────────────────────────────────

function preamble(cfg: LocalConfig, cache: string, today: string, colls: string[]): string {
  return [
    `Team Board (${cfg.artifactUrl}). Today is ${today} (Asia/Beirut unless the board's settings say otherwise).`,
    `The board's data is reached only with the ArtifactData tool (load it with ToolSearch if it is deferred). Never call any Jira tool that writes; Team Board is read-only toward Jira.`,
    `1. Refresh the cache: one ArtifactData "list" per collection (${colls.join(', ')}) on that url with out_dir "${cache}" and query.limit 1000. Note the version each document shows in the output.`,
  ].join('\n')
}
const CONFIRM = `Show the preview the plan tool returns, word for word, and ask the person to confirm. Write nothing before they say yes. On yes, send exactly the "writes" it returned as one ArtifactData "batch" to the board's url (add if_version where the plan tool says), then list "items" (and "events" if notes changed) into the cache again so the status line stays current. If the plan tool answers an error, fix the input or ask the person; do not write by hand.`
const RESOLVE = `Refer to items by ID (T-0012, I-0003) or by a fuzzy match of the title among the cached items; if more than one could match, ask which. Resolve people against the cached members (name, first name or email) and projects against the cached projects (name, id or Jira key); "me" is the board owner: use the member flagged as owner if there is one, otherwise ask. Relative dates ("Fri", "next week") become YYYY-MM-DD from today.`

function procedure(cmd: string, args: string, cfg: LocalConfig, cache: string, today: string): string | null {
  const A = args.trim()
  const quote = A ? `"${A.replace(/"/g, '\\"')}"` : '(nothing given)'
  const base = (colls: string[]) => preamble(cfg, cache, today, colls)
  const plan = `${TOOL('board_plan')}`
  switch (cmd) {
    case 'idea':
      return `${base(['config', 'members', 'projects', 'items'])}\n2. Capture an idea from ${quote}. Parse: title (120 characters at most), projectId (required), priority (critical, high, medium or low; default medium), ownerId, description, rationale, jiraRefs. ${RESOLVE}\n3. Call ${plan} with op "create_idea", the fields, and versions {"config/counters": <its version>}.\n4. ${CONFIRM}`
    case 'task':
      if (/^from-session\b/i.test(A))
        return `${base(['config', 'members', 'projects', 'items'])}\n2. From this conversation so far, propose ONE task (or an idea, if it is not yet decided work): a title of 120 characters at most, a short description of what and why, the project, a priority, and an assignee only when it is obvious. Say why you chose it in one line. ${RESOLVE}\n3. Call ${plan} with op "create_task" (or "create_idea") and versions {"config/counters": <its version>}.\n4. ${CONFIRM}`
      return `${base(['config', 'members', 'projects', 'items'])}\n2. Capture a task from ${quote}. Parse: title (120 characters at most), projectId (required), priority (default medium), assigneeId, collaboratorIds, eta (YYYY-MM-DD), status (default backlog, or assigned when someone is named), jiraKeys (keys or links), description. ${RESOLVE}\n3. Call ${plan} with op "create_task", the fields, and versions {"config/counters": <its version>}.\n4. ${CONFIRM}`
    case 'assign':
      return `${base(['config', 'members', 'items'])}\n2. Assign or reassign: ${quote} names an item and a member ("none" unassigns). ${RESOLVE} If the task is in backlog, ask whether to move it to assigned too.\n3. Call ${plan} with op "change", itemId, change {"assigneeId": <member id or null>, and "status": "assigned" if agreed}, versions {"items/<id>": <version>}.\n4. ${CONFIRM}`
    case 'board-status':
      return `${base(['config', 'members', 'items'])}\n2. Change a stage: ${quote} names an item and a stage. Task stages: backlog, assigned, in_progress, in_review, done, cancelled. Idea stages: new, discussing, approved, converted, parked, rejected. ${RESOLVE}\n3. Call ${plan} with op "change", itemId, change {"status": <stage>}, versions {"items/<id>": <version>}. The tool applies the date rules (start, review requested, end, reopen).\n4. ${CONFIRM}`
    case 'eta':
      return `${base(['config', 'members', 'items'])}\n2. Set or change an ETA: ${quote} names a task and a date ("none" clears it). ${RESOLVE}\n3. Call ${plan} with op "change", itemId, change {"eta": "YYYY-MM-DD" or null}, versions {"items/<id>": <version>}. The first ETA stays as the original.\n4. ${CONFIRM}`
    case 'note':
      return `${base(['config', 'members', 'items'])}\n2. Add a note: ${quote} names an item, an optional tag (blocker, decision, update or review) and the text. Keep the person's wording. ${RESOLVE}\n3. Call ${plan} with op "note", itemId, tag, body, versions {"items/<id>": <version>}.\n4. ${CONFIRM}`
    case 'link':
      return `${base(['config', 'members', 'projects', 'items', 'jira'])}\n2. Link Jira tickets: ${quote} names an item and one or more Jira keys or issue links. ${RESOLVE}\n3. For each key, read it with mcp__claude_ai_Atlassian_MCP__getJiraIssue (cloudId from getAccessibleAtlassianResources, fields ${JSON.stringify(JIRA_FIELDS)}). A key that fails is still linked, with an error badge.\n4. Call ${plan} with op "change", itemId, change {"jiraAdd": [keys]}, versions {"items/<id>": <version>}, and also issues: [the issues you read], missingKeys: [keys that failed].\n5. ${CONFIRM}`
    case 'board-review':
      return `${base(['config', 'members', 'items'])}\n2. Record a review: ${quote} names a task, a senior reviewer and an optional note. The reviewer must be a senior and not the assignee; the tool refuses otherwise. ${RESOLVE}\n3. Call ${plan} with op "change", itemId, change {"reviewedBy": <member id>, "reviewNote": <note if given>}, versions {"items/<id>": <version>}.\n4. ${CONFIRM}`
    case 'board':
      if (/^refresh\b/i.test(A))
        return `${base(['config', 'items', 'jira'])}\n2. Refresh Jira (read only): call ${plan} with op "jira_keys"; it answers the keys in chunks. For each chunk call mcp__claude_ai_Atlassian_MCP__searchJiraIssuesUsingJql with the jql it gives, fields ${JSON.stringify(JIRA_FIELDS)} and maxResults equal to the chunk size (cloudId from getAccessibleAtlassianResources once). If a chunk errors, read its keys one by one with getJiraIssue.\n3. Call ${plan} with op "jira_snapshots", issues: [every issue read], missingKeys: [keys that could not be read], versions for the jira docs and config/settings you saw.\n4. This only refreshes the board's Jira cache, so no preview is needed: send its writes as one ArtifactData batch, then list "jira" into the cache again. Report how many tickets were refreshed and any that failed.`
      return `${base(['config', 'members', 'projects', 'items', 'events', 'jira'])}\n2. Call ${TOOL('board_summary')} and show its answer to the person as it is (it ends with the dashboard link). Do not write anything.`
    case 'board-report':
      return `${base(['config', 'members', 'projects', 'items', 'events', 'jira', 'reports'])}\n2. Report ${quote}. Scope: "team" (default), a team group (e.g. iOS), a project, or a member. Period: this_week (default), last_week, this_month, last_month, or a custom range "YYYY-MM-DD..YYYY-MM-DD". ${RESOLVE}\n3. Call ${TOOL('board_report')} with scope {kind: team|group|project|member, value} and period (and from, to for custom). It answers the numbers and the facts.\n4. Draft an executive summary of 3 to 5 sentences in neutral, plain language from those facts only: no praise, no guesses, no numbers that are not in the facts. Show the report and the summary, and ask whether to save it (the person may edit the summary).\n5. On yes, call ${TOOL('board_report')} again with the same input plus summary (the final text) and reportId (from the first answer); send the "writes" it returns as one ArtifactData batch. Tell the person where the Markdown and CSV files are and that the PDF export is in the dashboard (Reports).`
    case 'board-setup':
      return null
  }

  return null
}

function setupProcedure(cfg: LocalConfig | null, args: string, root: string, cache: string): string {
  const page = `${root}/dashboard/team-board.html`
  const caps = JSON.stringify({
    db: { rules: COLLS.map(path => ({ path, read: 'view', write: 'owner' })) },
    user: {},
    mcp: { servers: [{ server: SERVER, tools: ['getAccessibleAtlassianResources', 'getJiraIssue', 'searchJiraIssuesUsingJql'] }] },
    downloads: true,
    sample: {},
  })
  const connect = cfg
    ? `The board is connected to ${cfg.artifactUrl}.`
    : `No board is connected yet. Ask whether the person already has a Team Board link. If they do, call ${TOOL('board_connect')} with it. If not, publish the dashboard: the Artifact tool, file_path "${page}", icon "board", capabilities ${caps}; then call ${TOOL('board_connect')} with the published url.`

  return [
    `Team Board setup. ${connect}${args.trim() ? ` The person said: "${args.trim().replace(/"/g, '\\"')}".` : ''}`,
    `Then, one question at a time and with a recommended answer for each: the roster (name, email, teams, who is senior, Jira account id when known), the projects (name, Jira project keys, default team), and the thresholds (stale after 5 days, WIP warning above 3, recently done window 14 days, time zone Asia/Beirut). List config, members and projects with ArtifactData (out_dir "${cache}") first so you only ask about what is missing.`,
    `When the answers are in, show every document you will write (config/settings and config/counters only if missing; members/<slug of the name>; projects/<slug>) and write them in one ArtifactData batch after the person confirms. Member and project ids are lowercase slugs of the name. Settings fields: timezone, staleDays, wipLimit, recentlyDoneDays, jira {cloudId, baseUrl}, reports {defaultScope, defaultPeriod}. Counters: {idea: 0, task: 0}.`,
  ].join('\n')
}

// ── the tools ──────────────────────────────────────────────────────────

type Write = { op: 'set' | 'update' | 'delete'; collection: string; doc_id: string; data?: Json; if_version?: number }

function withVersion(w: Write, versions: Json): Write {
  const v = Number(versions?.[`${w.collection}/${w.doc_id}`])

  return Number.isFinite(v) && v > 0 ? { ...w, if_version: v } : w
}

function fmtPlan(cfg: LocalConfig, preview: string[], writes: Write[], warnings: string[], versions: Json): string {
  const ws = writes.map(w => withVersion(w, versions))
  const missing = ws.filter(w => w.op !== 'set' || w.collection === 'items' || w.collection === 'config').filter(w => !w.if_version && existsHint(w))

  return [
    'PREVIEW',
    ...preview,
    ...(warnings.length ? ['', 'Warnings:', ...warnings.map(w => `- ${w}`)] : []),
    '',
    `WRITES (one ArtifactData batch to ${cfg.artifactUrl}; ${ws.length} document${ws.length === 1 ? '' : 's'}):`,
    JSON.stringify(ws),
    ...(missing.length ? ['', `These existing documents need if_version from the list you made: ${missing.map(w => `${w.collection}/${w.doc_id}`).join(', ')}. Pass them in "versions" and call again.`] : []),
  ].join('\n')
}
let existing = new Set<string>()
function existsHint(w: Write): boolean {
  return existing.has(`${w.collection}/${w.doc_id}`)
}

function nameOf(b: Board, id: string | null | undefined): string {
  return b.members.find(m => m.id === id)?.name || id || 'nobody'
}

function describeItem(b: Board, it: Json): string[] {
  const proj = b.projects.find(p => p.id === it.projectId)
  const out = [`${it.id} · ${it.type === 'idea' ? 'Idea' : 'Task'} · ${it.title}`, `Project ${proj ? proj.name : it.projectId || 'none'} · ${String(it.priority)} · ${STAGE_LABEL[it.status as keyof typeof STAGE_LABEL] || it.status}`]
  if (it.type === 'task') {
    out.push(`Assignee ${it.assigneeId ? nameOf(b, it.assigneeId) : 'none'}${(it.collaboratorIds || []).length ? ` · with ${it.collaboratorIds.map((x: string) => nameOf(b, x)).join(', ')}` : ''}${it.etaCurrent ? ` · ETA ${it.etaCurrent}` : ''}`)
    if ((it.jiraKeys || []).length) out.push(`Jira ${it.jiraKeys.join(', ')}`)
  } else if (it.ownerId) out.push(`Owner ${nameOf(b, it.ownerId)}`)

  return out
}

function checkRefs(b: Board, f: Json): string[] {
  const errs: string[] = []
  const memberIds = new Set(b.members.map(m => m.id))
  for (const k of ['assigneeId', 'ownerId', 'reviewedBy']) if (f[k] && !memberIds.has(f[k])) errs.push(`${k} "${f[k]}" is not a member id. Members: ${b.members.map(m => `${m.id} (${m.name})`).join(', ')}.`)
  for (const x of f.collaboratorIds || []) if (!memberIds.has(x)) errs.push(`collaborator "${x}" is not a member id.`)
  if ('projectId' in f && f.projectId && !b.projects.some(p => p.id === f.projectId)) errs.push(`projectId "${f.projectId}" is not a project id. Projects: ${b.projects.map(p => `${p.id} (${p.name})`).join(', ') || 'none yet: add one in the dashboard Settings or with /board-setup'}.`)

  return errs
}

/** board_plan: one command's exact writes, by the shared rules. */
export async function plan($: E$, input: Json): Promise<string> {
  const cfg = await loadConfig($)
  if (!cfg) return 'ERROR: Team Board is not connected. Run /board-setup.'
  const b = await loadBoard($)
  existing = new Set([...b.items.map(i => `items/${i.id}`), ...b.members.map(m => `members/${m.id}`), ...Object.keys(b.jira).map(k => `jira/${k}`), 'config/counters', 'config/settings'])
  const ctx = await ctxOf($, b)
  const versions: Json = input.versions && typeof input.versions === 'object' ? input.versions : {}
  const op = String(input.op || '')
  const ev = (e: Json): Write => ({ op: 'set', collection: 'events', doc_id: e.id, data: e })

  if (op === 'create_task' || op === 'create_idea') {
    const kind = op === 'create_task' ? 'task' : 'idea'
    const f: Json = { ...(input.fields || {}) }
    if (!String(f.title || '').trim()) return 'ERROR: a title is needed.'
    if (!f.projectId) return `ERROR: a project is needed. Projects: ${b.projects.map(p => `${p.id} (${p.name})`).join(', ') || 'none yet: add one first (dashboard Settings or /board-setup)'}.`
    if (f.priority && !PRIORITIES.includes(f.priority)) return `ERROR: priority must be one of ${PRIORITIES.join(', ')}.`
    const errs = checkRefs(b, f)
    if (errs.length) return `ERROR: ${errs.join(' ')}`
    if (!versions['config/counters']) return 'ERROR: pass versions {"config/counters": <version>} from the list of config you just made.'
    const n = nextId(kind, b.counters)
    const made = newItem(kind, n.id, f, ctx)
    const writes: Write[] = [
      { op: 'set', collection: 'config', doc_id: 'counters', data: n.counters },
      { op: 'set', collection: 'items', doc_id: n.id, data: made.item },
      ...made.events.map(ev),
    ]
    const extra: Write[] = []
    if (Array.isArray(input.issues) || Array.isArray(input.missingKeys)) extra.push(...jiraWrites(input, b, ctx.nowIso))

    return fmtPlan(cfg, [`Create ${kind} ${n.id}:`, ...describeItem(b, made.item).map(l => `  ${l}`), ...(made.item.description ? [`  ${String(made.item.description).slice(0, 300)}`] : [])], [...writes, ...extra], [], versions)
  }

  if (op === 'change' || op === 'note' || op === 'convert') {
    const it = b.items.find(i => i.id === String(input.itemId || '').toUpperCase())
    if (!it) return `ERROR: no item "${input.itemId}" in the cache. List items into the cache, then match by ID or title.`
    if (!versions[`items/${it.id}`]) return `ERROR: pass versions {"items/${it.id}": <version>} from the list of items you just made.`

    if (op === 'note') {
      const body = String(input.body || '').trim()
      if (!body) return 'ERROR: the note is empty.'
      const e = noteEvent(it.id, input.tag || null, body, ctx)

      return fmtPlan(cfg, [`Note on ${it.id} (${it.title})${e.tag ? `, tagged ${e.tag}` : ''}:`, `  ${body}`, ...(e.tag === 'blocker' ? ['  This flags the item as Blocked until the note is resolved.'] : [])], [ev(e), { op: 'update', collection: 'items', doc_id: it.id, data: { lastActivityAt: e.createdAt, updatedAt: e.createdAt } }], [], versions)
    }

    if (op === 'convert') {
      if (it.type !== 'idea') return 'ERROR: only ideas convert into tasks.'
      const specs = (Array.isArray(input.specs) ? input.specs : []).filter((s: Json) => s && String(s.title || '').trim())
      if (!specs.length) return 'ERROR: give specs: [{title, assigneeId?, eta?}].'
      for (const s of specs) {
        const errs = checkRefs(b, s)
        if (errs.length) return `ERROR: ${errs.join(' ')}`
      }
      if (!versions['config/counters']) return 'ERROR: pass versions {"config/counters": <version>} too.'
      const r = convertIdea(it, specs, b.counters, ctx)
      const writes: Write[] = [{ op: 'set', collection: 'config', doc_id: 'counters', data: r.counters }]
      for (const t of r.tasks) writes.push({ op: 'set', collection: 'items', doc_id: t.item.id, data: t.item }, ...t.events.map(ev))
      writes.push({ op: 'update', collection: 'items', doc_id: it.id, data: r.ideaPatch }, ...r.ideaEvents.map((x: Json) => ev(x)))

      return fmtPlan(cfg, [`Convert ${it.id} (${it.title}) into ${r.tasks.length} task${r.tasks.length === 1 ? '' : 's'}; the idea moves to Converted:`, ...r.tasks.flatMap((t: any) => describeItem(b, t.item).map((l, i) => `  ${i ? '  ' : '- '}${l}`))], writes, [], versions)
    }

    const change: Json = { ...(input.change || {}) }
    const errs = checkRefs(b, change)
    if (errs.length) return `ERROR: ${errs.join(' ')}`
    if (change.reviewedBy) {
      const m = b.members.find(x => x.id === change.reviewedBy)
      const assignee = 'assigneeId' in change ? change.assigneeId : it.assigneeId
      if (m && !m.isSenior) return `ERROR: ${m.name} is not marked as senior; reviewers must be seniors (${b.members.filter(x => x.isSenior && x.active !== false).map(x => x.name).join(', ') || 'none marked yet'}).`
      if (change.reviewedBy === assignee) return 'ERROR: the reviewer cannot be the assignee.'
    }
    const r = applyChange(it, change, ctx)
    if (!Object.keys(r.patch).length) return `ERROR: nothing would change. ${r.warnings.join(' ')}`
    const after = { ...it, ...r.patch }
    const writes: Write[] = [{ op: 'update', collection: 'items', doc_id: it.id, data: r.patch }, ...r.events.map(ev)]
    if (Array.isArray(input.issues) || Array.isArray(input.missingKeys)) writes.push(...jiraWrites(input, b, ctx.nowIso))
    const lines = r.events.map((x: Json) => `  - ${x.body}`)
    const known = b.projects.flatMap(p => p.jiraProjectKeys || [])
    const soft = (change.jiraAdd || []).map((k: string) => String(k).split('-')[0]?.toUpperCase()).filter((p: string) => known.length && p && !known.includes(p)).map((p: string) => `${p} is not one of your projects' Jira keys; it is linked anyway.`)

    return fmtPlan(cfg, [`${it.id} (${it.title}):`, ...lines, '', 'After:', ...describeItem(b, after).map(l => `  ${l}`)], writes, [...r.warnings, ...soft], versions)
  }

  if (op === 'jira_keys') {
    const chunks = jiraChunks(b.items, 10)
    if (!chunks.length) return 'No Jira keys on open items: nothing to refresh.'

    return [`${chunks.flat().length} keys in ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}. Fields: ${JSON.stringify(JIRA_FIELDS)}.`, ...chunks.map((c: string[], i: number) => `Chunk ${i + 1} (maxResults ${c.length}): key in (${c.join(', ')})`)].join('\n')
  }

  if (op === 'jira_snapshots') {
    const writes = jiraWrites(input, b, ctx.nowIso)
    writes.push({ op: 'update', collection: 'config', doc_id: 'settings', data: { jira: { ...(b.settings.jira || {}), lastRefreshedAt: ctx.nowIso } } })
    const changed = writes.filter((w: Write) => w.collection === 'events').map(w => `  - ${w.data!.body}`)

    return fmtPlan(cfg, [`Jira cache: ${writes.filter(w => w.collection === 'jira').length} ticket${writes.length === 1 ? '' : 's'}.`, ...(changed.length ? ['Status changes:', ...changed] : [])], writes, [], versions)
  }

  return 'ERROR: op must be create_task, create_idea, change, note, convert, jira_keys or jira_snapshots.'
}

function jiraWrites(input: Json, b: Board, nowIso: string): Write[] {
  const out: Write[] = []
  const issues = issuesFrom({ issues: Array.isArray(input.issues) ? input.issues.flatMap((x: Json) => issuesFrom(x).length ? issuesFrom(x) : [x]) : [] })
  for (const issue of issues) {
    if (!issue || !issue.key) continue
    const snap = jiraSnapshot(issue, nowIso)
    const old = b.jira[snap.key]
    out.push({ op: 'set', collection: 'jira', doc_id: snap.key, data: snap })
    if (old && old.status && snap.status && old.status !== snap.status) {
      for (const it of b.items.filter(i => !i.archived && [...(i.jiraKeys || []), ...(i.jiraRefs || [])].includes(snap.key))) {
        const id = `E-${Date.parse(nowIso).toString(36)}-${snap.key.toLowerCase()}-${it.id.toLowerCase()}`
        out.push({ op: 'set', collection: 'events', doc_id: id, data: { id, itemId: it.id, kind: 'system', tag: null, body: `Jira ${snap.key}: ${old.status} → ${snap.status}`, createdAt: nowIso, editedAt: null, resolved: false, systemType: 'jira_refreshed', data: { key: snap.key, from: old.status, to: snap.status } } })
      }
    }
  }
  for (const k of Array.isArray(input.missingKeys) ? input.missingKeys : []) {
    const key = String(k).toUpperCase()
    const old = b.jira[key] || {}
    out.push({ op: 'set', collection: 'jira', doc_id: key, data: { key, summary: old.summary || '', status: old.status || '', statusCategory: old.statusCategory || '', assigneeAccountId: null, assigneeName: null, priority: null, created: null, updated: null, resolutionDate: null, fetchedAt: nowIso, error: 'not found or no access' } })
  }

  return out
}

/** board_summary: who is on what, and what needs attention. */
export async function summary($: E$): Promise<string> {
  const cfg = await loadConfig($)
  if (!cfg) return 'Team Board is not connected. Run /board-setup.'
  const b = await loadBoard($)
  const today = await todayOf($, b)
  const fctx = { today, settings: b.settings, blockers: openBlockers(b.events), jira: b.jira, members: b.members }
  const live = b.items.filter(i => !i.archived)
  const wip = wipOver(live, b.settings.wipLimit)
  const tag = (it: Json) => {
    const f = flagsFor(it, fctx)
    const t = [f.overdue && 'overdue', f.slipped && `slipped ${f.slipDays}d`, f.blocked && 'blocked', f.stale && 'stale', f.needsClosing && 'needs closing'].filter(Boolean)

    return `${it.id} ${it.title}${it.etaCurrent ? ` (ETA ${it.etaCurrent})` : ''}${t.length ? ` [${t.join(', ')}]` : ''}`
  }
  const out = [`Team Board · ${today}`]
  for (const m of b.members.filter(x => x.active !== false).sort((x, y) => String(x.name).localeCompare(String(y.name)))) {
    const mine = live.filter(i => i.type === 'task' && i.assigneeId === m.id)
    const ongoing = mine.filter(isOngoing).sort(byQueue)
    const next = mine.filter(i => ['assigned', 'backlog'].includes(i.status)).sort(byQueue)
    out.push('', `${m.name}${wip[m.id] ? ` (over WIP limit: ${wip[m.id]} ongoing)` : ''}`)
    out.push(ongoing.length ? ongoing.map(i => `  ▸ ${tag(i)} · ${STAGE_LABEL[i.status as keyof typeof STAGE_LABEL]}`).join('\n') : '  nothing ongoing')
    if (next.length) out.push(`  next: ${next.slice(0, 3).map(i => i.id).join(', ')}${next.length > 3 ? ` +${next.length - 3}` : ''}`)
  }
  const unassigned = live.filter(i => i.type === 'task' && !i.assigneeId && isOpenTask(i)).sort(byPriority)
  if (unassigned.length) out.push('', `Unassigned: ${unassigned.map(i => i.id).join(', ')}`)
  const flagged = live.filter(isOpenTask).map(i => ({ i, f: flagsFor(i, fctx) }))
  const count = (k: string) => flagged.filter(x => (x.f as Json)[k]).length
  const line = ['overdue', 'blocked', 'stale', 'slipped', 'needsClosing'].map(k => [k, count(k)] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'needsClosing' ? 'need closing' : k}`)
  out.push('', line.length ? `Attention: ${line.join(' · ')}` : 'Nothing overdue, blocked or stale.')
  const ideas = live.filter(i => i.type === 'idea' && ['new', 'discussing', 'approved'].includes(i.status))
  if (ideas.length) out.push(`Ideas open: ${ideas.length} (${ideas.filter(i => i.status === 'approved').length} approved, ready to convert)`)
  const age = Math.max(...Object.values(b.fetchedAt))
  out.push('', `Data as of ${age ? new Date(age).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never (the cache is empty)'} · Dashboard: ${cfg.artifactUrl}`)
  await refreshStatus($, b)

  return out.join('\n')
}

/** board_report: the numbers (first call) and the saved report (second call, with summary). */
export async function report($: E$, input: Json): Promise<string> {
  const cfg = await loadConfig($)
  if (!cfg) return 'ERROR: Team Board is not connected. Run /board-setup.'
  const b = await loadBoard($)
  const ms = await now($)
  const today = todayIn(b.settings.timezone || 'Asia/Beirut', ms)
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : { kind: 'team' }
  if (!['team', 'group', 'project', 'member'].includes(scope.kind)) return 'ERROR: scope.kind is team, group, project or member.'
  if (scope.kind === 'member' && !b.members.some(m => m.id === scope.value)) return `ERROR: member "${scope.value}" is not a member id. Members: ${b.members.map(m => `${m.id} (${m.name})`).join(', ')}.`
  if (scope.kind === 'project' && !b.projects.some(p => p.id === scope.value)) return `ERROR: project "${scope.value}" is not a project id. Projects: ${b.projects.map(p => `${p.id} (${p.name})`).join(', ') || 'none'}.`
  if (scope.kind === 'group' && !b.members.some(m => (m.teams || []).includes(scope.value))) return `ERROR: no one is in team "${scope.value}". Teams: ${[...new Set(b.members.flatMap(m => m.teams || []))].join(', ')}.`
  const period = String(input.period || b.settings.reports?.defaultPeriod || 'this_week')
  if (!(period in PERIODS)) return `ERROR: period is one of ${Object.keys(PERIODS).join(', ')}.`
  const data = { items: b.items, events: b.events, members: b.members, projects: b.projects, jira: b.jira, settings: b.settings, scope, period, custom: { from: input.from, to: input.to }, today }
  const r = computeReport(data)
  const id = String(input.reportId || `R-${ms.toString(36)}`)
  const md = reportMarkdown(r, String(input.summary || ''))
  if (!input.summary) return [`reportId: ${id}`, '', md, '', 'FACTS for the summary (use only these):', summaryFacts(r)].join('\n')

  const dir = `${await boardDir($)}/reports`
  const base = `${dir}/${id}-${String(r.scopeLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${r.range.from}-to-${r.range.to}`
  await $.fs.write(`${base}.md`, md)
  await $.fs.write(`${base}.csv`, reportCsv(data).csv)
  const doc = { id, scope: r.scope, scopeLabel: r.scopeLabel, period: r.period, range: r.range, custom: period === 'custom' ? { from: input.from, to: input.to } : null, generatedAt: new Date(ms).toISOString(), numbers: r.headline, report: r, summary: String(input.summary), markdown: md }

  return [`Saved locally: ${base}.md and ${base}.csv`, '', `WRITES (one ArtifactData batch to ${cfg.artifactUrl}):`, JSON.stringify([{ op: 'set', collection: 'reports', doc_id: id, data: doc }])].join('\n')
}

/** board_connect: remember the board's link. */
async function connect($: E$, input: Json): Promise<string> {
  const url = String(input.url || '').trim()
  if (!/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+/.test(url)) return 'ERROR: give the board’s claude.ai artifact link.'
  const old = await loadConfig($)
  await saveConfig($, { adapter: 'artifact-db', artifactUrl: url, artifactSlug: slugOf(url), lastToastDate: old?.lastToastDate ?? null, lastFlagged: old?.lastFlagged ?? [] })

  return `Connected: ${url}. Saved in ~/.team-board/config.json. Now list config, members and projects into ${await cacheDir($)} and continue the setup.`
}

// ── status line and daily toast ────────────────────────────────────────

export async function refreshStatus($: E$, board?: Board): Promise<string> {
  const cfg = await loadConfig($)
  if (!cfg) {
    await $.ui.status(undefined)

    return ''
  }
  const b = board || (await loadBoard($))
  const today = await todayOf($, b)
  const line = statusLine(b.items, b.events, { today, settings: b.settings, jira: b.jira, members: b.members })
  await $.ui.status(line ? `📋 ${line}` : undefined)

  return line
}

/** Once a day: items that became overdue or stale since the last toast. */
export async function dailyToast($: E$): Promise<string> {
  const cfg = await loadConfig($)
  if (!cfg) return ''
  const b = await loadBoard($)
  if (!b.items.length) return ''
  const today = await todayOf($, b)
  if (cfg.lastToastDate === today) return ''
  const fctx = { today, settings: b.settings, blockers: openBlockers(b.events), jira: b.jira, members: b.members }
  const flagged: string[] = []
  for (const it of b.items.filter(i => !i.archived && isOpenTask(i))) {
    const f = flagsFor(it, fctx)
    if (f.overdue) flagged.push(`${it.id}:overdue`)
    if (f.stale) flagged.push(`${it.id}:stale`)
  }
  const seen = new Set(cfg.lastFlagged)
  const fresh = flagged.filter(x => !seen.has(x))
  await saveConfig($, { ...cfg, lastToastDate: today, lastFlagged: flagged })
  if (!fresh.length) return ''
  const overdue = fresh.filter(x => x.endsWith(':overdue')).map(x => x.split(':')[0])
  const stale = fresh.filter(x => x.endsWith(':stale')).map(x => x.split(':')[0])
  const text = `Team Board: ${[overdue.length && `${overdue.join(', ')} now overdue`, stale.length && `${stale.join(', ')} now stale`].filter(Boolean).join('; ')}. /board for details.`
  await $.ui.toast(text)

  return text
}

// ── wiring ─────────────────────────────────────────────────────────────

/**
 * A command cannot submit a prompt while it holds its own turn, so it leaves
 * the procedure here and the end of that turn hands it to Claude.
 */
let pending: string | null = null

async function handOff($: E$): Promise<void> {
  const text = pending
  pending = null
  if (text) await $.prompt.submit({ text })
}

const COMMANDS: [string, string, string][] = [
  ['idea', 'Team Board: capture an idea (e.g. project Atlas, owner me, high: offline plan cache)', '<text>'],
  ['task', 'Team Board: capture a task (e.g. Ada, high, ETA Fri, project Atlas: fix APN retry crash), or from-session', '<text | from-session>'],
  ['assign', 'Team Board: assign or reassign an item', '<item> <member>'],
  ['board-status', 'Team Board: change an item’s stage (date rules apply)', '<item> <stage>'],
  ['eta', 'Team Board: set or change a task’s ETA', '<item> <date>'],
  ['note', 'Team Board: add a note (blocker, decision, update or review)', '<item> [tag] <text>'],
  ['link', 'Team Board: link Jira tickets to an item (read only)', '<item> <key or URL…>'],
  ['board-review', 'Team Board: record a senior’s review of a task', '<item> <senior> [note]'],
  ['board', 'Team Board: who is on what and what needs attention; "refresh" re-reads Jira', '[refresh]'],
  ['board-report', 'Team Board: an executive report for a scope and period', '<scope> <period>'],
  ['board-setup', 'Team Board: connect the board, roster, projects and thresholds', '[board link]'],
]

const TOOLS = [
  {
    name: 'board_plan',
    description:
      'Team Board: turns one change into the exact database writes by the board’s rules (IDs, date rules, history, events). Read the cache first (ArtifactData list with out_dir ~/.team-board/cache). Answers a PREVIEW and WRITES to send as one ArtifactData batch after the person confirms.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['create_task', 'create_idea', 'change', 'note', 'convert', 'jira_keys', 'jira_snapshots'] },
        itemId: { type: 'string', description: 'For change, note, convert: the item id (T-0001, I-0001).' },
        fields: { type: 'object', description: 'For create: title, projectId, priority, description; task: assigneeId, collaboratorIds, eta, status, jiraKeys; idea: ownerId, rationale, jiraRefs.' },
        change: { type: 'object', description: 'For change: any of status, assigneeId, collaboratorIds, eta, reviewedBy, reviewNote, priority, projectId, ownerId, title, description, jiraAdd, jiraRemove, archived, dates {startDate|reviewRequestedAt|endDate|reviewedOn}.' },
        tag: { type: 'string', enum: ['blocker', 'decision', 'update', 'review'] },
        body: { type: 'string' },
        specs: { type: 'array', items: { type: 'object' }, description: 'For convert: [{title, assigneeId?, eta?}].' },
        issues: { type: 'array', items: { type: 'object' }, description: 'Jira issues as the connector returned them (for link and jira_snapshots).' },
        missingKeys: { type: 'array', items: { type: 'string' } },
        versions: { type: 'object', description: 'The version of each document you will write, as {"items/T-0001": 3, "config/counters": 5}, from the list you made.' },
      },
      required: ['op'],
    },
  },
  { name: 'board_summary', description: 'Team Board: per-member ongoing work, flags and the dashboard link, from the cache (list the collections into ~/.team-board/cache first).', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'board_report',
    description: 'Team Board: report numbers for a scope and period from the cache (deterministic, the dashboard’s own formulas). First call without summary answers the numbers and facts; second call with summary and reportId saves Markdown and CSV locally and answers the reports/{id} write.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'object', properties: { kind: { type: 'string', enum: ['team', 'group', 'project', 'member'] }, value: { type: 'string' } } },
        period: { type: 'string', enum: Object.keys(PERIODS) },
        from: { type: 'string' },
        to: { type: 'string' },
        summary: { type: 'string' },
        reportId: { type: 'string' },
      },
    },
  },
  { name: 'board_connect', description: 'Team Board: remember the board’s claude.ai artifact link in ~/.team-board/config.json.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
]

/** A best-effort refresh of the cache by the mod itself; quietly does nothing if the tool is not callable here. */
async function tryLiveRefresh($: E$): Promise<boolean> {
  const cfg = await loadConfig($)
  if (!cfg) return false
  const out = await cacheDir($)
  try {
    for (const collection of ['config', 'members', 'projects', 'items', 'events', 'jira']) {
      await $.tool.call({ tool: 'ArtifactData', action: 'list', url: cfg.artifactUrl, collection, out_dir: out, query: { limit: 1000 } } as never)
    }

    return true
  } catch {
    return false
  }
}

function failed() {
  return { result: 'ERROR: the Team Board tool failed; try again, or list the cache again first.' }
}

function cmdFailed() {
  return { text: 'Team Board: that command failed. Try again, or run /board-setup if the board is not connected.' }
}

/** The ArtifactData hook only redraws the status line: if it fails, the call goes on untouched (next is replay-safe). */
function passThrough($: E$, e: any, next: any) {
  return next(e)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    for (const [name, description, argumentHint] of COMMANDS) await $.command.register({ name, description, argumentHint }).catch(() => undefined)
    for (const t of TOOLS) await $.tool.register({ ...t, isDeferred: true } as never).catch(() => undefined)
    await tryLiveRefresh($)
    await refreshStatus($).catch(() => undefined)
    await dailyToast($).catch(() => undefined)

    return r
  })

  for (const [name] of COMMANDS) {
    on('command.run', { command: name }, async ($, e) => {
      const cfg = await loadConfig($)
      const cache = await cacheDir($)
      if (name === 'board-setup') {
        const url = (/https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/.exec(e.args) || [])[0]
        if (url) await connect($, { url })
        pending = setupProcedure(url ? await loadConfig($) : cfg, url ? e.args.replace(url, '') : e.args, $.plugin.root, cache)

        return { text: url ? `Team Board connected to ${url}. Setting up…` : 'Team Board setup…' }
      }
      if (!cfg) return { text: 'Team Board is not set up yet: run /board-setup.' }
      if (['idea', 'task', 'assign', 'board-status', 'eta', 'note', 'link', 'board-review'].includes(name) && !e.args.trim()) {
        return { text: `Usage: /${name} ${COMMANDS.find(c => c[0] === name)![2]}` }
      }
      const b = await loadBoard($)
      const text = procedure(name, e.args, cfg, cache, await todayOf($, b))
      if (!text) return { text: 'Unknown Team Board command.' }
      pending = text

      return { text: `Team Board: /${name} ${e.args.trim()}`.trim() }
    }).catch(cmdFailed)
  }

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => ({ result: await plan($, e as unknown as Json) })).catch(failed)
  on('tool.call', { tool: SUMMARY_TOOL }, async $ => ({ result: await summary($) })).catch(failed)
  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => ({ result: await report($, e as unknown as Json) })).catch(failed)
  on('tool.call', { tool: CONNECT_TOOL }, async ($, e) => ({ result: await connect($, e as unknown as Json) })).catch(failed)

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (pending && !e.agentId) {
      $.clock.after(0, () => {
        void handOff($)
      })
    }

    return done
  }).catch(passThrough)

  // The cache changed (Claude listed or wrote the board): redraw the status line.
  on('tool.call', { tool: 'ArtifactData' }, async ($, e, next) => {
    const r = await next(e)
    const cfg = await loadConfig($).catch(() => null)
    if (cfg && String((e as unknown as Json).url || '').includes(cfg.artifactSlug)) await refreshStatus($).catch(() => undefined)

    return r
  }).catch(passThrough)
}

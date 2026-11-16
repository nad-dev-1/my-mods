// Jira through the Atlassian connection the person already has. READ-ONLY:
// this file only ever calls search and read operations, and the tests hold
// the mod to that.

import type { EngineInterface } from 'claude-code'

import type { Issue } from '../types'

type E$ = EngineInterface
type Json = Record<string, unknown>

export const SERVER = 'claude_ai_Atlassian_MCP'

/** The only tools this mod calls. */
export const READ_TOOLS = ['searchJiraIssuesUsingJql', 'executeRead', 'getAccessibleAtlassianResources'] as const

export const ISSUE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'project',
  'parent',
  'assignee',
  'reporter',
  'created',
  'statuscategorychangedate',
  'timetracking',
  'timeoriginalestimate',
  'timespent',
  'labels',
]

function asObj(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Jira's `2026-11-12T11:54:52.020+0100` → ms. */
export function jiraMs(text: unknown): number {
  const t = str(text)
  if (!t) return 0
  const ms = Date.parse(t.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))

  return Number.isFinite(ms) ? ms : 0
}

async function call($: E$, tool: (typeof READ_TOOLS)[number], args: Json): Promise<Json> {
  const res = await $.mcp.call(SERVER, tool, args)
  const text = res.content.map(b => (asObj(b).type === 'text' ? str(asObj(b).text) : '')).join('')
  if (res.isError) throw new Error(text.slice(0, 300) || `${tool} failed`)
  if (res.structuredContent !== undefined && res.structuredContent !== null) return asObj(res.structuredContent)
  try {
    return asObj(JSON.parse(text))
  } catch {
    return { text }
  }
}

async function read($: E$, cloudId: string, name: string, inputs: Json): Promise<Json> {
  const r = await call($, 'executeRead', { name, cloudId, inputs })

  return asObj(r.data ?? r)
}

export async function site($: E$): Promise<{ cloudId: string; url: string }> {
  const r = await call($, 'getAccessibleAtlassianResources', {})
  const list = (asObj(r.data ?? r).resources ?? []) as Json[]
  const jira = list.find(x => ((x.products ?? []) as Json[]).some(p => p.id === 'jira')) ?? list[0]
  if (!jira) throw new Error('No Atlassian site is reachable through the connection')

  return { cloudId: str(jira.cloudId), url: str(jira.url) }
}

export type User = { accountId: string; email: string; name: string }

function userOf(v: unknown): User | null {
  const u = asObj(v)
  const accountId = str(u.accountId)

  return accountId ? { accountId, email: str(u.emailAddress).toLowerCase(), name: str(u.displayName) } : null
}

export type RawIssue = Issue & { assigneeUser: User | null; reporterUser: User | null; parentType: string }

function toIssue(node: Json): RawIssue {
  const f = asObj(node.fields)
  const status = asObj(f.status)
  const parent = asObj(f.parent)
  const tt = asObj(f.timetracking)
  const assigneeUser = userOf(f.assignee)
  const reporterUser = userOf(f.reporter)

  return {
    key: str(node.key),
    summary: str(f.summary),
    project: str(asObj(f.project).key),
    type: str(asObj(f.issuetype).name),
    status: str(status.name),
    statusCat: str(asObj(status.statusCategory).key),
    assignee: assigneeUser?.email || assigneeUser?.name || '',
    reporter: reporterUser?.email || reporterUser?.name || '',
    parent: str(parent.key),
    parentSummary: str(asObj(parent.fields).summary),
    parentType: str(asObj(asObj(parent.fields).issuetype).name),
    estimateSec: num(tt.originalEstimateSeconds) || num(f.timeoriginalestimate),
    spentSec: num(tt.timeSpentSeconds) || num(f.timespent),
    remainingSec: num(tt.remainingEstimateSeconds),
    statusSince: jiraMs(f.statuscategorychangedate),
    created: jiraMs(f.created),
    labels: Array.isArray(f.labels) ? (f.labels as unknown[]).map(str) : [],
    assigneeUser,
    reporterUser,
  }
}

/**
 * JQL search, paged up to `max` issues. Each issue's answer is several KB (user
 * avatars and all), and an answer too large for a mod arrives cut off and
 * unreadable: so pages start small and halve whenever one comes back cut.
 */
export async function search($: E$, cloudId: string, jql: string, max = 100): Promise<RawIssue[]> {
  const out: RawIssue[] = []
  let token = ''
  let size = 20
  while (out.length < max) {
    const args: Json = { cloudId, jql, fields: ISSUE_FIELDS, maxResults: Math.min(size, max - out.length) }
    if (token) args.nextPageToken = token
    let r: Json
    try {
      r = await call($, 'searchJiraIssuesUsingJql', args)
    } catch (err) {
      // A later page that fails (some JQL cannot be paged) keeps what came back.
      if (out.length > 0) break
      throw err
    }
    if (typeof r.text === 'string' && r.issues === undefined) {
      if (size > 2) {
        size = Math.max(2, Math.floor(size / 2))
        continue
      }
      throw new Error(`Jira's answer for "${jql.slice(0, 60)}" was too large to read`)
    }
    const issues = asObj(r.issues)
    const nodes = (Array.isArray(issues.nodes) ? issues.nodes : Array.isArray(r.issues) ? r.issues : []) as Json[]
    out.push(...nodes.map(toIssue))
    const page = asObj(issues.pageInfo)
    token = str(page.endCursor) || str(r.nextPageToken)
    if (page.hasNextPage !== true || !token || nodes.length === 0) break
  }

  return out
}

/** A member's account, found through issues they are assignee or reporter of. */
export async function findUser($: E$, cloudId: string, email: string, name: string): Promise<User | null> {
  const q = email.replace(/"/g, '')
  const hits = await search($, cloudId, `assignee = "${q}" OR reporter = "${q}" ORDER BY updated DESC`, 5).catch(() => [])
  const users = hits.flatMap(h => [h.assigneeUser, h.reporterUser]).filter((u): u is User => u !== null)
  const lower = email.toLowerCase()

  return users.find(u => u.email === lower) ?? users.find(u => u.name.toLowerCase() === name.toLowerCase()) ?? null
}

export type RawWorklog = { id: string; accountId: string; started: number; seconds: number; comment: string }

export async function worklogs($: E$, cloudId: string, key: string, fromMs: number, toMs: number): Promise<RawWorklog[]> {
  const out: RawWorklog[] = []
  let startAt = 0
  for (;;) {
    const r = await read($, cloudId, 'listJiraIssueWorklogs', {
      issueIdOrKey: key,
      startedAfter: Math.max(0, Math.floor(fromMs)),
      startedBefore: Math.floor(toMs),
      startAt,
      maxResults: 100,
    })
    const list = (r.worklogs ?? []) as Json[]
    for (const w of list) {
      out.push({
        id: str(w.id),
        accountId: str(asObj(w.author).accountId),
        started: jiraMs(w.started),
        seconds: num(w.timeSpentSeconds),
        comment: typeof w.comment === 'string' ? w.comment : '',
      })
    }
    startAt += list.length
    if (list.length === 0 || r.isLast === true || startAt >= num(r.total)) break
  }

  return out
}

export type RawMove = { accountId: string; at: number; from: string; to: string }

/** Status changes of an issue (the newest 100), oldest first. */
export async function statusMoves($: E$, cloudId: string, key: string): Promise<RawMove[]> {
  const probe = await read($, cloudId, 'listJiraIssueChangelogs', { issueIdOrKey: key, maxResults: 1 })
  const total = num(probe.total)
  const out: RawMove[] = []
  for (let startAt = Math.max(0, total - 100); startAt < total; startAt += 50) {
    const r = await read($, cloudId, 'listJiraIssueChangelogs', { issueIdOrKey: key, startAt, maxResults: 50 })
    for (const entry of (r.values ?? []) as Json[]) {
      for (const item of (entry.items ?? []) as Json[]) {
        if (str(item.field) !== 'status' && str(item.fieldId) !== 'status') continue
        out.push({ accountId: str(asObj(entry.author).accountId), at: jiraMs(entry.created), from: str(item.fromString), to: str(item.toString) })
      }
    }
  }

  return out
}

// Jira through the Atlassian connection the person already has (no credentials
// of the mod's own). Every write here is reached only from the confirmed
// preview in register.tsx.

import type { EngineInterface } from 'claude-code'

import type { Ticket, Transition } from '../types'

type E$ = EngineInterface

export const SERVER = 'claude_ai_Atlassian_MCP'

const TICKET_FIELDS = ['summary', 'status', 'issuetype', 'project', 'parent', 'updated', 'timetracking']

type Json = Record<string, unknown>

function asObj(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

/** Calls one tool of the connection and parses its JSON text answer. */
export async function call($: E$, tool: string, args: Json): Promise<Json> {
  const res = await $.mcp.call(SERVER, tool, args)
  const text = res.content
    .map(b => (asObj(b).type === 'text' ? str(asObj(b).text) : ''))
    .join('')
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

async function write($: E$, cloudId: string, name: string, inputs: Json): Promise<Json> {
  const r = await call($, 'executeWrite', { name, cloudId, inputs })

  return asObj(r.data ?? r)
}

export async function site($: E$): Promise<{ cloudId: string; url: string }> {
  const r = await call($, 'getAccessibleAtlassianResources', {})
  const list = (asObj(r.data ?? r).resources ?? []) as Json[]
  const jira = list.find(x => ((x.products ?? []) as Json[]).some(p => p.id === 'jira')) ?? list[0]
  if (!jira) throw new Error('No Atlassian site is reachable through the connection')

  return { cloudId: str(jira.cloudId), url: str(jira.url) }
}

export async function myAccountId($: E$): Promise<string> {
  const r = await call($, 'atlassianUserInfo', {})

  return str(asObj(r.data ?? r).accountId)
}

function toTicket(node: Json): Ticket {
  const f = asObj(node.fields)
  const status = asObj(f.status)
  const parent = asObj(f.parent)
  const tt = asObj(f.timetracking)

  return {
    key: str(node.key),
    summary: str(f.summary),
    status: str(status.name),
    statusCat: str(asObj(status.statusCategory).key),
    type: str(asObj(f.issuetype).name),
    project: str(asObj(f.project).key),
    parentKey: str(parent.key),
    parentSummary: str(asObj(parent.fields).summary),
    updated: str(f.updated),
    remainingSec: typeof tt.remainingEstimateSeconds === 'number' ? tt.remainingEstimateSeconds : 0,
  }
}

/**
 * JQL search, paged up to `max` issues. An answer too large for a mod arrives
 * cut off and unreadable: so pages start small and halve whenever one comes
 * back cut.
 */
export async function search($: E$, cloudId: string, jql: string, max = 100, fields = TICKET_FIELDS): Promise<Ticket[]> {
  const out: Ticket[] = []
  let token = ''
  let size = 25
  while (out.length < max) {
    const args: Json = { cloudId, jql, fields, maxResults: Math.min(size, max - out.length) }
    if (token) args.nextPageToken = token
    let r: Json
    try {
      r = await call($, 'searchJiraIssuesUsingJql', args)
    } catch (err) {
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
    out.push(...nodes.map(toTicket))
    const page = asObj(issues.pageInfo)
    token = str(page.endCursor) || str(r.nextPageToken)
    const more = page.hasNextPage === true || (r.isLast === false && token !== '')
    if (!more || nodes.length === 0) break
  }

  return out
}

export async function issueTypes($: E$, cloudId: string, project: string): Promise<string[]> {
  const r = await read($, cloudId, 'listJiraProjectIssueTypesMetadata', { projectIdOrKey: project, maxResults: 50 })

  return ((r.issueTypes ?? r.values ?? []) as Json[]).map(t => str(t.name)).filter(Boolean)
}

export async function transitions($: E$, cloudId: string, key: string): Promise<Transition[]> {
  const r = await read($, cloudId, 'listJiraIssueTransitions', { issueIdOrKey: key })

  return ((r.transitions ?? []) as Json[]).map(t => ({ id: str(t.id), name: str(t.name), to: str(asObj(t.to).name) || str(t.name) }))
}

export type JiraWorklog = { id: string; key: string; accountId: string; author: string; startedMs: number; seconds: number; comment: string }

export async function worklogs($: E$, cloudId: string, key: string, fromMs: number, toMs: number): Promise<JiraWorklog[]> {
  const out: JiraWorklog[] = []
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
      const a = asObj(w.author)
      out.push({
        id: str(w.id),
        key,
        accountId: str(a.accountId),
        author: str(a.displayName),
        startedMs: Date.parse(str(w.started).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')),
        seconds: typeof w.timeSpentSeconds === 'number' ? w.timeSpentSeconds : 0,
        comment: typeof w.comment === 'string' ? w.comment : '',
      })
    }
    startAt += list.length
    const total = typeof r.total === 'number' ? r.total : 0
    if (list.length === 0 || r.isLast === true || startAt >= total) break
  }

  return out
}

export async function createIssue(
  $: E$,
  cloudId: string,
  x: { project: string; issueType: string; summary: string; description: string; labels: string[]; parent: string; assignee: string },
): Promise<string> {
  const args: Json = { cloudId, projectKey: x.project, issueType: x.issueType, summary: x.summary }
  if (x.description) args.description = x.description
  if (x.labels.length) args.labels = x.labels
  if (x.parent) args.parent = x.parent
  if (x.assignee) args.assignee = x.assignee
  const r = await call($, 'createJiraIssue', args)
  const d = asObj(r.data ?? r)
  const key = str(d.key) || str(asObj(d.issue).key) || (/"key"\s*:\s*"([A-Z][A-Z0-9]+-\d+)"/.exec(JSON.stringify(r))?.[1] ?? '')
  if (!key) throw new Error('The create answered with no issue key')

  return key
}

export async function setParent($: E$, cloudId: string, key: string, parent: string): Promise<void> {
  await call($, 'editJiraIssue', { cloudId, issueIdOrKey: key, fields: { parent: { key: parent } } })
}

export async function transition($: E$, cloudId: string, key: string, transitionId: string): Promise<string> {
  const r = await call($, 'transitionJiraIssue', { cloudId, issueIdOrKey: key, transitionId })

  return str(asObj(asObj(r.data ?? r).status).name)
}

/** Adds a worklog (no id) or edits one; answers the worklog id. */
export async function putWorklog(
  $: E$,
  cloudId: string,
  x: { key: string; started: string; minutes: number; comment: string; worklogId?: string },
): Promise<string> {
  const inputs: Json = { issueIdOrKey: x.key, timeSpent: `${Math.floor(x.minutes / 60)}h ${x.minutes % 60}m`, started: x.started }
  if (x.comment) inputs.comment = x.comment
  if (x.worklogId) inputs.worklogId = x.worklogId
  const r = await write($, cloudId, 'addOrEditJiraIssueWorklog', inputs)

  return str(r.id) || str(asObj(r.worklog).id) || x.worklogId || ''
}

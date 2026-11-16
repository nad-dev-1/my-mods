// Local git facts, read by running git. The mod never commits or pushes code;
// the one git write is a branch rename, and only from the confirmed preview.

import type { EngineInterface } from 'claude-code'

import type { Commit } from '../types'
import type { RepoInfo } from './core'

type E$ = EngineInterface

export async function git($: E$, cwd: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs })

    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
  }
}

export async function repoOf($: E$, cwd: string): Promise<RepoInfo> {
  const r = await git($, cwd, ['rev-parse', '--show-toplevel'], 5_000)
  const root = r.ok ? r.out.trim() : cwd

  return { root, repo: root.split('/').filter(Boolean).pop() ?? root }
}

export async function authorEmail($: E$, cwd: string): Promise<string> {
  const r = await git($, cwd, ['config', 'user.email'], 5_000)

  return r.ok ? r.out.trim() : ''
}

/** My commits in the repo since `sinceMs`, on any branch, with line counts. */
export async function commitsSince($: E$, root: string, sinceMs: number, email: string): Promise<Commit[]> {
  const args = ['log', '--all', `--since=${new Date(sinceMs).toISOString()}`, '--numstat', '--pretty=format:@@%H|%ct|%D|%s']
  if (email) args.push(`--author=${email}`)
  const r = await git($, root, args, 30_000)
  if (!r.ok) return []
  const out: Commit[] = []
  let cur: Commit | null = null
  for (const line of r.out.split('\n')) {
    if (line.startsWith('@@')) {
      const [sha = '', at = '0', refs = '', ...subject] = line.slice(2).split('|')
      const branch = refs.split(',').map(x => x.replace('HEAD ->', '').trim()).find(x => x && !x.startsWith('tag:')) ?? ''
      cur = { sha, at: Number(at) * 1000, subject: subject.join('|'), added: 0, removed: 0, files: 0, branch }
      out.push(cur)
    } else if (cur && /^(\d+|-)\t/.test(line)) {
      const [a = '0', d = '0'] = line.split('\t')
      cur.added += Number(a) || 0
      cur.removed += Number(d) || 0
      cur.files += 1
    }
  }

  return out
}

export async function currentBranch($: E$, root: string): Promise<string> {
  const r = await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'], 5_000)

  return r.ok ? r.out.trim() : ''
}

export async function uncommitted($: E$, root: string): Promise<number> {
  const r = await git($, root, ['status', '--porcelain'], 10_000)

  return r.ok ? r.out.split('\n').filter(Boolean).length : 0
}

export type BranchPush = { branch: string; upstream: string; ahead: number }

/** Local branches with commits not on their upstream, or with none. */
export async function unpushed($: E$, root: string): Promise<BranchPush[]> {
  const r = await git($, root, ['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)', 'refs/heads'], 10_000)
  if (!r.ok) return []

  return r.out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [branch = '', upstream = '', track = ''] = line.split('|')
      const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)

      return { branch, upstream, ahead }
    })
}

export async function isPushed($: E$, root: string, branch: string): Promise<boolean> {
  const r = await git($, root, ['ls-remote', '--heads', 'origin', branch], 15_000)

  return r.ok && r.out.trim() !== ''
}

export async function remoteUrl($: E$, root: string): Promise<string> {
  const r = await git($, root, ['remote', 'get-url', 'origin'], 5_000)

  return r.ok ? r.out.trim() : ''
}

/** Whether an open merge/pull request exists for the branch; null when no CLI can tell. */
export async function hasMergeRequest($: E$, root: string, branch: string): Promise<boolean | null> {
  const url = await remoteUrl($, root)
  const tries: string[][] = url.includes('github.com')
    ? [['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']]
    : [['glab', 'mr', 'list', '--source-branch', branch, '--output', 'json']]
  for (const argv of tries) {
    for (const bin of [argv[0]!, `/opt/homebrew/bin/${argv[0]}`, `/usr/local/bin/${argv[0]}`]) {
      try {
        const r = await $.process.run([bin, ...argv.slice(1)], { cwd: root, timeoutMs: 20_000 })
        if (r.exitCode !== 0) continue
        const list = JSON.parse(r.stdout || '[]') as unknown[]

        return Array.isArray(list) && list.length > 0
      } catch {
        continue
      }
    }
  }

  return null
}

/** Renames a branch locally and, when it was pushed, on origin too. */
export async function renameBranch($: E$, root: string, from: string, to: string, pushed: boolean): Promise<void> {
  const local = await git($, root, ['branch', '-m', from, to])
  if (!local.ok) throw new Error(local.err.trim() || 'git branch -m failed')
  if (!pushed) return
  const push = await git($, root, ['push', '-u', 'origin', to], 60_000)
  if (!push.ok) throw new Error(`renamed locally; push of ${to} failed: ${push.err.trim().slice(0, 200)}`)
  const del = await git($, root, ['push', 'origin', '--delete', from], 60_000)
  if (!del.ok) throw new Error(`pushed ${to}; deleting remote ${from} failed: ${del.err.trim().slice(0, 200)}`)
}

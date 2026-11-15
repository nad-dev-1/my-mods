---
name: review-mr
description: Full review of one GitLab merge request - conflict gate, MR code fetched into a worktree, then in parallel the pipelines and their security scans, Sonar results (SonarCloud or a local Docker scan), the project's own code review and a files-and-secrets check of every commit (gitleaks plus files that should not be merged), ending in one report and a question about deleting the worktree. Use when given a GitLab merge request URL to review, or when the Git Review mod starts it.
argument-hint: <GitLab merge request URL> [--allowed <comma-separated path globs>]
---

# Review a GitLab merge request

The argument is a merge request URL such as
`https://gitlab.com/group/sub/project/-/merge_requests/123`, optionally followed by
`--allowed <comma-separated path globs>` (the Git Review mod adds this from its "Allowed paths" setting). You run in a local clone of that project
(the Git Review mod opened this terminal there). Work through the stages below in order. Keep the
person informed with one short line per stage.

## Hard rules

- **Read-only towards GitLab.** Never push, approve, merge, close, or change the MR. The only thing you
  may post is one summary comment, and only after the person says yes in stage 6.
- **Never delete anything without asking.** This covers the worktree, its branch and any Docker
  container or image you did not start yourself.
- **Never commit** in the worktree. It is for reading, building and scanning only.
- **Stop at the conflict gate.** If the MR has conflicts, stop after stage 1.
- **Never print a secret in full.** Anywhere: terminal, report, status file or MR comment. Show only
  its first 4 characters followed by `…`, as the files-and-secrets agent reports them.
- **Report missing pieces; don't stop for them.** A missing tool or token (glab, Docker, a Sonar login)
  is a finding to report. Continue with the other stages.

## Setup

Parse the URL. Work out these values:

- `PROJECT`: everything between `gitlab.com/` and `/-/merge_requests`.
- `ENC`: `PROJECT` URL-encoded, with `/` written as `%2F`.
- `IID`: the number at the end of the URL.
- `ALLOWED`: the text after `--allowed`; empty if there is none.

The status file lets the Git Review dialog show progress: `~/.claude/git-review/status/<PROJECT with / replaced by __>__<IID>.json`.
At each stage, write it with Bash:

```bash
mkdir -p ~/.claude/git-review/status
printf '{"stage":"%s","verdict":"%s","report":"%s","at":"%s"}' "<stage>" "<verdict or empty>" "<report path or empty>" "$(date -u +%FT%TZ)" > "$STATUS_FILE"
```

To notify the person (used in stages 1 and 5):

```bash
osascript -e 'display notification "<text>" with title "Git Review"' 2>/dev/null || true
```

## 1. Conflict gate

```bash
glab api "projects/$ENC/merge_requests/$IID"
```

Note these fields: `title`, `author.username`, `source_branch`, `target_branch`, `sha`, `diff_refs`,
`draft`, `state`, `has_conflicts`, `detailed_merge_status`, `web_url`, `project_id`.

- If `state` is not `opened`, say so and ask whether to continue.
- If `has_conflicts` is true or `detailed_merge_status` is `conflict`:
  1. Write the status with verdict `Blocked: conflicts`.
  2. Notify the person: "<PROJECT> !<IID> has merge conflicts; review stopped".
  3. List the conflicting files if `glab api "projects/$ENC/merge_requests/$IID/changes"` shows them.
  4. **Stop here.**

Write the status with stage `conflicts checked`.

## 2. Fetch the MR into a worktree

Check that the current folder's `origin` remote points at `PROJECT`. If it doesn't, tell the person
and stop.

```bash
REPO="$(git rev-parse --show-toplevel)"
WT="$(dirname "$REPO")/.mr-worktrees/$(basename "$REPO")-mr-$IID"
git fetch origin "+refs/merge-requests/$IID/head:review/mr-$IID" "+refs/heads/<target_branch>:refs/remotes/origin/<target_branch>"
if [ -d "$WT" ]; then git -C "$WT" checkout --detach && git -C "$WT" checkout "review/mr-$IID"; else mkdir -p "$(dirname "$WT")" && git worktree add "$WT" "review/mr-$IID"; fi
git -C "$WT" log --oneline -1
```

The worktree's HEAD must match the MR's `sha`. If it doesn't, say so: the MR moved since stage 1.

Collect the change list for the later stages:

```bash
git -C "$WT" diff --stat "origin/<target_branch>...HEAD"
git -C "$WT" diff --name-only "origin/<target_branch>...HEAD"
```

Write the status with stage `worktree ready`.

## 3. In parallel: code review, pipelines, Sonar, and files and secrets

Start **all four agents in one message**, so they run at the same time. Give each one:
`PROJECT`, `ENC`, `IID`, the project id, the MR web URL, `WT`, the source and target branches,
the MR head `sha`, and the changed-file list.

- **A. Code review:** agent `git-review:mr-code-review`. It finds and runs the review skills or
  agents that ship with this project.
- **B. Pipelines and scans:** agent `git-review:mr-pipelines`. It waits until every pipeline of the MR
  has finished (it polls every 60 s, for up to 90 min). Then it reads the job results and the
  security scan reports.
- **C. Sonar:** agent `git-review:mr-sonar`. If the project is bound to SonarCloud, it fetches the MR's
  results from there. If it isn't, it runs a local Docker scan.
- **D. Files and secrets:** agent `git-review:mr-files-secrets`. Also give it `ALLOWED`. It checks
  every commit of the MR, not only the final diff. It runs gitleaks with the target branch's rules and
  looks for sensitive files, build output, local clutter, oversized files and suspicious files.

Write the status with stage `reviewing`. Each agent returns a findings section in Markdown.

If agent A answers `NO_REVIEW_KIT`, ask the person with AskUserQuestion:

- **Run a generic review:** use Claude Code's `code-review` skill on the worktree's diff against
  `origin/<target_branch>`. If that skill isn't available, run a general-purpose agent that reviews
  the diff for bugs, security problems and missing tests.
- **Skip the code review.**

Either way, the report says: "No review skills or agents found in <PROJECT>".

## 4. Report

Combine everything into one Markdown report at
`~/.claude/git-review/reports/<PROJECT with / replaced by __>-mr-<IID>-<YYYYMMDD-HHMM>.md`, with these
sections:

1. **Summary:** the MR title, author, branches and head sha, plus a verdict:
   - **Approve:** nothing blocking.
   - **Changes needed:** any of these:
     - at least one high-severity finding;
     - a failed pipeline or a failed quality gate;
     - a security issue of high severity or worse;
     - D ended with `FILES_SECRETS: changes needed` (a secret, a sensitive file or build output).
   - **Blocked:** conflicts, or the pipelines did not finish within 90 min.

   If D found secrets, the first line under the verdict is `🔑 <n> secret(s) found - rotate them`.
   Warnings and Suspicious items from D never change the verdict.
2. **Files and secrets:** from D. Then merge in B's secret-detection findings:
   - a finding at the same `file:line` as one of D's is shown once, tagged "also found by CI";
   - a finding only B has is added under Secrets, tagged "found by CI only".

   Show B's values with the first 4 characters only, like D's. Keep the secret-detection findings in
   the Pipelines section too, but as counts only.
3. **Pipelines and scans:** from B.
4. **Sonar:** from C. Say whether the results came from SonarCloud or a local scan.
5. **Code review:** from A, or from the fallback review.
6. **Not checked:** anything skipped, and why. This includes D's Not checked, such as gitleaks not being installed.

Print the summary and the top findings in the terminal. Give the full report's path.

## 5. Tell the person

Write the status with verdict `<verdict>` and the report path. Notify the person:
"<PROJECT> !<IID>: <verdict>".

## 6. Optional: post the summary

Ask with AskUserQuestion whether to post the summary to the MR as one comment. Default to **don't post**.
The comment includes the Files and secrets findings, with each secret shown by its first 4 characters
only. Before posting, check the comment for any longer secret value.
Only if the person says yes:

```bash
glab api -X POST "projects/$ENC/merge_requests/$IID/notes" -F "body=@<summary file>"
```

## 7. Worktree

Ask with AskUserQuestion:

- **Delete the worktree:** run `git worktree remove "$WT"` and `git branch -D "review/mr-$IID"`.
  If the removal is refused because of build output, ask again before adding `--force`.
- **Keep it:** say where it is. Opening this MR again from Git Review reuses it.

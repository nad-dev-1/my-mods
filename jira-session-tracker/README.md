# Jira Session Tracker

A Claude Code mod for your own Jira hygiene. It follows every Claude Code session on your machine, works out how long you actually spent (idle gaps removed, parallel sessions shared so a day never adds up to more than the time that passed), and helps you link that work to Jira tickets, create missing tickets, log time and move statuses.

**Nothing is written to Jira, and no branch is renamed, until you confirm it on a preview screen.**

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install jira-session-tracker@my-mods --scope user
```

Or, at the prompt of a terminal session: `/plugin install jira-session-tracker --marketplace nad-dev-1/my-mods`. Full guide: [docs/jira-session-tracker.md](../docs/jira-session-tracker.md).

## Use

- **◷ Jira** in the status bar, or `/jira`, opens the pane beside the chat: **Log work** (by week and day), **Tickets** (your open tickets by parent story), **New ticket**, **Dashboard**. Keys `1`–`4` switch tabs, `r` refreshes, `c` runs the check, Esc goes back or closes.
- `/jira-log`, `/jira-link [KEY]`, `/jira-new` act on the current session.
- `/jira-check` lists loose ends: uncommitted or unpushed work, pushed branches with no merge request, work with no ticket, unlogged time, statuses that look behind.
- `/jira-wrapup` (end of day), `/jira-standup` (yesterday / today / blockers), and a weekly timesheet you can copy or save as CSV or Markdown.
- `/jira-setup` sets projects, repo mapping, summary prefix, branch pattern, working hours, days off.

## Needs

- The Atlassian connection in Claude Code (`/mcp` shows "claude.ai Atlassian MCP"). The mod has no Jira credentials of its own.
- `git` and `python3` on the machine. `glab` or `gh` is used, when present, to see whether a branch has a merge request.

## Data

Everything stays on your machine: settings, links and the write log in the mod's store, snapshots and exports under `~/.claude/jira-session-tracker/`. The Jira connection cannot delete a worklog, so **Remove** sets it to 0m; delete it fully from Jira if you prefer.

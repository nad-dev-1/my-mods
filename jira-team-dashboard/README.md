# Jira Team Dashboard

A Claude Code mod for the team lead. It reads what the team logged and moved in Jira each day and turns it into a dashboard pane you can refresh, browse by day or date range, and filter by team, developer and project.

**Read-only: it never changes anyone's tickets.** Data comes from Jira only, through your Atlassian connection; team members' own trackers are never read.

## Use

- **▦ Team** in the status bar, or `/team`, opens the pane.
- `/team-refresh` pulls today from Jira and saves a snapshot. A snapshot is also taken by itself at the end of the working day.
- `/team-report [date | from..to | week | month] [team | developer]` opens the pane with those filters, e.g. `/team-report week iOS`.
- `/team-digest` writes a one-page weekly summary for management, as Markdown.
- `/team-setup` (or ⚙ in the pane): members and their teams, projects, hours, working days, Flutter work, and the leave calendar.

The pane shows summary cards, who is on what right now, each developer's logged vs expected hours with their tickets and moves, hours by project and story with story progress, the split between native and Flutter work, what needs attention (logging gaps, stuck tickets, work with no time, estimate vs actual, sprint hygiene, bounce-backs), the day's activity timeline, and trends over a range. Export CSV or Markdown of the current view, and draft a polite reminder for someone who has not logged time: the mod never sends anything itself.

## Needs

The Atlassian connection in Claude Code (`/mcp`). The team list, settings and daily snapshots stay on your machine under `~/.claude/jira-team-dashboard/`.

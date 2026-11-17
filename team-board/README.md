# Team Board

Capture ideas and tasks, assign them to your team, see who is working on what, prioritise, keep notes, and produce executive reports. A private **dashboard artifact** on claude.ai holds the data, and **Claude Code commands** let you capture and update work from any session.

- **The dashboard** has Team, Kanban, List and Ideas views, a detail drawer, filters, drag-to-reorder, reports (exported as PDF, Markdown or CSV) and Settings.
- **The commands** are `/idea`, `/task`, `/task from-session`, `/assign`, `/board-status`, `/eta`, `/note`, `/link`, `/board-review`, `/board`, `/board refresh`, `/board-report` and `/board-setup`. Each one shows a preview, and nothing is written until you confirm.
- **Read-only toward Jira.** The board links tickets and shows their live status, but never creates, moves or comments on anything in Jira.
- **Stays out of your way:** a status line such as `📋 2 overdue · 1 blocked`, plus a once-a-day toast when items newly become overdue or stale.

Setup: install the mod, then run `/board-setup` (it can publish the dashboard for you). The full guide is in [`docs/team-board.md`](../docs/team-board.md).

Data lives only in your private artifact's database, plus a local cache under `~/.team-board/`. Team Board reads nothing from other mods, and they read nothing from it.

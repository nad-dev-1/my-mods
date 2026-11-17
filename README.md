# my-mods

Claude Code mods: plugins with a hooks module that change what Claude Code does and draw their own UI. One folder per mod; each folder is a complete plugin. Shared as-is.

| Mod | What it does |
| --- | --- |
| [`ai-employee-kit/`](ai-employee-kit/) | Clean View hides the technical details behind a simple checklist above the prompt; Agent Dock splits each request across a team of helper agents and shows them working live. [User guide](docs/ai-employee-kit.md) |
| [`prompt-upgrade/`](prompt-upgrade/) | Turns a rough prompt into a clear one in a side pane, with up to three quick questions, before anything is sent. [User guide](docs/prompt-upgrade.md) |
| [`work-report/`](work-report/) | A pane that shows the tasks Claude finished for you, the hours that likely saved, and what that time is worth. [User guide](docs/work-report.md) |
| [`mod-manager/`](mod-manager/) | List every installed plugin/mod with its status and turn each one on or off, from /mods or a panel [User guide](docs/mod-manager.md) |
| [`cache-handoff/`](cache-handoff/) | A Cache Clock card above the prompt (the hour the prompt cache stays warm, an always-visible Auto-warm switch with invisible pings, dollar estimates, a cold-send guard) and a Handoff: a Refresh banner past 250k or on a cold cache, a five-step progress card, and a ready card that starts a new chat from the saved handoff [User guide](docs/cache-handoff.md) |
| [`chat-inventory/`](chat-inventory/) | A side pane, In this chat, with live cards for the to-do list, the connectors and command-line tools called, the context files read, the skills, the subagents and the web pages this chat used; opened from the status bar or /inventory [User guide](docs/chat-inventory.md) |
| [`replay-button/`](replay-button/) | A Replay button in the status bar that opens Replay Theater's step-through of the last turn's file edits [User guide](docs/replay-button.md) |
| [`filetree-button/`](filetree-button/) | A Files button in the status bar that shows or hides the filetree mod's file tree [User guide](docs/filetree-button.md) |
| [`inject-prompt/`](inject-prompt/) | An Inject button in the status bar that opens your saved prompts, grouped by category and filterable by tag or search, and inserts the ones you pick at the cursor [User guide](docs/inject-prompt.md) |
| [`git-review/`](git-review/) | A Git Review button that lists your GitLab merge requests by project and starts a full review of one in a new terminal: conflicts, worktree, pipelines and scans, Sonar, and the project's own code review [User guide](docs/git-review.md) |
| [`employee-control-panel/`](employee-control-panel/) | A Control Tools button in the status bar that opens a panel to switch the model and effort level for Claude and its subagents, with a live status line [User guide](docs/employee-control-panel.md) |
| [`jira-session-tracker/`](jira-session-tracker/) | A ◷ Jira button and side pane that follow every Claude Code session on your machine, group unlinked work by folder, and link it to Jira tickets, create tickets, log time and move statuses, writing to Jira only after you confirm a preview. [User guide](docs/jira-session-tracker.md) |
| [`jira-team-dashboard/`](jira-team-dashboard/) | A ▦ Team button and pane for the team lead: what the team logged and moved in Jira each day, by team, developer, project and story, with gaps, stuck tickets, a Flutter split, trends, exports and a weekly digest; read-only. [User guide](docs/jira-team-dashboard.md) |
| [`team-board/`](team-board/) | Team Board: ideas and tasks for your team in a private dashboard artifact plus commands (`/idea`, `/task`, `/assign`, `/board`, `/board-report`…): who is on what, priorities, ETAs, notes, read-only Jira status and executive reports. [User guide](docs/team-board.md) |

## Guides

A user guide for each mod: what it shows, every button, command and setting, where it keeps its data, and its limits.

- [AI Employee Kit](docs/ai-employee-kit.md)
- [Prompt Upgrade](docs/prompt-upgrade.md)
- [Work Report](docs/work-report.md)
- [Mods (mod manager)](docs/mod-manager.md)
- [Cache Clock & Handoff](docs/cache-handoff.md)
- [Chat Inventory](docs/chat-inventory.md)
- [Replay button](docs/replay-button.md)
- [Files button](docs/filetree-button.md)
- [Inject Prompt](docs/inject-prompt.md)
- [Git Review](docs/git-review.md)
- [Employee Control Panel](docs/employee-control-panel.md)
- [Jira Session Tracker](docs/jira-session-tracker.md)
- [Jira Team Dashboard](docs/jira-team-dashboard.md)
- [Team Board](docs/team-board.md)

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install inject-prompt@my-mods --scope user
```

Or try one for a single session from a clone: `claude --plugin-dir ./inject-prompt`.

Each mod has a `tests/` folder; run `claude plugin test <mod>` to run them.

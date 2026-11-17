# Team Board: user guide

Team Board tracks a team's ideas and tasks:
- who is working on what right now
- planned and actual dates, with ETA slips
- an optional senior review
- priorities and a personal queue per person
- a notes timeline on every item
- linked Jira tickets with their live status
- executive reports for the team, a team group, a project or one person

It has two parts that share one database:

| Part | What it is |
| --- | --- |
| **The dashboard** | A private artifact on claude.ai. Everything can be done here. |
| **The mod** | Commands in any Claude Code session, plus a status line and a daily reminder. |

**Read-only toward Jira.** Team Board never creates, transitions, comments on or links back to anything in Jira. It only reads a ticket's status to show it next to your work.

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install team-board@my-mods --scope user`, then run `/board-setup`. The code is in [`team-board/`](../team-board/).

---

## Contents

- [Setup](#setup)
- [Ideas and tasks](#ideas-and-tasks)
- [The dashboard](#the-dashboard)
- [Commands](#commands)
- [Dates, flags and rules](#dates-flags-and-rules)
- [Jira](#jira)
- [Reports](#reports)
- [Settings](#settings)
- [Your data](#your-data)
- [Good to know](#good-to-know)

## Setup

1. Run `/board-setup` in Claude Code.
   - If you already have a Team Board link, paste it, e.g. `/board-setup https://claude.ai/artifact/…`.
   - If not, Claude publishes the dashboard for you as a private artifact.
2. Claude then asks you about the roster, the projects and the thresholds, one question at a time, each with a recommended answer. It writes them once you confirm.
3. Open the dashboard link. You can change all of this later in **Settings**.

The dashboard also works on its own. On an empty board it shows **Create settings**; after that, add people and projects in Settings.

## Ideas and tasks

| | Idea | Task |
| --- | --- | --- |
| ID | `I-0001` | `T-0001` |
| Stages | new → discussing → approved → converted, plus parked and rejected | backlog → assigned → in progress → in review → done, plus cancelled |
| People | one owner | one assignee plus collaborators; the full assignment history is kept |
| Dates | — | ETA (the first ETA is kept as the original), started, review requested, ended |
| Review | — | optional: a senior reviewer, the review date and a note; it never blocks the task |
| Jira | optional reference keys | any number of keys or issue links |

- **Every item has** a title (up to 120 characters), a description, a project (required), a priority (Critical, High, Medium or Low) and a notes timeline.
- **Stages are always set by hand.** Nothing moves an item for you, Jira included.
- **"In review" is optional:** a task can go straight from in progress to done.
- **Blocked is a flag, not a stage:** an open *blocker* note marks the item Blocked, and it keeps its real stage.
- **Convert to tasks** turns an approved idea (or a discussing one, after a confirm) into one or more tasks. They take the idea's project, priority and description, link back to it, and the idea moves to Converted.
- **Archive instead of delete.** Archived items are hidden unless you tick **Show archived**. Only an archived item can be deleted permanently.

## The dashboard

**Header buttons:** + New idea · + New task · Refresh Jira (shows when Jira was last read) · Reports · Settings.

**Filters** (remembered in your browser): project, team, member, type, priority, status, the flags (overdue, slipped, stale, blocked, needs closing), show archived, and a text search over title, ID and Jira keys. Every view follows them.

| View | Shows | Dragging |
| --- | --- | --- |
| **Team** (start view) | A column per active person with **Ongoing** (in progress and in review, with a WIP warning), **Up next** (their queue) and **Done, last 14 days**, plus an **Unassigned** column. | To another column: reassign (you confirm). Within Up next: reorder that person's queue. Into Ongoing or Done: change the stage. |
| **Kanban** | Tasks by stage. Choose "Ideas" in the type filter to see ideas by stage instead. | To another column: change the stage, with the date rules. Within a column: reorder. |
| **List** | A sortable table. Tick rows for bulk actions: reassign, set priority, set project, set status, archive. Shows 200 rows at a time. | Reorder rows when no column sort is active. |
| **Ideas** | Ideas grouped by priority, each with its stage, owner and **Convert to tasks**. | Reorder, or drop into another priority group. |

- **Order:** a priority level comes first, then your manual order within it. Reordering writes one document.
- **Cards show:** ID, priority, project, people, ETA (red when overdue, plus a "+3d" badge when it slipped), flags and Jira chips.
- **On a phone,** where dragging is awkward, the drawer has the same actions: stage, assignee and **Move to top of queue**.

**The drawer** (click any item) holds:
- every field, editable
- Jira tickets with summary, status, Jira assignee, priority and when each was fetched; add or remove keys here
- flags, assignment history and ETA history
- the review fields (the reviewer list shows only active seniors, never the assignee)
- links to the source idea or the converted tasks
- notes and activity, with a **Notes only / Everything** toggle; add a note with an optional tag (update, decision, blocker, review), edit it, or resolve a blocker
- Archive, Restore and Delete permanently

## Commands

Every command takes plain language. Claude reads it, shows a **preview**, and writes nothing until you say yes; the write also goes through Claude Code's normal approval. You can refer to an item by its ID or by part of its title; if more than one could match, Claude asks.

| Command | Does | Example |
| --- | --- | --- |
| `/idea <text>` | Capture an idea | `/idea project Atlas, owner Sam, high: offline plan cache` |
| `/task <text>` | Capture a task | `/task Ada, high, ETA Fri, project Atlas: fix APN retry crash` |
| `/task from-session` | Claude proposes one task (or idea) from the current conversation | |
| `/assign <item> <member>` | Assign or reassign (history kept; "none" unassigns) | `/assign T-0012 Ben` |
| `/board-status <item> <stage>` | Change the stage (the date rules apply) | `/board-status APN retry in_review` |
| `/eta <item> <date>` | Set or change an ETA | `/eta T-0012 next Monday` |
| `/note <item> [tag] <text>` | Add a note: `blocker`, `decision`, `update` or `review` | `/note T-0012 blocker waiting on the carrier list` |
| `/link <item> <key or URL…>` | Link Jira tickets (read-only) | `/link T-0012 APP-123 APP-124` |
| `/board-review <item> <senior> [note]` | Record a senior's review | `/board-review T-0012 Sam looks good` |
| `/board` | Who is on what, what needs attention, and the dashboard link | |
| `/board refresh` | Re-read every linked Jira ticket | |
| `/board-report <scope> <period>` | An executive report. Claude drafts the summary; you can edit it before it's saved | `/board-report iOS last_week` |
| `/board-setup` | Connect the board, then go through the roster, projects and thresholds | |

`/board-status` and `/board-review` carry the `board-` prefix because Claude Code already has `/status` and `/review`.

**In the background:**
- **Status line:** e.g. `📋 2 overdue · 1 blocked`, hidden when there's nothing to show.
- **Daily toast:** once a day at session start, when items have newly become overdue or stale since the last one.

## Dates, flags and rules

**Dates set automatically** (all date-only, in Asia/Beirut unless you change the time zone). You can edit any of them afterwards; a hand-edited date is marked "edited".

| When | Then |
| --- | --- |
| Assignee set or changed | The previous assignment is closed and a new one opened in the history |
| → in progress, with no start date yet | Started = today (only the first time) |
| → in review | Review requested = today |
| Reviewer set | Reviewed on = today, if empty |
| → done or cancelled | Ended = today |
| Reopened from done or cancelled | Ended is cleared, and the history says so |
| First ETA | Original ETA = current ETA = that date |
| ETA changed | The current ETA changes; the original stays; the change is added to the ETA history |

Each change is also logged in the item's activity feed.

**Flags** are worked out on the fly, never stored:

| Flag | When |
| --- | --- |
| Overdue | The ETA has passed and the task is not done or cancelled |
| Slipped | The current ETA is later than the original (shown in days) |
| Stale | In progress with no activity for more than 5 days |
| Blocked | At least one unresolved blocker note |
| Needs closing | Every linked Jira ticket is done but the task is still open. A hint only; it changes nothing |
| Jira assignee differs | Jira shows someone other than the local assignee. A hint only |
| WIP warning | A person has more than 3 items in progress or in review |

## Jira

- **Linking:** add a key (`APP-123`) or an issue link; links are turned into keys. The ticket is checked on the spot.
  - A key that can't be read is kept, with an error badge.
  - A key from a project not in your settings gets a soft warning.
- **Refresh:** only when you ask, through **Refresh Jira** in the dashboard or `/board refresh`. It reads every key on non-archived items, ten at a time. The header shows when that last happened, and each chip shows its own age.
- **What Jira changes:** only the chips, the "needs closing" hint and the assignee hint. Never a stage, date, priority, assignee or note. A Jira status change is noted in the item's activity.
- **When access is lost or Jira isn't connected:** Refresh is disabled with the reason shown, and the cached chips stay visible with their age.

## Reports

**Inputs:**
- **Scope:** the whole team, a team group (e.g. iOS), a project or one person.
- **Period:** this week, last week, this month, last month or a custom range.

**Sections** (empty ones are left out):

| Section | Contains |
| --- | --- |
| Executive summary | 3 to 5 sentences drafted by Claude from the numbers below only; edit them as you like |
| Headline numbers | Delivered, in progress, overdue, on-time rate (done on or before the original ETA), average cycle time (started → ended), total slip days |
| Delivered | Done in the period, grouped by priority, with Jira keys |
| Risks | Overdue, slipped, stale and blocked items, with the blocker notes |
| Decisions | Decision notes made in the period |
| Workload | Per person: ongoing, done, overdue, reviewed; a one-person report also lists their items |
| Ideas pipeline | Ideas created, approved, converted and rejected in the period |
| Coming up | ETAs due in the next 14 days |

- **Exports:** in the dashboard, as PDF, Markdown or CSV (the raw rows). `/board-report` also saves the Markdown and CSV under `~/.team-board/reports/`.
- **History:** every generated report is saved, and **Reports → History** reopens any of them.
- **Same numbers everywhere:** the dashboard and `/board-report` run the same formulas, from the same file.

## Settings

| Setting | Default |
| --- | --- |
| Team: name, email, Jira account id, teams, senior, active | — (inactive people leave the pickers but keep their history; someone with no history can be deleted) |
| Projects: name, Jira project keys, default team | — (a project no item uses can be deleted) |
| Stale after | 5 days |
| WIP warning above | 3 ongoing items |
| Recently done window | 14 days |
| Time zone | Asia/Beirut |
| Report defaults | whole team, this week |

When someone is made inactive while they still have open tasks, a banner offers **Reassign all**.

## Your data

- **The board's database lives in your private artifact.** Only you can change it; anyone you share the link with can only read.
- **Collections:**
  - `config/settings` and `config/counters`
  - `members/<id>` and `projects/<id>`
  - `items/<id>` for ideas and tasks
  - `events/<id>` for notes and activity
  - `jira/<key>` for the Jira cache
  - `reports/<id>` for saved reports
- **Locally,** in `~/.team-board/`:
  - `config.json`: the board link and the daily-toast state
  - `cache/`: the copy Claude last read, which the commands, the status line and the toast work from
  - `reports/`: what `/board-report` saved

Team Board is separate from every other mod: its own roster, projects and storage. It reads nothing of theirs, and they read nothing of its.

## Good to know

- **Claude Code reads and writes the board through Claude.** A mod can't reach an artifact's database by itself, so Claude does it with the ArtifactData tool. The mod supplies the rules: IDs, date rules, history and report numbers come from the same file the dashboard runs.
- **The status line and toast are as fresh as the last time Claude read the board.** Any command, or `/board`, refreshes them.
- **Last write wins** when the dashboard and a command change the same item at once. The command side carries the version it read, so it refuses rather than overwrite a newer edit; Claude then reads again and redoes it.
- **Notes live in one `events` collection** (with the item's ID on each) rather than under every item, so the whole board's notes load in one read.

# Jira Session Tracker: user guide

A personal Claude Code mod that follows every Claude Code session on your machine, works out how much time you really spent, and helps you keep Jira in step: link the work to tickets, create missing tickets, log time and move statuses.

**Nothing is written to Jira, and no git branch is renamed, until you confirm it on a preview screen.**

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install jira-session-tracker@my-mods --scope user`. The code is in [`jira-session-tracker/`](../jira-session-tracker/).

---

## Contents

- [What you need](#what-you-need)
- [First run](#first-run)
- [Opening the pane](#opening-the-pane)
- [The pane at a glance](#the-pane-at-a-glance)
- [Log work tab](#log-work-tab)
- [Linking work to a ticket](#linking-work-to-a-ticket)
- [Creating a ticket](#creating-a-ticket)
- [Splitting a session](#splitting-a-session)
- [Ignoring a session](#ignoring-a-session)
- [Logging time: the preview](#logging-time-the-preview)
- [Tickets tab](#tickets-tab)
- [Dashboard tab](#dashboard-tab)
- [Tools menu (⚙)](#tools-menu-)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Notifications](#notifications)
- [How time is counted](#how-time-is-counted)
- [Rules for what goes to Jira](#rules-for-what-goes-to-jira)
- [Your data](#your-data)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| The **Atlassian connection** in Claude Code (`/mcp` lists it) | Every Jira read and write goes through it. The mod holds no Jira credentials of its own. |
| `git` | Branches, commits, push state and uncommitted changes. |
| `python3` | Reads Claude Code's local session transcripts quickly. |
| `glab` or `gh` (optional) | Lets **Check** tell whether a pushed branch already has a merge request. |

## First run

1. Open the pane (click **◷ Jira** in the status bar, or type `/jira`).
2. The pane says **⚠ Set your projects and hours first.** Press **Set up** (or open **⚙ → Settings** later; **Later** hides the reminder).
3. Fill in:
   - **Projects to track**: Jira project keys, e.g. `PROJ, MOBILE`.
   - **Hours per day**, **working days**, **end of day** (for the reminder).
   - **Idle after (min)**: gaps longer than this are not counted (default 15).
   - **Refresh every (min)**: how often the pane refreshes itself (default 5).
   - **Warn when unlinked passes (min)**: a toast once a day when this much of today's work has no ticket (default 120).
   - **Days off**: dates like `2026-12-24, 2026-12-25`, or the **Today is a day off** switch.
   - **Count headless runs**: include `claude -p` runs that had no typed prompt (off by default).
4. For each project:
   - **Repos / folders**: repo names or paths that belong to it, `*` allowed (`my-ios-app`, `selfcare-*`).
   - **Summary prefix**: put in front of every new ticket title, e.g. `[iOS]-`.
   - **Branch pattern**: e.g. `feature/{KEY}-{slug}`.
   - **Default issue type**, a **Ticket template**, and **Uses estimates** (shows the remaining estimate in previews).
5. Press **Save**. The Jira site is found through your Atlassian connection.

Press **Enter** in a field to keep what you typed.

## Opening the pane

- **◷ Jira** in the status bar opens the pane, or closes it when it is open. The number on it (`◷ Jira 4`) is how much work is still waiting: not linked, or linked but not logged.
- `/jira` opens it too.
- The pane sits beside the chat and refreshes itself.

## The pane at a glance

```
 Log work 44 · 34h  Tickets 4  New  Dashboard        ⚙  ⟳
 ─────────────────────────────────────────────────────────
 Linked to PROJ-1064.                       Updated 12:17

 ▾ This week · Nov 16            2h / 40h · 2h 5m to log
   Mon 2/8 · Tue 0/8 · Wed – · …
   Send & close week (1)
   Ready to log · 1 · 30m
   Mon Nov 16                              Send the day (1)
     PROJ-1064 30m Permissions needed for speedtest
       Log · Change ticket
   No ticket · 3 · 2h 5m                 Fold all · Open all
   ▾ my-ios-app   ~/code                         2 · 1h 55m
       Link all 2 · One ticket · Ignore all
       Nov 16 1h 30m fixing-deeplink  Deeplink handling review
         Link · Create · Split · Ignore
   ▸ reports      ~/Documents                       1 · 10m
   ▸ Ignored (4 · 1h 12m)
 ▸ Week of Nov 9                2h / 40h · 32h 14m to log
```

- **Top bar**: the four tabs (keys `1`–`4`), **⚙** for tools (key `t`) and **⟳** to refresh (key `r`).
- **Status line**: what just happened, and when the data was last read.
- Warnings (a Jira error, changes waiting to retry, setup not done) appear under the status line with what to press.

## Log work tab

The main view, organised by **week**. This week is open; older weeks start folded. Click a week's header to open or fold it. A week stays listed until you close it, so older unlogged work never slips away.

Each open week shows:

| Part | What it is |
| --- | --- |
| **Header** | `logged / working hours · still to log` for the week. |
| **Day strip** | One line, `Mon 2/8 · Tue 0/8 · …`: hours logged in Jira out of the day's target. Days off show `–`. |
| **Close week** | Becomes **Send & close week (N)** when there is linked work: a preview to log all of it, then the week is marked closed. |
| **Ready to log** | Work already linked to a ticket, under the days that have some. Each day has **Send the day (N)**; each row has **Log** and **Change ticket**. |
| **No ticket** | Work with no ticket, grouped by the **folder** the session ran in (a repo's sub-folder joins its repo's top folder). |
| **Ignored** | Work you closed without a ticket, folded; open it to **Restore**. |

### Folder groups (No ticket)

- A folded group is one line: folder name, its parent path, and `sessions · time`.
- Click the header to open or fold it; **Fold all** / **Open all** do every group of the week. Your folds are remembered.
- An open group with several sessions offers:
  - **Link all N**: link every session of the group to one ticket.
  - **One ticket**: create one ticket for the whole group.
  - **Ignore all**: close the whole group without a ticket.
- Each session shows its date, time, **branch** and a short label, then:
  - **Use KEY** (when this branch was linked to a ticket before),
  - **Link**, **Create**, **Split**, **Ignore**.

## Linking work to a ticket

**Link** (or **Link all N** for a group) opens a picker:

1. **Suggested** tickets, ranked:
   1. a ticket key found in the branch name, commit messages or your requests;
   2. a ticket this branch was linked to before;
   3. your tickets in progress;
   4. tasks under the story the work matches;
   5. tickets you touched recently;
   6. tickets with similar words.
2. A **search** box: type a key (`PROJ-12`) or words.
3. All your open tickets, grouped by parent story.

Picking a ticket links the work right away. A link is a note on your machine, not a Jira change. The branch is remembered, so later sessions on it get that ticket offered as **Use KEY**.

If the work looks like several pieces (commits that name different tickets or branches), the picker offers **Split it first**.

## Creating a ticket

**Create** (or **One ticket** for a group, or the **New** tab) opens a form:

| Field | Notes |
| --- | --- |
| Project | Guessed from the repo; change it with the picker. |
| Issue type | The project's own types. |
| Parent story / epic | Ranked against the work; ★ marks the best match. You can also type a parent key. |
| Summary | Starts with the project's prefix. **Suggest summary** writes a short, plain title from the work. |
| Description | Brief; starts from the project's template. |
| Labels | Comma separated. |
| Assignee | Me or Unassigned. |
| Rename branch | Offered when the branch does not follow the project's pattern, and only when every session covered is on one branch. |

**Preview** shows exactly what will happen: the ticket to create, the link, and the branch rename (locally, and on `origin` when the branch was pushed). After you confirm, a second preview asks for the **time and status** of the new ticket, since Jira only lists a ticket's moves once it exists.

## Splitting a session

**Split** looks at the session's commits, files and requests and proposes separate pieces of work when it covered more than one. For each part you can set:

- what it was (a short label),
- its share of the time (**−** / **+** in 5% steps),
- a ticket key (or leave empty and decide later),
- a branch.

**Merge with previous**, **Add part**, **Un-split** and **Analyse again** adjust the proposal; **Save** keeps it. Each part then shows as its own row and goes through link, create and log on its own.

## Ignoring a session

Some work needs no ticket. **Ignore** on a session (or **Ignore all** on a group) closes it:

- it leaves every list and every count: the tab number, the status-bar number, the to-log totals, Check, and the reminders;
- nothing is sent to Jira;
- **▸ Ignored (N · time)** under the week lists it again, with **Restore** and **Restore all**.

## Logging time: the preview

**Log**, **Send the day**, **Send & close week** and the follow-up after a new ticket all open one **Review before sending** screen. Every row has a checkbox; **Select all**, **Select none**, **Back**, and **Confirm and send (N)**.

### Time options

Each worklog row offers:

| Option | Based on |
| --- | --- |
| **A** | Session time: when the session started, its active time (idle gaps out, parallel sessions shared). |
| **B** | Commit time: first to last commit, with a 20-minute lead-in (shown when there are commits). |
| **C ★** | Recommended, picked by default: the size and kind of change (files, lines, debugging, refactor, tests, docs) weighed with the session time. |
| **D** | Custom: type a start (`09:30`) and a duration (`1h 30m`, `90m`, `1.5h`, `1:30`). |

Each option shows its start and duration, rounded to 15 minutes. A **Comment** is optional. When the project uses estimates, the row shows the remaining estimate before and after.

### Status move

Every time, for every ticket: **Keep current status**, or one of the moves the project's workflow allows for that ticket right now. The move you chose last time in that project is marked **used before in PROJ**, but is never picked for you.

### Parent story

When a linked task has no parent story, the preview offers the best matching stories (★ first) and **None**.

### Sending

**Confirm and send** runs everything in order: create, link, parent, rename, worklogs, status moves. If a Jira call fails, that change is kept in a **retry queue**: the pane shows **⚠ N Jira changes waiting to retry** with **Retry now**, and the next refresh retries it. Nothing is lost, and no piece of work is ever logged twice.

## Tickets tab

Your open tickets, grouped by parent story or epic with a count per group (**No parent** last). Chips filter by project (`All 12 · PROJ 8 · MOBILE 4`), and a search box finds any ticket by key or words. Click a ticket to open it in Jira; **Link** beside it links the work you last selected.

## Dashboard tab

Built from a daily snapshot taken at each refresh, so past days stay available.

- **◀ / ▶** move a day; **Today**; **Day / 7 days / 30 days**; **Go to date**.
- Filter by **project** and **repo**.
- Shows sessions, linked vs unlinked time, time logged vs the working day, loose ends, a bar per day, and time per ticket.
- **Weekly timesheet** and **Loose ends** buttons.

## Tools menu (⚙)

| Tool | What it does |
| --- | --- |
| **+ Add time** | Log time by hand: ticket, date, start, duration, comment. Goes through the preview with the status question. |
| **Wrap-up** | Today's sessions together, time recorded vs logged vs the working day, gaps (meetings, reviews), possible double counting, then **Send the day**. |
| **Standup** | Yesterday / Today / Blockers from your sessions and tickets, with **Copy**. |
| **Timesheet** | A week per day per ticket. **Copy CSV**, **Copy Markdown**, **Save CSV**, **Save Markdown**; ◀ ▶ change the week. |
| **Edit logged** | The worklogs written from the pane: **Edit** the time, **Remove**, or **Open** the ticket. Both go through the preview. |
| **Check** | Loose ends for today or the last 7 days: uncommitted changes, commits not pushed, branches pushed with no merge request, work with no ticket, linked work not logged, and tickets whose status looks behind the work. Each has an action: **Copy command**, **Link**, **Create**, **Log / move**. The mod never commits or pushes code itself. |
| **Settings** | The setup screen. |

## Slash commands

| Command | Does |
| --- | --- |
| `/jira` | Open the pane. |
| `/jira-log` | Log work for the current session (asks for a ticket first if it has none). |
| `/jira-link [KEY]` | Link the current session to `KEY`, or open the picker. |
| `/jira-new` | Create a ticket from the current session. |
| `/jira-check` | Run Check. |
| `/jira-wrapup` | End-of-day wrap-up. |
| `/jira-standup` | Standup notes. |
| `/jira-setup` | Setup. |

## Keyboard

| Key | Does |
| --- | --- |
| `1` `2` `3` `4` | Log work, Tickets, New, Dashboard |
| `t` | Tools menu (⚙) |
| `r` | Refresh |
| `b` | Back (on screens that have Back) |
| Tab, arrows, Enter | Move between buttons and press |
| Esc | Back from a screen; closes the pane from the main view |

## Notifications

- **Claude Code's status line**: `⏱ PROJ-1064` for the current session's ticket, or `⏱ no ticket`.
- **Toast** when a session ends with no ticket, and once a day when today's unlinked work passes your threshold.
- **Reminder** at your end of day on working days when 15 minutes or more of today's work is not logged.

## How time is counted

- Every Claude Code session on the machine counts, open or closed, from its local transcript. Subagent runs are not counted separately.
- **Idle time** (gaps longer than your idle setting) is left out.
- **Parallel sessions** share the overlap: when two sessions run at once, each gets half of that stretch, so a day never adds up to more than the time that passed.
- A session that runs past midnight counts towards each day by its activity on that day.
- The pane looks back **35 days**.

## Rules for what goes to Jira

- **Confirm first**: every create, link to a parent, worklog, status move, edit and branch rename waits for **Confirm and send**.
- **Brief text**: titles and descriptions are short and not too specific.
- **No AI mentions**: the summary, description, labels and comments may not mention AI, assistants, tools or "generated" text. The form and the preview flag such words, and sending is blocked until they are removed.
- **Prefix**: each project's summary prefix is applied.
- **No duplicates**: a session, or a part of one, is never logged twice.

## Your data

Everything stays on your machine:

- **The mod's store**: settings, links, branch links, splits, ignored sessions, folds, the log of every write, the retry queue.
- **`~/.claude/jira-session-tracker/`**: daily snapshots, exported timesheets, and a cache of the transcript scan.

Nothing is shared with anyone else, and team reporting tools never read it.

## Limits and good to know

- **Removing a worklog**: the Jira connection cannot delete one, so **Remove** sets it to **0m**. Delete it fully in Jira if you prefer.
- **New tickets take two previews**: the second asks for time and status once the ticket exists.
- **Folder groups** follow the repo's top folder: a session in `my-app/docs` sits under `my-app`.
- **Closing a week** only hides it in the pane; nothing is sent to Jira for work you did not log.
- If the pane shows a Jira error, check `/mcp` that the Atlassian connection is connected. The pane keeps working on your local data meanwhile.

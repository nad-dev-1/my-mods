# Jira Team Dashboard: user guide

A Claude Code mod for the team lead. It reads what the team logged and moved in Jira each day and turns it into a dashboard pane beside the chat: summary cards, who is on what, each developer's hours, project and story progress, the native vs Flutter split, what needs attention, an activity timeline and trends. Browse day by day or over a range, filter by team, developer and project, and export what you see.

**Read-only: it never changes anyone's tickets.** It only searches and reads Jira through your Atlassian connection.

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install jira-team-dashboard@my-mods --scope user`. The code is in [`jira-team-dashboard/`](../jira-team-dashboard/). Developers can track their own sessions with [Jira Session Tracker](jira-session-tracker.md): the cleaner their Jira data, the better these reports.

---

## Contents

- [What you need](#what-you-need)
- [First run: your team](#first-run-your-team)
- [Opening the dashboard](#opening-the-dashboard)
- [The pane at a glance](#the-pane-at-a-glance)
- [Dates, ranges and filters](#dates-ranges-and-filters)
- [Sections](#sections)
- [Snapshots and refreshing](#snapshots-and-refreshing)
- [Exports, reminders and the weekly digest](#exports-reminders-and-the-weekly-digest)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [How the numbers are counted](#how-the-numbers-are-counted)
- [Your data](#your-data)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| The **Atlassian connection** in Claude Code (`/mcp` lists it) | Every read goes through it. The mod holds no Jira credentials of its own. |
| Permission to see your team's issues and worklogs in Jira | The dashboard shows only what your Jira account can read. |

## First run: your team

Open **⚙** in the pane (or `/team-setup`) and add members, one per line or comma separated:

```
Name, email, Team
Ada Lane, ada@example.com, iOS Team
Ben Ray, ben@example.com, Android Team
```

"iOS Team" is stored as the team **iOS**. A person can be in more than one team: tick each team under their name. The **Flutter** team is made of people from the native teams: tick Flutter for those who also work on Flutter.

On the first pull, each member's Jira account is found from their email; the setup screen then shows **✓ in Jira** beside them. Press **Save**.

## Opening the dashboard

- **▦ Team** in the status bar opens the pane, or closes it when it is open.
- `/team` opens it too. When today has no snapshot yet, it pulls today from Jira straight away.

## The pane at a glance

```
 ◀ Tue Nov 10 ▶                                      ⟳  ⚙
 Today · Day · 7 days · 30 days
 Team  All · iOS · Android · Flutter
 Developer [Everyone ▾]   Project [All projects ▾]
 ──────────────────────────────────────────────────────────
 Pulled 1 day at 17:02.                     Snapshot 17:02
 Export CSV · Export Markdown · Weekly digest

 ▾ Summary
   ╭──────────╮ ╭──────────────╮ ╭───────────────╮ ╭────────────────╮
   │ 31.5h    │ │ 12           │ │ 4             │ │ 1              │
   │ Hours    │ │ Tickets moved│ │ Tickets created│ │ Under expected │
   ╰──────────╯ ╰──────────────╯ ╰───────────────╯ ╰────────────────╯
 ▾ Who's on what                                 in progress now
 ▾ Per developer                               logged / expected
   ▸ Ada Lane  ████████░░  7h / 8h · 3 tickets · 4 moves
 ▸ Per project → story
 ▸ Flutter split
 ▾ Attention                                            3 items
 ▸ Activity timeline
```

Every section header folds and unfolds with a click.

## Dates, ranges and filters

| Control | Does |
| --- | --- |
| **◀ / ▶** | Previous / next day (not past today). |
| **Today** | Back to today. |
| **Day · 7 days · 30 days** | One day, or a range ending on the shown day. |
| **Team** | All, or one team. |
| **Developer** | Everyone, or one person (the list follows the team filter). |
| **Project** | All projects, or one. |

Every section follows the filters.

## Sections

| Section | Shows |
| --- | --- |
| **Summary** | Four cards: hours logged, tickets moved, tickets created, members under their expected hours. |
| **Who's on what** | Each member's in-progress tickets right now (up to five each). |
| **Per developer** | One row per person: a bar, hours **logged / expected**, tickets worked on, status moves, and days of leave. Click a row to see each ticket with its time and the moves made; **Draft a reminder** appears for someone with a logging gap. |
| **Per project → story** | Hours by project, then by story. For each story: its tasks by status and the hours spent against the estimate, with a bar. |
| **Flutter split** | For people in both a native team and Flutter: their native time vs their Flutter time. |
| **Attention** | Logging gaps (clearly under expected, or nothing logged; people on leave are left out), stuck tickets (same status for longer than your setting, or in progress with no time logged), work but no time (tickets moved with no worklog by that person), estimate vs actual (more than 1.5× the estimate spent), sprint hygiene (tickets in an active sprint with no assignee, no estimate or no parent story), and bounce-backs (moves back from QA, review or done to work, per person: a gentle quality signal, not a score). |
| **Activity timeline** | Day view only: when things were logged and moved, in time order. |
| **Trends** | Range views only: daily team hours as bars, each person's daily hours as a small spark line, and workload (open tickets and remaining estimate per person). |

## Snapshots and refreshing

The dashboard is built from **daily snapshots** saved on your machine, so past days and ranges open without asking Jira again.

- **⟳** (key `r`) pulls the shown day again. On a range it pulls today and any day of the range not pulled yet.
- **Pull from Jira** appears when days of the range have no snapshot, and pulls them.
- `/team-refresh` pulls today.
- At your **end of day** (18:00 by default), on working days, today is pulled by itself.
- A snapshot holds the day's worklogs, status moves and created tickets, plus the open work as it stood when it was taken (in progress, open tickets with estimates, story progress, sprint hygiene).
- When Jira does not answer, the pane keeps showing the last snapshot and says so.

## Exports, reminders and the weekly digest

| Action | Gives |
| --- | --- |
| **Export CSV** | The current view: one row per developer and ticket, with hours, moves, and logged / expected totals. |
| **Export Markdown** | The current view: summary, per developer, per project and story, attention. |
| **Weekly digest** | One page for management for the week of the shown day: hours per team and person, story progress, key attention items. Missing days are pulled first. |
| **Draft a reminder** | A short, polite message for someone who has not logged their time. |

Each opens in the pane with **Copy**, **Save as …** (to `~/.claude/jira-team-dashboard/exports/`) and **Back**. The mod never sends anything: you copy it and send it yourself.

## Slash commands

| Command | Does |
| --- | --- |
| `/team` | Open the dashboard. |
| `/team-refresh` | Pull today from Jira and save a snapshot. |
| `/team-report [date \| from..to \| today \| yesterday \| week \| month] [team \| developer]` | Open the dashboard with those filters, e.g. `/team-report week iOS`, `/team-report 2026-11-02..2026-11-06 ada`. A developer is matched by email, first name or full name without spaces. |
| `/team-digest` | The weekly digest. |
| `/team-setup` | Members, teams, projects, hours and the leave calendar. |

## Keyboard

| Key | Does |
| --- | --- |
| `h` / `l` | Previous / next day |
| `r` | Refresh (pull) |
| `s` | Setup |
| `b` | Back (from an export, reminder or digest) |
| Tab, arrows, Enter | Move between buttons and press |
| Esc | Back from setup or a text view; closes the pane from the main view |

## Settings

In **⚙ Setup**:

| Setting | Default | Notes |
| --- | --- | --- |
| Members and their teams | none | Add with `Name, email, Team`; tick teams per person; **Remove**. |
| Teams | iOS, Android, Flutter | The names the filter shows. |
| Flutter work is | `flutter` | Project keys or words; a worklog counts as Flutter work when its ticket's project key, summary or labels match. |
| Projects | empty | Jira project keys to include; empty means every project the team works in. |
| Hours per day | 8 | Expected logged hours on a working day. |
| End of day | 18:00 | When today is pulled by itself. |
| Stuck after (days) | 5 | Same status for this long counts as stuck. |
| Working days | Mon–Fri | Days that expect hours. |
| Leave calendar | none | Pick a person, type a day (`YYYY-MM-DD`) or a range (`from..to`); click a day to remove it. Days off never count as logging gaps. |

Press **Save** to keep the changes.

## How the numbers are counted

- **Each person once:** a member in two teams has their hours counted once in every total; the team filter only chooses whose hours are shown.
- **Expected hours:** hours per day on each working day that has a snapshot, minus days of leave and days still ahead. A day not pulled yet expects nothing, so it never shows as a false gap; the pane flags it instead.
- **Logging gap:** logged less than 75% of expected; "nothing logged" when it is zero.
- **Status moves** count when the member made the move during the day; **tickets moved** counts each ticket once.
- **Tickets created** are those created that day with a member as reporter or assignee.

## Your data

Everything stays on your machine, under `~/.claude/jira-team-dashboard/`:

- `team.json`: the members, teams, settings and leave calendar.
- `snapshots/<date>.json`: one per pulled day.
- `exports/`: what you saved from the pane.

Team members' own trackers are never read: the data comes from Jira only.

## Limits and good to know

- **Read-only.** The mod cannot fix anything in Jira; it shows you where to look.
- **Status history** is read from each ticket's newest 100 changes, which covers any normal day.
- **Pulls are per day:** a 30-day range not pulled before takes a while the first time; after that it opens from the snapshots.
- **Sprint hygiene** uses the active sprints of your projects (or of the projects the team's open tickets are in when no projects are set).
- If a member shows **not looked up yet** after a pull, Jira found no issue with that email as assignee or reporter: check the email in Setup.

# Work Report: user guide

A Claude Code mod that shows what Claude has done for you: how many tasks it finished, an estimate of the hours that saved you, and what that time is worth. It opens as a side pane with four tabs: **Today**, **Week**, **Month** and **Year**.

**Hours and dollars are always estimates**, worked out from a fixed number of minutes per kind of task. You can change those numbers.

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install work-report@my-mods --scope user`. The code is in [`work-report/`](../work-report/).

---

## Contents

- [What you need](#what-you-need)
- [Opening it](#opening-it)
- [The pane at a glance](#the-pane-at-a-glance)
- [The tabs](#the-tabs)
- [Tiles](#tiles)
- [Where the time went](#where-the-time-went)
- [Who did the work](#who-did-the-work)
- [The chart and the summary line](#the-chart-and-the-summary-line)
- [What counts as a task](#what-counts-as-a-task)
- [How a task is sorted](#how-a-task-is-sorted)
- [The estimate](#the-estimate)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [Your data](#your-data)
- [Turning it off or hiding it](#turning-it-off-or-hiding-it)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code with mods (plugins with hooks) | The mod is a hooks module. It counts tasks as they finish. |
| The fullscreen layout (`/tui fullscreen`) to click the status-bar button | Status-bar buttons only take clicks there. `/report` works in any layout. |

No accounts, no network, no model calls.

## Opening it

- **Work report** (gold text) in the status bar opens the pane.
- `/report` opens it too. `/report week`, `/report month` and `/report year` open it on that tab; `/report today` on Today.

The pane opens on **Today** the first time.

## The pane at a glance

```
  Today   Week   Month   Year

 LAST 7 DAYS                               Nov 10 – Nov 16, 2026
 ━━━━━━━━━━━──────────────────────────────────────────────────
 ╭──────────────────╮ ╭──────────────────╮ ╭──────────────────╮
 │       3.3        │ │        12        │ │       $163       │
 │HOURS SAVED (EST.)│ │    TASKS DONE    │ │   VALUE (EST.)   │
 ╰──────────────────╯ ╰──────────────────╯ ╰──────────────────╯

 WHERE THE TIME WENT ─────────────────────────────────────────
 Emails           ━━━━━━─────────────────────────      2  0.3h
 Images and video ──────────────────────────────────      0  0h
 Documents        ━━━━━━━━━━─────────────────────      3  1.5h
 Research         ━━━━───────────────────────────      1  0.4h
 Other            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━      6  1.0h

 WHO DID THE WORK ────────────────────────────────────────────
 Opus 5.5         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   9
 Sonnet 5         ━━━━━━━━━━━━━──────────────────────────   3

 LAST 7 DAYS ─────────────────────────────────────────────────
  (one bar per day)
 Tue Wed Thu Fri Sat Sun Mon
 Streak: 3 days in a row.

 Hours and dollars are estimates: 10 to 30 minutes a task depending
 on kind, at $50 an hour. /report settings changes them.
```

The numerals in the tiles are drawn large when they fit.

## The tabs

Click a tab at the top to switch.

| Tab | Title | Covers | Dates on the right |
| --- | --- | --- | --- |
| **Today** | TODAY | Today only | `Mon Nov 16, 2026` |
| **Week** | LAST 7 DAYS | Today and the 6 days before | `Nov 10 – Nov 16, 2026` |
| **Month** | LAST 30 DAYS | Today and the 29 days before | `Oct 18 – Nov 16, 2026` |
| **Year** | THIS YEAR | January 1 to today | `Jan 1 – Nov 16, 2026` |

Days are calendar days on your computer's clock. On a narrow pane the dates shorten or are left out.

When a tab has no tasks, it says so (for example **Nothing finished yet today. Your first finished task shows up here.**) and reminds you: **Each prompt you type that ends with an answer counts as one task.**

## Tiles

| Tile | What it is |
| --- | --- |
| **HOURS SAVED (EST.)** | Tasks of each kind times that kind's minutes, added up. Below 10 hours it shows one decimal (`3.3`); from 10 hours, a whole number. |
| **TASKS DONE** | Finished tasks in the tab's period. |
| **VALUE (EST.)** | Hours saved times your hourly rate, rounded to whole dollars. |

The tiles sit three across, or two or one on a narrow pane.

## Where the time went

One row per kind of task: **Emails**, **Images and video**, **Documents**, **Research**, **Other**. Each row has a bar (longest for the kind with the most tasks), then the number of tasks and the estimated hours for that kind. Kinds with no tasks are greyed. On a narrow pane the labels shorten to **Email**, **Media**, **Docs**, **Research**, **Other**.

## Who did the work

One row per model that finished tasks in the period, most first, up to six. Model names are shown the way people say them: `claude-opus-5-5` becomes **Opus 5.5**. A model the mod cannot name is shown as it was reported; `unknown` when none was reported.

## The chart and the summary line

| Tab | Chart | Summary line |
| --- | --- | --- |
| **Today**, **Week** | **LAST 7 DAYS**: one bar per day, labelled with the weekday. Today is gold. | **Streak: N days in a row.** Days in a row with at least one finished task, ending today (or yesterday, while today has none yet). Green from 2 days. |
| **Month** | **BY DAY**: one bar per day for 30 days, labelled with the first date and **Today**. | **Best day: Tue Nov 3, 14 tasks. 18 active days.** |
| **Year** | **BY MONTH**: one bar per month, January to December. This month is gold; months still to come are empty. | **Best month: October, 96 tasks. 120 active days.** |

An **active day** is a day with at least one finished task. Each bar is scaled to the busiest day or month on the chart. A day with no tasks shows as a flat line.

## What counts as a task

**One task is one prompt you typed that ended with an answer.**

| Counted | Not counted |
| --- | --- |
| A prompt you typed in the prompt box, sent while Claude was idle, that ended with Claude's answer. | Slash commands. |
| A prompt another mod sends as your own words, such as **Run it** in Prompt Upgrade. | A turn you cancelled, or one that ended without an answer. |
| | Messages typed while Claude was already working. |
| | Helper agents (subagents): their runs are not tasks of their own. |
| | Prompts sent by mods or tools that are not sent as your own words. |

A task counts on the day it **finishes**.

## How a task is sorted

Each task gets **one** kind, from the tools Claude used while working on it. When it touched several kinds, the first in this order wins: Emails, then Images and video, then Documents, then Research. A task that touched none of them is **Other**.

| Kind | A tool used… |
| --- | --- |
| **Emails** | has `mail`, `gmail`, `outlook`, `inbox`, `smtp` or `imap` in its name. |
| **Images and video** | has an image or video word in its name (such as `image`, `video`, `photo`, `ffmpeg`, `gif`), **or** a file tool wrote an image or video file (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.mp4`, `.mov` and similar). |
| **Documents** | has a document word in its name (such as `docx`, `pptx`, `xlsx`, `document`, `slide`, `sheet`, `spreadsheet`, `excel`, `pdf`, `notion`), **or** is a skill whose name mentions `docx`, `pptx`, `xlsx`, `pdf`, slides or sheets, **or** a file tool wrote a document (`.docx`, `.pdf`, `.pptx`, `.xlsx`, `.csv`, `.odt`, `.rtf`, `.pages`, `.key`, `.numbers` and similar). |
| **Research** | searches the web, fetches or reads pages, browses, reads transcripts, scrapes or crawls. Code search (`Grep`, `Glob`) and tool search do **not** count as research. |
| **Other** | everything else, including ordinary coding. |

"File tool" here means Claude Code's `Write`, `Edit`, `MultiEdit` and `NotebookEdit`.

## The estimate

Minutes saved per task, by default:

| Kind | Minutes |
| --- | --- |
| Emails | 10 |
| Documents | 30 |
| Images and video | 20 |
| Research | 25 |
| Other | 10 |

**Hourly rate: $50.**

Example: in one week Claude finished 2 email tasks, 3 document tasks, 1 research task and 6 other tasks. That is 2×10 + 3×30 + 1×25 + 6×10 = 195 minutes, so **3.3 hours** and **$163** at $50 an hour.

The note at the bottom of the pane repeats the rate and the range of minutes, and points to `/report settings`.

## Slash commands

| Command | Does |
| --- | --- |
| `/report` | Open the pane. |
| `/report today` | Open it on **Today**. |
| `/report week` | Open it on **Week** (last 7 days). |
| `/report month` | Open it on **Month** (last 30 days). |
| `/report year` | Open it on **Year** (January 1 to today). |
| `/report settings` | List the estimate settings. |
| `/report settings rate <dollars>` | Set the hourly rate, e.g. `/report settings rate 75`. |
| `/report settings <kind> <minutes>` | Set the minutes saved per task for one kind, e.g. `/report settings emails 15`. |

Any other word answers: **Use /report, /report week, /report month, /report year or /report settings.**

## Keyboard

| Key | Does |
| --- | --- |
| Esc | Close the pane. |

The tabs are buttons: click them, or move to them and press Enter.

## Settings

There are no install-time settings. The estimate is changed with `/report settings`:

| Setting | Accepts | Rules |
| --- | --- | --- |
| `rate` | Dollars per hour | 0 to 100000. Kept to the cent. |
| `emails` (also `email`, `mail`) | Minutes per task | 0 to 1440 (one day). Rounded to whole minutes. |
| `documents` (also `document`, `docs`, `doc`) | Minutes per task | Same. |
| `images` (also `image`, `video`, `videos`, `media`) | Minutes per task | Same. |
| `research` | Minutes per task | Same. |
| `other` | Minutes per task | Same. |

A change applies to every tab, past days included, since hours and dollars are worked out each time the pane draws. `/report settings` on its own lists the current values:

```
Work Report estimate settings:
Minutes saved per task: Emails 10, Documents 30, Images and video 20, Research 25, Other 10.
Hourly rate: $50.
Change one with /report settings rate 75 or /report settings emails 15.
```

## Your data

Everything stays on your machine, in the mod's own store under your Claude Code configuration folder:

- **One small record per calendar day**: the number of tasks of each kind, and the number per model.
- **Your estimate settings.**

No prompt text, answers or file names are kept. Day records older than **two years** (730 days) are removed when a session starts.

## Turning it off or hiding it

The mod reads a shared switch file used by the **Mods** mod (`mod-manager`). In its pane (`/mods`):

- **Off** stops the mod in every open chat within about 3 seconds. While it is off, **no tasks are counted**, and `/report` answers **Work Report is off. Turn it on in /mods.**
- **Hidden** keeps the mod counting but removes the **Work report** button. `/report` still opens the pane.

The status-bar button sits in a grid shared by all the mods in this collection, in the "reports" column.

## Limits and good to know

- **Counting starts when the mod is installed and on.** Earlier work is not counted.
- **The minutes are flat per kind.** A two-minute email and a two-hour email both count as one email task. Set the numbers to what is fair for your work.
- **One kind per task.** A task that drafted an email and then wrote a report counts as Emails, by the order above.
- **The status-bar button only opens the pane**; close it with Esc.
- If the pane cannot draw a view, it says **Work Report could not draw this view.** Your records are untouched; try another tab.

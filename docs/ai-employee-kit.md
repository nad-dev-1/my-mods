# AI Employee Kit: user guide

Two mods in one plugin. **Clean View** hides the technical details while Claude works and shows one simple checklist above the prompt instead: the job, its steps, and how far along each one is. **Agent Dock** splits each request across a team of helper agents that run side by side, and shows every helper working live in a side pane.

**Clean View starts on. Agent Dock does nothing extra until you pick a Team Size above 1.**

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install ai-employee-kit@my-mods --scope user`. The code is in [`ai-employee-kit/`](../ai-employee-kit/).

---

## Contents

- [What you need](#what-you-need)
- [Clean View](#clean-view)
  - [Turning it on and off](#turning-it-on-and-off)
  - [The checklist](#the-checklist)
  - [Job states](#job-states)
  - [How Claude fills the checklist](#how-claude-fills-the-checklist)
  - [Seeing the hidden details](#seeing-the-hidden-details)
- [Agent Dock](#agent-dock)
  - [Opening the dock](#opening-the-dock)
  - [The dock at a glance](#the-dock-at-a-glance)
  - [Team Size](#team-size)
  - [Helper model](#helper-model)
  - [The mission and the helpers](#the-mission-and-the-helpers)
  - [Faces (optional headshots)](#faces-optional-headshots)
  - [The status-bar badge](#the-status-bar-badge)
- [Using both together](#using-both-together)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [Turning the mod off or hiding it](#turning-the-mod-off-or-hiding-it)
- [What it stores and where](#what-it-stores-and-where)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code with mods (plugins with a hooks module) | Both mods draw their own screens and react to Claude's work. |
| Access to the **Haiku** model | Clean View asks Haiku for a short name for each job. Agent Dock runs helpers on Haiku when **Fast & Cheap** is picked. |
| The **mod-manager** mod (optional) | Its `/mods` panel turns this mod off, or hides it, in every chat. |
| A terminal that can draw images (optional) | Only for helper headshots. Without it, each helper gets a two-letter badge. |

The plugin has no settings in `plugin.json`. Everything is set from inside the mod.

---

## Clean View

### Turning it on and off

- The button at the right end of the checklist row: **[ ● Clean View: ON ]** or **[ ○ Clean View: OFF ]**. One click switches it. In a narrow window it shortens to **[● ON]** / **[○ OFF]**.
- `/simple` switches it. `/simple on` and `/simple off` set it directly.
- It starts on. Your choice is remembered after a restart.

A short message confirms each switch: on means tool details are hidden; off means every detail is showing again.

### The checklist

While Claude works on a request you typed, the checklist sits above the prompt:

```
Build my landing page · 1m 12s              [ ● Clean View: ON ]
✓ Understand the request         ██████████  Done
▶ Write the pricing section      ██████░░░░  60%
○ Check it on a phone            ░░░░░░░░░░  Next
○ Show you the result            ░░░░░░░░░░  Up next
```

| Part | What it shows |
| --- | --- |
| **Title** | The job's name and how long it has run. It starts as the first words of your request, then Haiku gives it a short name of 2 to 6 words. |
| **Icon** | ✓ done, ▶ working now, ‖ working but paused because Claude needs you, ○ not started. |
| **Step name** | Plain English, at most 40 characters. Code, file names and paths are removed. |
| **Meter** | 10 cells, filled to the reported percent. While a step has not reported yet, a short bright sweep moves across it. |
| **Label** | **Done**, a percent such as **60%**, **Working** (no percent yet), **Next** (the first step waiting), **Up next** (the others). |

Until Claude lays out a real plan, the checklist shows two starter steps: **Understand your request** and **Plan the steps**.

Slash commands do not start a new job. Only requests you type (or that another mod sends as yours) do.

### Job states

The title line changes to show how the job stands:

| Title line | When |
| --- | --- |
| Job name · time | Claude is working. |
| **Needs you** + a reason | Claude is waiting on you. Reasons: *Claude needs your OK to continue* (a permission prompt), *Claude has a question for you*, *Claude is waiting for your reply* (Claude stopped with steps left). |
| **⚠ Stuck:** + a reason | Something is in the way. See below. |
| **■ Stopped** · job · you pressed Esc | You stopped the job. |
| **✓ All done** · job · took 2m 3s | Every step is checked off. After 5 seconds the list folds to this one line. |

Reasons for **Stuck**:

| Reason | Cause |
| --- | --- |
| you said no to a step, so Claude paused | You turned down a permission prompt. |
| a step keeps failing, Claude is trying another way | Three tool calls in a row failed. The next success clears it. |
| Claude couldn't help with that request | Claude declined the request. |
| you hit your usage limit, try again a little later | Rate or billing limit. |
| Claude's servers are busy, try again in a minute | The service was overloaded. |
| type /compact and try again | The conversation got too long, or the request was not accepted. |
| the internet connection dropped | A network error. |
| type /login | Sign-in problem. |
| something went wrong, try again in a moment | Any other error. |

When you reply to a job that was waiting on you, the same checklist carries on instead of starting over.

### How Claude fills the checklist

While Clean View is on, Claude is told to:

1. Call **`plan_steps`** first, for every request, with 2 to 8 short plain-English step names.
2. Call **`report_progress`** as work happens (the step's name and a percent), and with 100 the moment a step finishes. That checks it off and starts the next one.

Claude's own to-do list counts as a plan too: when Claude writes or updates a to-do list, the checklist follows it.

Until there is a plan, Claude cannot use other tools. A tool call before the plan is refused with a note asking Claude to plan first. Asking you a question, loading tools and to-do list updates are still allowed. Helper agents are never held to this rule.

The two tools are registered by this mod as `mcp__ai-employee-kit__plan_steps` and `mcp__ai-employee-kit__report_progress`.

### Seeing the hidden details

While Clean View is on, tool calls, their results and their progress hints are hidden from the chat. Nothing is lost:

- Press **ctrl+o** (Claude Code's expanded view) to see every hidden row.
- Or turn Clean View off; the rows come back.

---

## Agent Dock

### Opening the dock

- **◆ Dock** in the status bar opens the dock pane.
- `/dock` opens it, or folds it to a status-bar badge when it is open. Type it again to switch back.
- **Esc** closes the pane and folds it to the badge.

If the window is too narrow for the pane, a message says so (*Widen it or watch the status bar*) and the dock folds to the badge instead.

The **◆ Dock** button sits in a grid of status-bar buttons shared with the other mods from this marketplace, so the buttons never push each other off the bar.

### The dock at a glance

```
◆  A G E N T  D O C K                                 ● L I V E
───────────────────────────────────────────────────────────────
T E A M  S I Z E   ╭  1  3  5  10  20  50  100  │  Custom  ╮
Splits each request across 10 helpers  ·  10 at a time  ·  Fast & Cheap
Helper agents   Fast & Cheap  Same as me

M I S S I O N   Research bakery pricing             42%   1:05
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────────────
● 4 working    ○ 3 queued    ✓ 3 done    ✕ 0 stuck
```

The picked size and the picked helper model are highlighted. In a narrow pane, headings drop their letter spacing and the controls wrap onto more lines.

| Part | What it is |
| --- | --- |
| **Masthead** | **LIVE** while helpers run, **COMPLETE** when they are all back, **STANDING BY** when idle. |
| **Team Size** | How many helpers each request is split across. See [Team Size](#team-size). |
| **Info line** | What the size means, how many helpers run at a time, and the helper model. |
| **Helper agents** | **Fast & Cheap** or **Same as me**. See [Helper model](#helper-model). |
| **Mission** | The current job, its percent and timer, a progress bar and the counts. |
| **Helpers** | One card per helper, or small tiles when there are more than 12. |
| **Summary** | When every helper is back, a line such as *50 agents finished Research bakery pricing in 2m 14s*, plus *(2 got stuck)* when some failed. |

When nothing is running, the dock shows a row of dots for your team and **Your team of N is standing by**.

### Team Size

Pick a size from the chips: **1, 3, 5, 10, 20, 50, 100**, or **Custom**. Custom opens a small box, **How many helpers?**, that takes any whole number from 1 to 100. You can also type `/dock 25`.

| Size | What happens |
| --- | --- |
| **1** (the default) | Claude decides how many helpers to use. Nothing is added to your requests. |
| **Above 1** | Each request you type is told to split into exactly that many independent pieces, one helper per piece, all launched together. Claude also tells each helper to report its progress. |

With a size above 1:

- **Extra helpers are refused.** Once a request has its full team, any further helper call is turned down with *Finish with the helpers you have.*
- **Too few gets one reminder.** If Claude answers having used fewer helpers than the size, the dock sends one follow-up asking it to split the rest of the work across the missing helpers.
- **Big teams need a yes.** A size above 20 shows **Big team: this uses your plan quickly. Continue?** with **Continue with N** and **Cancel**.
- **Big teams do not carry over.** A size above 20 goes back to 1 in a new session. Sizes up to 20 are remembered.

**How many run at once.** Helpers past the limit wait in the dock as *queued* and start as slots free up. The limit is the lower of two Claude Code settings: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20) and `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (default 10). So by default, 10 at a time.

### Helper model

| Choice | What it does |
| --- | --- |
| **Fast & Cheap** (default) | When the Team Size is above 1, helpers run on Haiku, unless Claude named a model for that helper. |
| **Same as me** | Helpers use whatever model Claude would give them. |

At Team Size 1 the helper model is never changed.

### The mission and the helpers

**Mission row:** the job name (the first part of your request, about 40 characters), the overall percent (every helper counts the same) and a timer. Below it, a bar fills as helpers finish, and the counts: ● working, ○ queued, ✓ done, ✕ stuck.

Extra lines can appear under it:

- *Waiting for Claude to split the work…* while the request is running but no helper has started.
- *6 of 10 helpers launched* when the job ended with fewer helpers than the Team Size.

**Helper cards** (12 helpers or fewer):

| Part | What it shows |
| --- | --- |
| Face | A headshot, or a colored two-letter badge made from the task name. Grey while queued. |
| Task name | 3 to 5 words from the helper's description, such as *Price check: Panera*. |
| Timer | How long the helper has run (m:ss). |
| Meter | Fills to the helper's reported percent. Before its first report, a bright sweep moves along it. Gold when done, red when stuck. |
| Percent | The last reported percent, **··** before the first report, **stuc** when stuck. |

A card's border turns red when that helper got stuck, which means its run ended with an error. A helper call that another rule refused before it started is removed from the dock.

**Tiles** (more than 12 helpers): each helper becomes a small colored tile with its initials and a meter.

Helpers report progress with the same `report_progress` tool Clean View uses. The dock matches each report to the right card.

### Faces (optional headshots)

Put PNG files in `~/.claude/ai-employee-kit-data/employee-headshots/` (a folder named `employee-headshots` inside the plugin folder also works). The dock reads them when a session starts, sorts them by name, and hands them out to helpers in turn.

Headshots only show on helper cards (not tiles), and only in a terminal that can draw images. Otherwise each helper gets its two-letter badge.

### The status-bar badge

When the dock is folded, the status bar shows a badge instead of the pane:

- While a job has helpers: **◆ 12 working · 8 queued · 30 done** (and **· N stuck** when any are).
- Otherwise: **◆ Agent Dock · team of N · /dock to open**.

Opening the pane again removes the badge.

---

## Using both together

- Claude plans first, so no helper starts before the checklist has its steps.
- Helpers skip the plan. If a helper tries to call `plan_steps`, it is told to just report progress.
- Helpers' progress moves their cards in the dock. Claude's own progress moves the checklist.

---

## Slash commands

| Command | Does |
| --- | --- |
| `/simple` | Switch Clean View on or off. |
| `/simple on` / `/simple off` | Turn Clean View on, or off. |
| `/dock` | Open the dock, or fold it to the status-bar badge. |
| `/dock N` | Set the Team Size to N (a whole number from 1 to 100). Above 20 asks you to confirm in the dock. |

Anything else after `/simple`, or a size that is not a whole number from 1 to 100, gets a short reply explaining what is accepted.

## Keyboard

| Key | Does |
| --- | --- |
| ctrl+o | Claude Code's expanded view: shows every row Clean View hides. |
| Esc (in the dock) | Closes the dock and folds it to the badge. |
| Esc (while Claude works) | Stops Claude; the checklist shows **■ Stopped**. |

## Settings

There are no `userConfig` fields in `plugin.json`. The settings live inside the mod:

| Setting | Where | Default | Remembered |
| --- | --- | --- | --- |
| Clean View on/off | Checklist button, `/simple` | On | Yes |
| Team Size | Dock chips, Custom box, `/dock N` | 1 | Yes, up to 20; above 20 goes back to 1 in a new session |
| Helper agents | Dock: **Fast & Cheap** / **Same as me** | Fast & Cheap | Yes |

Two Claude Code environment settings change how many helpers run at once: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (see [Team Size](#team-size)).

## Turning the mod off or hiding it

The mod reads the on/off switches that the **mod-manager** mod's `/mods` panel writes to `~/.claude/mods/switches.json`. A change reaches every open chat within about 3 seconds, with no reload.

| Switch | Effect |
| --- | --- |
| **Off** | Both Clean View and Agent Dock stop: no checklist, no hidden rows, no plan-first rule, no team split, no **◆ Dock** button. `/simple` and `/dock` reply *AI Employee Kit is off. Turn it on in /mods.* |
| **Hidden** | The mod keeps working but stays out of sight: no checklist, no **◆ Dock** button, and tool rows show as normal. Claude still plans first and the team split still applies. `/dock` still opens the dock pane. |

## What it stores and where

| What | Where |
| --- | --- |
| Clean View on/off, Team Size, helper model | The plugin's own store in Claude Code. |
| Live helper counts, for a custom status line to read | `~/.claude/ai-employee-kit-data/agents-now/<session id>.json`. It holds the numbers working, queued, done and stuck, and is reset to zero when the session ends. |
| Your headshots (optional) | `~/.claude/ai-employee-kit-data/employee-headshots/` (you create it). |

The checklist and the current job are kept only for the running session.

## Limits and good to know

- **Big teams use your plan quickly.** Every helper is its own agent run.
- **Each request makes one small Haiku call** to name the job while Clean View is on.
- **Plan first means one extra step** at the start of every request, even a quick question.
- **The checklist only follows Claude's main conversation.** Helpers show in the dock, not in the checklist.
- **Stopping a request** while helpers wait their turn removes the waiting ones from the dock before they start.
- If the dock ever fails to draw, it says so and your helpers keep working. Type `/dock` twice to redraw.

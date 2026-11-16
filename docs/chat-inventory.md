# Chat Inventory: user guide

A Claude Code mod that shows everything the current chat has used, live, in a side pane titled **In this chat**: the to-do list, the connectors and command-line tools called, the files read, the skills, the subagents and the web pages.

**It only reads what the chat itself did. Nothing leaves your machine.**

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install chat-inventory@my-mods --scope user`. The code is in [`chat-inventory/`](../chat-inventory/).

---

## Contents

- [What you need](#what-you-need)
- [Opening the pane](#opening-the-pane)
- [The pane at a glance](#the-pane-at-a-glance)
- [To-do card](#to-do-card)
- [Connectors card](#connectors-card)
- [Context files card](#context-files-card)
- [Skills card](#skills-card)
- [Subagents card](#subagents-card)
- [Web pages card](#web-pages-card)
- [Live counts and "via subagent"](#live-counts-and-via-subagent)
- [Copy and Hide](#copy-and-hide)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [Turning it off or hiding it](#turning-it-off-or-hiding-it)
- [What it stores and where](#what-it-stores-and-where)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code 2.1.287 or later | The mod uses its mod engine. |
| macOS `open` (optional) | Pressing a file opens it. Without it, files cannot be opened from the pane. |

## Opening the pane

- **▤ In this chat** in the status bar opens the pane, or closes it when it is open. The label turns yellow while the pane is open.
- `/inventory` does the same.
- The pane never opens by itself.

The status-bar button shares a three-row button grid on the right of the status bar with the other mods from this repository.

## The pane at a glance

```
In this chat                                         [Copy] [Hide]
╭──────────────────────────────────────────────────────────────╮
│ ▾ ☷ To-do                                            4 of 6  │
│ ✓ Find the failing test   (struck through)                   │
│ ◐ Fix the date parser                                        │
│ ○ Run the test suite                                         │
╰──────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────╮
│ ▾ ⏚ Connectors                                           2   │
│  G  GitHub     pr view            via subagent     2 calls   │
│  S  Supabase   list_tables                         3 calls   │
╰──────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────╮
│ ▾ ▤ Context files                                       12   │
│ Files read                                              11   │
│ CLAUDE.md  ~/.claude                                  auto   │
│ 1 to 10 of 12                                ▴ Up  ▾ Down    │
╰──────────────────────────────────────────────────────────────╯
  … Skills · Subagents · Web pages
```

- **Header**: the title, **Copy** and **Hide**.
- **Six cards**, always in this order: To-do, Connectors, Context files, Skills, Subagents, Web pages. Each header shows a count on the right.
- **Fold a card** by pressing its header (**▾** open, **▸** folded).
- Cards that list rows show up to 12, then *+N more*.
- A short note under the header confirms a copy or says a file could not be opened.

## To-do card

The chat's current to-do list, with *N of M* done in the header.

| Mark | Meaning |
| --- | --- |
| ✓ (struck through) | Done |
| ◐ (bold) | In progress |
| ○ | Not started |

It shows one of two lists, whichever changed last:

- **Claude's own task list** (its TodoWrite, TaskCreate and TaskUpdate tools);
- **the Clean View step checklist** from the AI Employee Kit mod (its `plan_steps` and `report_progress` tools).

Only the main chat's list is shown. A subagent's list never replaces it. With no list yet the card says *No to-do list yet. Claude makes one for jobs with several steps.*

## Connectors card

Every connector the chat called: MCP servers and claude.ai connectors, plus these command-line tools when run through the shell:

| Command | Shown as |
| --- | --- |
| `gh` | GitHub |
| `glab` | GitLab |
| `supabase` | Supabase |
| `render` | Render |
| `maestro` | Maestro |
| `terminal-browser` | Terminal Browser |
| `graphify` | Graphify |

They count even behind an `rtk` wrapper or leading environment settings (`FOO=1 gh pr view`). Plain shell commands (`ls`, `git`, `npm` …) do not count.

Each row shows a coloured badge with the first letter, the connector's name, the tool it used last, and the number of calls. Newest first.

**Press a connector** to unfold its calls, newest first: the tool, what it asked for (a key, a query, a path) and the time. Up to 8 are shown, then *+N earlier*. Press again to fold. Only one connector is unfolded at a time.

Progress-only servers (the AI Employee Kit's own tools and the savvy-progress server) are not counted as connectors.

## Context files card

Files read by Claude and its subagents, newest first.

- **Files read**: the number of files actually read.
- Each row shows the file name and its folder (shortened to the last two folders, with `~` for your home folder).
- **auto**: an instruction or memory file loaded when the chat started, such as a `CLAUDE.md`.
- *N reads*: shown when a file was read more than once.
- Ten rows at a time. **▴ Up** and **▾ Down** move by five; the line *1 to 10 of 12* says where you are.
- **Press a file** to open it. If it cannot be opened, the pane tries to show it in Finder, then says *Could not open …*.

Left out on purpose: Claude's own scratch files (large tool results saved to disk, files in `/tmp`, `/private/tmp`, `/var/folders`, and job temp folders). A read of a skill's `SKILL.md` counts as a skill, not a file.

## Skills card

Each skill the chat used, as `/name`, with *N uses*. A skill counts when it is:

- run through the Skill tool;
- typed as a slash command (when Claude Code knows that command as a skill);
- read from its `SKILL.md` file.

## Subagents card

Each subagent of the chat: its type, its task, and its state.

| State | Colour |
| --- | --- |
| running, pending | Orange |
| done | Green |
| failed, stopped | Red |

The list is read again every 3 seconds while the pane is open, and after every reply.

## Web pages card

Pages fetched and web searches, grouped by site (`www.` dropped), with the last address or query and *N times*. A page counts when it comes from:

- the WebFetch tool;
- a browser connector's navigate or open-page tool;
- `terminal-browser open` or `new-tab` in the shell.

Web searches are grouped under **Web search**.

## Live counts and "via subagent"

- Counts change as Claude works. A count that just went up is lit (yellow) for four seconds.
- Anything a subagent used carries **via subagent**. When both the main chat and a subagent used it, the row says *N via subagent*.
- A tool call that was denied is not counted.

## Copy and Hide

- **Copy** puts the whole inventory on the clipboard as a Markdown list, one heading per card, with the to-do items as checkboxes. The pane confirms *Copied the inventory as a Markdown list.*
- **Hide** closes the pane.

## Slash commands

| Command | Does |
| --- | --- |
| `/inventory` | Opens or closes the **In this chat** pane. |

## Keyboard

The pane has no keys of its own. Use Tab, the arrows and Enter to move between its buttons and press them.

## Settings

None. The mod has no settings screen and no `userConfig` fields. Folded cards, the unfolded connector and the file window position last for the session.

## Turning it off or hiding it

The mod obeys the switches in the **Mods** pane (see the [Mods guide](mod-manager.md)). A change reaches every open chat within 3 seconds.

- **Off**: it stops counting, the status-bar button goes, the pane says *Chat Inventory is off in every chat. Turn it on in /mods.*, and `/inventory` replies *Chat Inventory is off. Turn it on in /mods.*
- **Hidden**: the status-bar button goes, but the mod keeps counting and `/inventory` still opens the pane.

## What it stores and where

Nothing on disk. The lists live in the session's state while Claude Code runs. When Claude Code restarts or the mod reloads, the lists are rebuilt from the chat's own transcript (the main chat's and each subagent's), so nothing is counted twice. **Copy** writes only to your clipboard.

## Limits and good to know

- **Rebuilt rows have no time.** After a restart, calls read back from the transcript show no clock time in a connector's call list.
- **Each connector keeps its last 30 calls** for the unfolded list; the count covers them all.
- **Calls made while the mod was off** are not counted live. They are picked up at the next restart, when the lists are rebuilt from the transcript.
- **Opening files** uses the macOS `open` command.
- **Skill detection for slash commands** relies on the list of skills Claude Code reports when the mod first checks; a skill added later in the session may not be recognised when typed.

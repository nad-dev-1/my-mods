# Cache Clock & Handoff: user guide

A Claude Code mod that does two jobs. The **Cache Clock** is a card above the prompt that counts down the hour your chat stays in the prompt cache, shows what your next message will cost, and can keep the cache warm while you are away. The **Handoff** writes a full summary of a long chat, saves it in your project, and starts a fresh chat from it.

**Nothing is sent to the new chat by itself. The handoff is put in the prompt box so you can read it first.**

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install cache-handoff@my-mods --scope user`. The code is in [`cache-handoff/`](../cache-handoff/).

---

## Contents

- [What you need](#what-you-need)
- [Opening it](#opening-it)
- [The Cache Clock card](#the-cache-clock-card)
- [Auto-warm](#auto-warm)
- [The cold-send guard](#the-cold-send-guard)
- [The Refresh banner](#the-refresh-banner)
- [Making a handoff](#making-a-handoff)
- [The ready card](#the-ready-card)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [Turning it off or hiding it](#turning-it-off-or-hiding-it)
- [Working with ctx-handoff](#working-with-ctx-handoff)
- [What it stores and where](#what-it-stores-and-where)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code 2.1.287 or later | The mod uses its mod engine. |
| `git` (optional) | Keeps saved handoffs out of git on your machine. Without a git repository the handoff is still saved. |
| `open` (macOS) or `xdg-open` (Linux) | **Open file** and the earlier-handoff links use one of them. |

## Opening it

There is nothing to open. Once installed:

- the **Cache Clock card** sits above the prompt in every chat;
- a **⇄ Handoff** button sits in the status bar. Pressing it starts a handoff straight away. While a handoff is waiting or being written it reads **⇄ Handoff …**.

The status-bar button shares a three-row button grid on the right of the status bar with the other mods from this repository. Each mod keeps its own place in that grid.

## The Cache Clock card

```
◷ Cache warm 59:49  ━━━━━━━━━━━━━━━━━━━━━━━━        [Auto-warm: ON] [Create Handoff] [Hide]
1 hour cache, as Anthropic's last reply set it. Reply now and 214k tokens cost 5 to 10% as much (~$0.04 warm vs ~$1.71 if it goes cold).
Keeping warm · ping 1 · next in 54:11 · last ping read 214k cached tokens · pings so far ~$0.04
Each ping reads the chat from cache for a small part of the price (5 to 10%). Letting it go cold means writing it all again.
```

### Line 1: the clock

| Part | What it shows |
| --- | --- |
| **◷ Cache** | Before Claude's first reply: *waiting for the first reply*. Then *warm* and a countdown in minutes and seconds. After the hour: *cold · expired 12m ago* (or `1h05m`). |
| **Bar** | 24 cells that shrink as the hour runs down. Green, then amber under 10 minutes, then red under 5 minutes. Empty and grey before the first reply or once cold. |
| **Auto-warm: ON / OFF** | The keep-warm switch. See [Auto-warm](#auto-warm). |
| **Create Handoff** | Starts a handoff. See [Making a handoff](#making-a-handoff). |
| **Hide / Show** | **Hide** folds the card to this first line. **Show** brings the other lines back. Remembered across sessions. |

The hour restarts each time the main chat sends a request to the model, after a compaction, and after each successful keep-warm ping.

### Line 2: what a reply costs

- While warm: how many tokens the chat holds and that a reply now costs 5 to 10% as much, with dollar estimates for warm and cold (for example `~$0.04 warm vs ~$1.71 if it goes cold`).
- Once cold: *The cache went cold: your next message writes about 214k tokens again (~$1.71).*
- Before the first reply: *The clock starts with Claude's first reply; the cache then stays warm for an hour.*

### Line 3: the keep-warm line

| Text | When |
| --- | --- |
| *Auto-warm is off · a notification comes 5 minutes before it goes cold* | Auto-warm is off. |
| *Keeping warm · first ping in 54:11* | Auto-warm is on, no ping sent yet. |
| *Keeping warm · ping 3 · next in 54:11 · last ping read 214k cached tokens · pings so far ~$0.12* | Pings are running. |
| *Keeping warm · from your next reply* | Auto-warm is on but nothing is cached yet, or the cache is already cold. |
| *Pinging paused: (reason). It starts again after your next message.* | The safety check stopped the pings. |

### Line 4

A fixed reminder: a ping costs a small part of the price; letting the cache go cold means writing the whole chat again.

While a handoff is being built or shown, the card folds to line 1 so the handoff card has room.

## Auto-warm

When **Auto-warm** is on, the mod sends an **invisible ping** 5 minutes before the cache would expire (55 minutes after the last request). The ping is a short, tool-less question over the chat. It never shows in the conversation. It reads the chat from the cache, and that restarts the hour.

- It stays on across your messages, with no time limit. Switch it off when you are done.
- The switch is remembered across sessions.
- If Claude is replying when a ping is due, it waits and looks again every 30 seconds.
- If the API is busy (429, 529 or another 5xx error), the ping is tried again a minute later, as long as it can still land before the cache expires. The card notes: *The API was busy (529): the ping is tried again in a minute.*

### The safety check

A ping must only **read** the cache. Pinging stops, and the card says why, when:

- a ping read nothing (the cache had already gone cold);
- a ping **wrote** to the cache 10% or more of what it read;
- a ping could not be sent or failed.

Pinging starts again after your next message.

### With Auto-warm off

You get one notification, 5 minutes before the cache goes cold: *The prompt cache goes cold in 5 minutes. Reply, or switch Auto-warm on, to keep it warm.*

## The cold-send guard

When the cache has gone cold on a chat of **50k tokens or more**, the first message you type is held back once. The note says how long ago the cache went cold, how many tokens sending will write again, and the estimated price next to what a warm reply would have cost. It suggests **Refresh** or `/handoff-new`.

Your text is put back in the prompt box, so pressing Enter again sends it. Only the first message of each cold period is held back. Slash commands and prompts nobody typed are never held back.

## The Refresh banner

A banner under the card offers **Refresh** (starts a handoff) and **Hide**. It shows in two cases:

| Case | Banner text | What **Hide** does |
| --- | --- | --- |
| The cache is cold on a chat of 50k tokens or more | *Cache cold on a 120k chat: your next message writes it all again (~$0.96). Refresh moves this work to a new chat with a full handoff.* | Hides it until the cache goes cold again. |
| The context is 250k tokens or more | *Context at 262k. Refresh moves this work to a new chat with a full handoff.* | Hides it until the context grows another 50k. |

The banner does not show while a handoff is under way.

## Making a handoff

Start one with **Create Handoff** on the card, **Refresh** on the banner, **⇄ Handoff** in the status bar, or `/handoff-new`. Only one runs at a time.

### It waits for the work

If Claude is still replying, or subagents are running, the handoff waits so it can read all of it. The card says *⇄ Refreshing: waiting for Claude's reply* (or *waiting for 2 subagents to finish*) and starts by itself when they are done.

### The five steps

```
╭ ⇄ Refreshing: building your handoff                                      [Cancel] ╮
│ ✓ 1. Reading the conversation        ━━━━━━━━━━━━  214 messages                    │
│ ✓ 2. Finding the files you used      ━━━━━━━━━━━━  18 files                        │
│ ✓ 3. Listing skills, tools and links ━━━━━━━━━━━━  2 skills, 3 links               │
│ ▸ 4. Writing the handoff             ━━━━━━──────  23s                             │
│ ○ 5. Saving and checking             ━━━━━━━━━━━━                                  │
╰───────────────────────────────────────────────────────────────────────────────────╯
```

| Step | Figure shown |
| --- | --- |
| 1. Reading the conversation | Number of messages. |
| 2. Finding the files you used | Files read or edited by Claude's tools. |
| 3. Listing skills, tools and links | Skills, MCP tools and web links seen, or *none used*. |
| 4. Writing the handoff | Seconds, counting live. |
| 5. Saving and checking | The saved file's name. |

**Cancel** stops it at any time.

### What the handoff contains

It is written in English by a fork of the conversation (which reads the chat from the cache). It starts with a `HANDOFF:` line naming the goal, then a line saying which folder to continue in, then twelve numbered sections:

1. Goal and scope
2. User constraints and preferences (your own words, quoted as you wrote them)
3. Where it stopped
4. Verified
5. Done but unverified / discussed only
6. Tried and failed
7. Facts found
8. Tools and environment
9. Still running or unfinished
10. Decisions
11. Next step (ends with one concrete action)
12. Questions for the user

Empty sections say *None*. Code, commands, paths and error messages are kept word for word.

### When it fails

The card turns red with **✗ Handoff failed**, the reason, **Try again** and **Close**. It fails when:

- the model could not write it (for example, *there is no finished reply to read yet*);
- the reply does not start with a `HANDOFF:` line, or has fewer than 9 of the 12 sections;
- the saved file does not read back the same.

## The ready card

```
╭ ✓ Handoff ready: 1240 words ──────────────────────────────────────────────╮
│ Saved to .claude/handoffs/2026-11-16-1432-fix-login-redirect.md            │
│   (kept out of git on this machine)                                        │
│ Writing it cost ~$0.31. Each message in the new chat starts from about     │
│   2k tokens instead of 214k: ~$0.04 less per message while warm, …         │
│ [Start new chat with it] [Copy handoff prompt] [Open file]                 │
│ [Earlier handoffs] [Close]                                                 │
╰────────────────────────────────────────────────────────────────────────────╯
```

| Button | Does |
| --- | --- |
| **Start new chat with it** | Runs `/clear`, then puts the handoff in the prompt box, followed by anything you typed while it was being built. It is **not sent**: read it, then press Enter. |
| **Copy handoff prompt** | Copies the handoff to the clipboard, to paste into any chat. |
| **Open file** | Opens the saved file in your default app. |
| **Earlier handoffs** | Lists up to five other handoffs saved in this project, newest first. Press one to open it. The button then reads **Hide earlier**. |
| **Close** | Puts the card away. The file stays saved. |

## Slash commands

| Command | Does |
| --- | --- |
| `/handoff-new` | Starts a handoff, the same as **Create Handoff**. Replies *Building a handoff: follow its steps above the prompt.* |

## Keyboard

The mod has no keys of its own. Use Tab, the arrows and Enter to reach and press its buttons, as with any card.

## Settings

The mod has no settings screen and no `userConfig` fields. Its two choices are the buttons on the card:

| Choice | Default | Remembered |
| --- | --- | --- |
| **Auto-warm** | Off | Across sessions |
| **Hide / Show** (card folded) | Shown | Across sessions |

## Turning it off or hiding it

The mod obeys the switches in the **Mods** pane (see the [Mods guide](mod-manager.md)). A change reaches every open chat within 3 seconds.

- **Off**: no card, no button, no pings, no warnings and no guard. `/handoff-new` replies *Cache Clock & Handoff is off. Turn it on in /mods.*
- **Hidden**: the card, the banner and the status-bar button are not drawn, but the mod keeps working. Auto-warm keeps pinging, the guard still holds back a cold send, and the 5-minute warning still comes.

## Working with ctx-handoff

If the separate **ctx-handoff** plugin is installed:

- Cache Clock switches off ctx-handoff's own keep-warm refresh once, by running its `/handoff refresh off`, since Auto-warm does that job. Its other notes and guards stay.
- It adds an instruction to ctx-handoff's handoff and background-notes requests to write in English, keeping quotes exactly as you wrote them.

## What it stores and where

| What | Where |
| --- | --- |
| The Auto-warm switch, the folded card, and a flag that ctx-handoff's refresh was already switched off | The mod's own store in Claude Code. |
| Saved handoffs | `<project>/.claude/handoffs/YYYY-MM-DD-HHMM-topic.md`. The topic is the first six words of the `HANDOFF:` line. |
| A line that keeps the handoffs folder out of git | The repository's own `.git/info/exclude`, added once. Never `.gitignore`, so nothing is committed or shared. |
| The clock, ping count and costs | Only in the running session. |

Nothing is sent anywhere except the pings and the handoff request, which go to the same model your chat uses.

## Limits and good to know

- **The hour is an estimate.** It is counted from the time of the last request, not checked with the server.
- **Dollar figures are estimates** from list prices for known model families. For a model not in the price table, most dollar figures are left out.
- **/clear or resuming another chat** resets the clock to *waiting for the first reply* and the ping count to zero.
- **Pings cost money**, a small part of a cold send each. The card shows the running total.
- **A handoff needs a finished reply** in the chat. In a brand new chat it fails with a clear reason.
- **Opening files** needs `open` or `xdg-open`. If neither works, the card says *Could not open …*; use **Copy handoff prompt** instead.

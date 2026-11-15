# Cache Handoff

A Claude Code mod that watches the prompt cache, keeps it warm while you are away, and hands a long chat off to a fresh one. The card follows "Mod #3" (Cache Clock) of Ben AI's *9 Insane Claude Mods* video, which credits Karan Bansal's [Cache Tax](https://github.com/karanb192/cache-tax); the handoff follows the video's "Mod #4".

## The card above the prompt

```
◷ Cache warm 59:49  ━━━━━━━━━━━━━━━━━━━━━━━━        [Auto-warm: ON] [Create Handoff] [Hide]
1 hour cache, as Anthropic's last reply set it. Reply now and 214k tokens cost 5 to 10% as much (~$0.04 warm vs ~$1.71 if it goes cold).
Keeping warm · ping 1 · next in 54:11 · last ping read 214k cached tokens · pings so far ~$0.04
Each ping reads the chat from cache for a small part of the price (5 to 10%). Letting it go cold means writing it all again.
```

- The clock counts down the hour the cache stays warm after the last request. The bar shrinks and turns amber under 10 minutes and red under 5. Once it runs out the card says how long ago it went cold.
- **Auto-warm** (always visible) keeps the cache warm with an **invisible ping** 5 minutes before it would expire: a tool-less question over the chat that only reads it from the cache and never shows in the conversation. Each ping restarts the hour. Auto-warm stays on across your messages and has no time limit; switch it off when you are done. It is remembered across sessions.
- **Hide** folds the card to its first line (clock, bar and buttons); **Show** brings it back. Remembered across sessions.
- **Create Handoff** writes a handoff (see below). The **⇄ Handoff** button in the status bar and `/handoff-new` do the same.

## The handoff

```
● Context at 262k. Refresh moves this work to a new chat with a full handoff.        [Refresh] [Hide]

╭ ⇄ Refreshing: building your handoff                                      [Cancel] ╮
│ ✓ 1. Reading the conversation        ━━━━━━━━━━━━  214 messages                    │
│ ✓ 2. Finding the files you used      ━━━━━━━━━━━━  18 files                        │
│ ✓ 3. Listing skills, tools and links ━━━━━━━━━━━━  2 skills, 3 links               │
│ ▸ 4. Writing the handoff             ━━━━━━──────  23s                             │
│ ○ 5. Saving and checking             ━━━━━━━━━━━━                                  │
╰───────────────────────────────────────────────────────────────────────────────────╯
```

- **Banner**: past 250k tokens of context a banner offers **Refresh**; **Hide** puts it away until the context grows another 50k. When the cache has gone cold on a chat of 50k or more, the banner says what the next message would cost to send.
- **Waits for the work**: a handoff asked for while Claude replies, or while subagents run, waits for them and says so, then starts by itself, so it reads all of it.
- **Five steps**, each with a bar and a figure: the messages read, the files the tools touched, the skills, MCP tools and links used, the seconds the writing takes, and the saved file's name.
- **Contents**: twelve sections in English (Goal and scope; User constraints and preferences, quoted as written; Where it stopped; Verified; Done but unverified; Tried and failed; Facts found; Tools and environment; Still running or unfinished; Decisions; Next step; Questions for the user). It is written by a fork of the conversation, which reads it from the cache. A reply without the `HANDOFF:` line or most of the sections is refused, with **Try again**.
- **Saved** to the project's `.claude/handoffs/YYYY-MM-DD-HHMM-topic.md`, read back to check it, and kept out of git on this machine by adding the folder to the repository's own `.git/info/exclude` (never to `.gitignore`).
- **Ready card**: "Handoff ready: N words", where it was saved, what writing it cost, and how much less each message of the new chat sends. **Start new chat with it** runs `/clear` and puts the handoff in the prompt box, followed by anything you typed while it was being built; it is not sent, so you can read it first. **Copy handoff prompt**, **Open file**, **Earlier handoffs** (this project's last five) and **Close**.
- With ctx-handoff installed, its own keep-warm refresh is switched off once (`/handoff refresh off`), since Auto-warm does that job; its notes and guards stay.

## Safety and cost

- **Ping safety check**: a ping must read the chat from the cache. If one reads nothing (the cache had already gone cold) or writes a lot, pinging stops and the card says why; it starts again after your next message. A ping the API refuses as busy (429, 529, 5xx) is tried again a minute later while it can still land.
- **Dollar estimates** come from list prices (the table is Cache Tax's, MIT): what a reply costs now, what it would cost cold, and what this chat's pings have cost so far. They are estimates, not a bill.
- **Cold-send guard**: when the cache has gone cold on a chat of at least 50k tokens, the first message you type is held back once with the price of writing the chat again and a pointer to Refresh; it is put back in the prompt box, so sending it again goes ahead. Slash commands and prompts nobody typed are never held back.
- **Warning**: with Auto-warm off, a notification comes 5 minutes before the cache goes cold.

## Notes

- The hour is the one-hour cache a subscription writes; it is an estimate from the time of the last request, not a check of the server.
- Requires Claude Code 2.1.287 or later.

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install cache-handoff@my-mods --scope user
```

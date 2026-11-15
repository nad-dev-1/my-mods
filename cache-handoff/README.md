# Cache Handoff

A Claude Code mod that watches the prompt cache, keeps it warm while you are away, and hands a long chat off to a fresh one. The card follows "Mod #3" (Cache Clock) of Ben AI's *9 Insane Claude Mods* video, which credits Karan Bansal's [Cache Tax](https://github.com/karanb192/cache-tax).

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
- **Create Handoff** runs ctx-handoff: hand off now (clears the chat) or just write the summary. The **⇄ Handoff** button in the status bar opens the same choice.

## Safety and cost

- **Ping safety check**: a ping must read the chat from the cache. If one reads nothing (the cache had already gone cold) or writes a lot, pinging stops and the card says why; it starts again after your next message. A ping the API refuses as busy (429, 529, 5xx) is tried again a minute later while it can still land.
- **Dollar estimates** come from list prices (the table is Cache Tax's, MIT): what a reply costs now, what it would cost cold, and what this chat's pings have cost so far. They are estimates, not a bill.
- **Cold-send guard**: when the cache has gone cold on a chat of at least 50k tokens, the first message you type is held back once with the price of writing the chat again; it is put back in the prompt box, so sending it again goes ahead. Slash commands and prompts nobody typed are never held back.
- **Warning**: with Auto-warm off, a notification comes 5 minutes before the cache goes cold.

## Notes

- The hour is the one-hour cache a subscription writes; it is an estimate from the time of the last request, not a check of the server.
- Requires Claude Code 2.1.287 or later.

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install cache-handoff@my-mods --scope user
```

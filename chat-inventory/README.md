# Chat Inventory

A Claude Code mod that shows everything a chat used, live, in a side pane titled **In this chat**. The idea and the look come from "Mod #6" (Chat Inventory) of Ben AI's *9 Insane Claude Mods* video; this is an independent build written from scratch.

```
In this chat                                         [Copy] [Hide]
╭──────────────────────────────────────────────────────────────╮
│ ▾ ☷ To-do                                            4 of 6  │
│ ✓ Find the call in Google Calendar   (struck through)        │
│ ◐ Read the Gmail thread                                      │
│ ○ Write the one-page brief                                   │
╰──────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────╮
│ ▾ ⏚ Connectors                                           2   │
│  A  Atlassian  getJiraIssue                        3 calls   │
│  G  GitHub     pr view            via subagent     2 calls   │
╰──────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────╮
│ ▾ ▤ Context files                                       12   │
│ Files read                                              11   │
│ CLAUDE.md  ~/.claude                                  auto   │
│ 1 to 10 of 12                                ▴ Up  ▾ Down    │
╰──────────────────────────────────────────────────────────────╯
  … Skills · Subagents · Web pages
```

## The cards

- **To-do**: Claude's own task list (TodoWrite, TaskCreate, TaskUpdate) or the step checklist of the Clean View mod (plan_steps, report_progress), whichever changed last. "N of M" done; finished steps are struck through, the current one is marked. A subagent's list never replaces the chat's.
- **Connectors**: every MCP server or claude.ai connector the chat called, with a coloured badge, the tool it used last and the number of calls. These command-line tools count too when run through Bash (also behind `rtk` or env assignments): `gh` (GitHub), `glab` (GitLab), `supabase`, `render`, `maestro`, `terminal-browser` and `graphify`. Plain shell commands do not. Press a connector to unfold its calls, newest first, with what each asked for (a ticket key, a query, a path) and the time; press again to fold.
- **Context files**: files read by Claude and its subagents, newest first, with their folder; instruction and memory files loaded at the start are tagged **auto**. Claude's own scratch files (spilled tool results, temp copies) are skipped. Ten rows at a time with **Up** and **Down**; press a file to open it.
- **Skills**: skills run through the Skill tool, typed as slash commands, or read from their SKILL.md, with a use count.
- **Subagents**: each subagent of the chat with its type, task and state (running, done, failed).
- **Web pages**: pages fetched (WebFetch, a browser server's navigate, `terminal-browser open`) and web searches, by site, with a count.

## Behaviour

- **Opening**: the **▤ In this chat** button in the status bar opens and closes the pane, and `/inventory` does the same. It never opens by itself.
- **Live**: counts change as Claude works; a count that just went up is lit for four seconds.
- **via subagent**: anything a subagent used carries the tag (or "N via subagent" when the main chat used it too).
- **Fold** any card from its header (▾/▸).
- **Copy** puts the whole inventory on the clipboard as a Markdown list; **Hide** closes the pane.
- **Restarts and reloads** rebuild the lists from the chat's transcript (the main chat's and each subagent's), so nothing is counted twice. `/clear` starts the lists over.

## Notes

- Nothing leaves your machine: the mod reads the session's own tool calls and transcript, and keeps the lists in the session's state.
- Requires Claude Code 2.1.287 or later.

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install chat-inventory@my-mods --scope user
```

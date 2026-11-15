# AI Employee Kit

Two mods in one plugin: **Clean View** and **Agent Dock**.

## Clean View

Clean View makes Claude Code calm and friendly for people who aren't technical. While Claude works, tool calls, file diffs and command output are hidden, and one simple checklist sits above the prompt: the job's name and how long it has run, each step with a check, an arrow or a circle, a 10-cell meter and a label (Done, a percent, Working, Next, Up next). The header also shows **Needs you**, **Stuck**, **Stopped** and **All done**.

- The **[ ● Clean View: ON ]** button at the right of that row turns it on or off with one click.
- `/simple on`, `/simple off`, or `/simple` to switch.
- It starts on, and the choice is remembered after a restart.
- While it is on, Claude plans first: it calls `plan_steps` (2 to 8 plain step names) before any other tool, then `report_progress` as work happens. Helper agents are never held to this.
- Press ctrl+o to see every hidden row in the full transcript at any time.

## Agent Dock

Agent Dock splits each request across a team of helper agents running in parallel and shows every helper live in a pane: a face, a task name, a progress meter and a timer. When they all finish, Claude combines their work into one answer and the dock shows a summary line such as "50 agents finished Research bakery pricing in 2m 14s".

## Commands

- `/dock`: open the dock, or fold it to a status-bar badge ("12 working · 8 queued · 30 done"). Type it again to switch back.
- `/dock 10`: set the Team Size (any whole number from 1 to 100). Sizes above 20 ask you to confirm in the dock.
- The **◆ Dock** button in the footer opens it too.

## Team Size

- **1**: Claude decides how many helpers to use. Nothing is added to your requests.
- **Above 1**: every request is told to split into exactly that many helpers, launched together. Extra Agent calls are refused, and a request that used fewer gets one follow-up asking for the rest.
- Helpers past the engine's limit wait in the dock and start as slots free. The number at a time is the lower of `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20) and `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (default 10).
- A size above 20 resets to 1 in a new session.

## Helper model

**Fast & Cheap** (the default) runs helpers on Haiku when Team Size is above 1 and the Agent call named no model. **Same as me** leaves the model alone.

## Progress

Helpers report progress with the `report_progress` tool this plugin registers (`mcp__ai-employee-kit__report_progress`).

## Files

- Team Size and settings live in the plugin's own store.
- The live helper count is written to `~/.claude/ai-employee-kit-data/agents-now/<session_id>.json` for a status line to read.
- Optional headshots: PNG files in `~/.claude/ai-employee-kit-data/employee-headshots/` are used as faces where the terminal can draw images; otherwise each helper gets a two-letter badge.

Big teams use your plan quickly: every helper is its own agent run.

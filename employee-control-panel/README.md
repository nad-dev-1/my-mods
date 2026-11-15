# Employee Control Panel

A Claude Code mod that switches the model and effort level without typing `/model` or `/effort`, for Claude itself and for the subagents it starts.

## Using it

The status bar has a **» Control Tools** button. It also shows what is in force, for example `» Control Tools · Opus · high · sub: Haiku/low`. Click it, or type `/controls`, to open the panel:

- **Main → Model**: Fable, Opus, Sonnet or Haiku (each picks the latest of its family).
- **Main → Effort**: low, medium, high, xhigh or max.
- **Subagents → Model / Effort**: Auto (Claude Code decides, as usual) or a fixed choice.

A status line under the controls shows the result of each pick:

- `●` in use or applied;
- `◐` pending: picked while Claude is replying, applied as soon as the reply ends (a newer pick replaces a queued one);
- `✕` refused, with the reason (for example, a model your account cannot use).

The panel stays open, so you can set several things in one visit. Esc or **Close** shuts it.

## How it works

- **Main session**: a pick runs `/model <alias>` or `/effort <level>` for you, so it lasts exactly as if you had typed it. Picks you type yourself show up in the status too.
- **Subagents**: a subagent model pick is applied to every agent as it starts, even when Claude or the agent's definition asked for another model. A subagent effort pick is set on every Agent tool call. Forks (agents that continue the main conversation) always run as the main session, so they are left alone. Workflow agents take the model pick but not the effort.
- Subagent picks are remembered **per project folder**: a new session in the same folder starts with them; another folder starts on Auto.
- The current effort is the last `/effort` seen on the current model this session, else the level in your settings.

## Notes

- Clicking status-bar buttons needs the fullscreen layout (`/tui fullscreen`); `/controls` works anywhere.
- Requires Claude Code 2.1.287 or later.

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install employee-control-panel@my-mods --scope user
```

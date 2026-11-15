# Employee Control Panel

A Claude Code mod that switches the model and effort level without typing `/model` or `/effort`, for Claude itself and for the subagents it starts.

## Using it

Under the prompt, from the left edge and below Claude Code's own hint line, a live session bar shows three lines (everything ccstatusline showed, so it can replace it). The status bar to its right holds every mod's button in a three-row grid at the right edge, **◆ Control Tools ∧** first:

```
◆ Subscription │ ◆ Opus 5.5 │ effort high │ ctx ▰▰▱▱▱▱▱▱▱▱ 18% · 36.4k │ ◇ 0 agents │ sub Haiku/low   ◆ Control Tools ∧
5h 6% │ block 2h 10m │ week 41% │ session 1h 05m
▸ my-project │ ⎇ main +12 −4 │ in 1.2k  out 3.4k  cached 120k  total 125k │ style default
```

- Line 1: plan, model, effort, context (meter, percent, tokens), running agents, any subagent override.
- Line 2: 5-hour usage, time into the 5-hour window, weekly usage, time since the session started.
- Line 3: the working folder, git branch and uncommitted line changes, the tokens this session's replies used, the output style.

The effort is colour-coded (low grey, medium blue, high amber, xhigh red, max violet), and the bar updates the moment a pick lands, after each reply, as agents start and finish, and every 30 seconds for the clocks and git. Click the button, or type `/controls`, to open the panel: a spaced `◆ C O N T R O L   T O O L S` header with the current pick on the right, then compact tab rows with the pick highlighted (orange for models, pink for effort):

- **Main → Model**: Haiku, Sonnet, Opus or Fable, shown with versions (each picks the latest of its family; the one in use shows its live version).
- **Main → Effort**: Low, Medium, High, XHigh or Max.
- **Subagents → Model / Effort**: Auto (Claude Code decides, as usual) or a fixed choice.

The design follows "Mod 2: Employee Control Panel" in Tristen O'Brien's video *Claude Code Just Dropped MODS*.

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

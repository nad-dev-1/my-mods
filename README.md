# my-mods

Claude Code mods: plugins with a hooks module that change what Claude Code does and draw their own UI. One folder per mod; each folder is a complete plugin. Shared as-is.

| Mod | What it does |
| --- | --- |
| [`ai-employee-kit/`](ai-employee-kit/) | Clean View hides the technical details behind a simple checklist above the prompt; Agent Dock splits each request across a team of helper agents and shows them working live. |
| [`prompt-upgrade/`](prompt-upgrade/) | Turns a rough prompt into a clear one in a side pane, with up to three quick questions, before anything is sent. |
| [`work-report/`](work-report/) | A pane that shows the tasks Claude finished for you, the hours that likely saved, and what that time is worth. |
| [`mod-manager/`](mod-manager/) | List every installed plugin/mod with its status and turn each one on or off, from /mods or a panel |
| [`cache-handoff/`](cache-handoff/) | A bar above the prompt showing time left on the prompt cache, a Keep cache switch that sends a short 'Hi' 5 minutes before it expires, and a Create Handoff button for ctx-handoff |
| [`replay-button/`](replay-button/) | A Replay button in the status bar that opens Replay Theater's step-through of the last turn's file edits |
| [`filetree-button/`](filetree-button/) | A Files button in the status bar that shows or hides the filetree mod's file tree |
| [`inject-prompt/`](inject-prompt/) | An Inject button in the status bar that opens your saved prompts, grouped by category and filterable by tag or search, and inserts the ones you pick at the cursor |
| [`git-review/`](git-review/) | A Git Review button that lists your GitLab merge requests by project and starts a full review of one in a new terminal: conflicts, worktree, pipelines and scans, Sonar, and the project's own code review |

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install inject-prompt@my-mods --scope user
```

Or try one for a single session from a clone: `claude --plugin-dir ./inject-prompt`.

Each mod has a `tests/` folder; run `claude plugin test <mod>` to run them.

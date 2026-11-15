# Git Review

A Claude Code mod for reviewing GitLab merge requests.

## The dialog

The green **⎇ Git Review** button in the status bar (or `/git-review`) opens a dialog of open merge requests:

- the ones assigned to you, or where you are a reviewer;
- every open MR in the configured group (default `example-group/example-subgroup`, subgroups included).

MRs are grouped by project. Each group folds with ←/→, a click, or Enter on its header. The list scrolls while the filters and buttons stay put.

**Each row shows:**

- the MR's number, title and draft mark;
- a conflict ⚠;
- the pipeline (✓ / ✗ / ●);
- the author and branches, how long ago it changed, and your role;
- the verdict of the last review run from here.

**Filters:**

- **Show:** Mine / Group / All;
- **Sort:** Updated / Created / Oldest;
- **Hide drafts**;
- **Pipeline:** Any / Passed / Failed / Running;
- **Project**;
- **Search:** title, !id, author, branch or project.

The list refreshes when the dialog opens if it is over 3 hours old, then every 3 hours while it stays open. **Refresh** (`r`) refreshes it at any time.

## Picking an MR

Enter (or a click) on an MR finds the project's clone on this Mac:

1. a folder you set before;
2. otherwise a scan of the code folders (default `~/Documents/Projects ~/Desktop ~/code ~/dev`, 5 levels deep), matching the git `origin`;
3. otherwise it asks you for the folder, or clones into one, and remembers it.

It then opens a new terminal there (a Herdr terminal, else a Terminal window) running:

```
claude --permission-mode auto "/git-review:review-mr <MR URL>"
```

## The review (`/git-review:review-mr`)

1. **Conflict gate.** If the MR has conflicts, it stops and notifies you.
2. **Worktree.** It fetches the MR into `<repo>/../.mr-worktrees/<repo>-mr-<iid>` on the branch `review/mr-<iid>`.
3. **Four agents in parallel:**
   - `git-review:mr-code-review` runs the project's own review skills and agents. If there are none, you are asked whether to run a generic review.
   - `git-review:mr-pipelines` waits for the pipelines (up to 90 min), then reads failed jobs and the SAST, secret, dependency and container scan reports.
   - `git-review:mr-sonar` uses SonarCloud results if the project is bound to it (SonarQube MCP, `sonar api`, or `SONAR_TOKEN`). Otherwise it runs a throwaway local SonarQube scan in Docker.
   - `git-review:mr-files-secrets` checks **every commit** of the MR, not only the final diff, for:
     - **secrets:** gitleaks, using the *target* branch's `.gitleaks.toml` / `.gitleaksignore`, so an MR can't loosen its own rules;
     - **files that don't belong:** `.env`, keys, keystores, provisioning profiles, service-account JSON, and build or dependency output;
     - **warnings:** local clutter (`.DS_Store`, `.idea/`, `*.log`, `local.properties`…) and files over 5 MB;
     - **suspicious files:** Firebase configs, archives, SQL dumps, leftovers, stray binaries or executables, changes to the gitleaks or gitignore rules, and `gitleaks:allow` lines.

     Each hit says whether it's in the final changes or only in history. A secret is only ever shown as its first 4 characters plus `…`.
4. **One report**, in `~/.claude/git-review/reports/`, with a verdict: Approve / Changes needed / Blocked. Secrets, sensitive files and build output make it Changes needed. Warnings and suspicious files are listed but don't change the verdict. A **Files and secrets** section comes right after the summary, merged with the pipeline's own secret detection. You get a macOS notification and a toast in your main session.
5. **Optional MR comment.** It asks before posting the summary as one comment on the MR.
6. **Worktree.** It asks before deleting the worktree.

It never pushes, approves, merges or changes the MR.

## Settings (`/config` → git-review)

- `group`: the GitLab group listed beside your own MRs.
- `codeRoots`: the folders searched for local clones.
- `allowedPaths`: file patterns the files-and-secrets check allows in every project, for example `google-services.json`. They're still listed in the report as "allowed by settings".

Requires `glab` logged in to gitlab.com, and `gitleaks` for the secret scan (`brew install gitleaks`; without it, the file checks still run). For SonarCloud results, run `sonar auth login` once (or connect the SonarQube MCP).

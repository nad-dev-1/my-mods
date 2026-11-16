# Git Review: user guide

A Claude Code mod for reviewing GitLab merge requests (MRs). A button in the status bar opens a list of open MRs: the ones assigned to you, the ones waiting for your review, and every open MR in one GitLab group. Pick one and a new terminal opens in your local copy of that project, where Claude runs a full review: a conflict check, the MR's code in a separate worktree, then pipelines and security scans, Sonar, the project's own code review and a files-and-secrets check of every commit. It all ends in one report with a verdict.

**The review never pushes, approves, merges or changes the MR.** The only thing it may post is one summary comment, and only after you say yes.

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install git-review@my-mods --scope user`. The code is in [`git-review/`](../git-review/).

---

## Contents

- [What you need](#what-you-need)
- [Opening the dialog](#opening-the-dialog)
- [The dialog at a glance](#the-dialog-at-a-glance)
- [Filters and search](#filters-and-search)
- [Buttons](#buttons)
- [Keyboard](#keyboard)
- [Starting a review](#starting-a-review)
- [When no local copy is found](#when-no-local-copy-is-found)
- [The review, step by step](#the-review-step-by-step)
- [The four checks](#the-four-checks)
- [The report and the verdict](#the-report-and-the-verdict)
- [Following a review from the dialog](#following-a-review-from-the-dialog)
- [Slash commands](#slash-commands)
- [Settings](#settings)
- [What it stores and where](#what-it-stores-and-where)
- [Turning it off or hiding it](#turning-it-off-or-hiding-it)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| `glab`, signed in to **gitlab.com** (`glab auth login`) | Every GitLab read goes through it: the MR list, pipelines, jobs, scan reports, and the optional comment. |
| `git` | Finds your local copies, fetches the MR and makes the worktree. |
| `python3` | Runs the files-and-secrets check and reads pipeline status while waiting. |
| macOS | The mod opens a Terminal window, opens links in your browser and shows macOS notifications. |
| `gitleaks` (optional, `brew install gitleaks`) | The secret scan. Without it, the file checks still run and the report says the secret scan was skipped. |
| Docker (optional, running) | A throwaway local SonarQube scan when the project is not on SonarCloud. |
| A Sonar login (optional) | For SonarCloud results: the SonarQube connection in Claude Code, or `sonar auth login` once, or a `SONAR_TOKEN` environment variable. |
| SSH access to GitLab (optional) | Only for **Clone here**, which clones over SSH. |

A missing optional tool never stops a review. It shows up under **Not checked** in the report.

## Opening the dialog

- Click **⎇ Git Review** in the status bar. Click it again to close the dialog.
- Or type `/git-review`.
- The number on the button (`⎇ Git Review 3`) is how many listed MRs are assigned to you or wait for your review.
- The button is green, and brighter while the dialog is open.

The list loads when you open the dialog if it has never loaded or is over 3 hours old. While the dialog stays open, it reloads every 3 hours. **Refresh** reloads it at any time.

## The dialog at a glance

```
 ⎇ Git Review                          12 of 15 open · Updated 4m ago
 Search title, !id, author, branch or project…
 Show  Mine  Group  All   Sort  Updated  Created  Oldest  Hide drafts
 Pipeline  Any  ✓ Passed  ✗ Failed  ● Running
 Project  All projects (15)

 ▶ ▾ mobile-app  3 · example-group/example-subgroup
     ✓   !42 Add login screen
        [Approve] @dev1 · main ← feature/login · 2h ago · pipeline success · you: reviewer
     ✗ ⚠ !40 Update payment form
        @dev2 · main ← fix/form · 1d ago · pipeline failed

   ▸ web-portal  2 · example-group/example-subgroup
   ↓ 4 more lines
 Review  Open in GitLab  Refresh  Close
 ↑  ↓  Fold all  Unfold all  PgUp  PgDn  Search  · ↑↓ move · ←→ fold · Enter review · Esc closes
 Review of mobile-app !42 started in a new Terminal window.
```

MRs are **grouped by project**, projects in A to Z order. The list scrolls; the filters at the top and the buttons at the bottom stay in place.

### Project header

| Part | What it is |
| --- | --- |
| `▾` / `▸` | Open or folded. Click the header, or press Enter on it, to fold or open it. |
| Name | The project's name. |
| `3 · group/path` | How many MRs are shown, and the group the project lives in. |

Your folds are remembered.

### MR row

| Part | What it is |
| --- | --- |
| `▶` | The highlighted row. |
| `✓` `✗` `●` `·` | The newest pipeline: passed, failed, running, or none (or another state, such as canceled). |
| `⚠` (red) | The MR has merge conflicts. |
| `!42` | The MR number. |
| `[draft]` | The MR is a draft. |
| Title | Cut to fit. |

### The line under each MR

- A **verdict** in brackets when a review run from here has finished (`[Approve]` green, `[Blocked: …]` red, anything else amber), or the **stage** of a review still running (`[worktree ready]`, `[reviewing]`) in blue.
- `@author · target ← source` branches.
- How long ago the MR changed (`45m`, `5h`, `3d`).
- The pipeline status in words, or `no pipeline`.
- `you: assignee, reviewer` when the MR is listed because of you.

### Messages

The bottom line says what just happened: loading, how many MRs were found, a review that started, or an error (for example `Could not load merge requests: … Is glab logged in? (glab auth login)`).

## Filters and search

| Filter | Choices |
| --- | --- |
| **Show** | **Mine** (assigned to you or waiting for your review), **Group** (open MRs in the configured group), **All** (both; the default). |
| **Sort** | **Updated** (newest change first; the default), **Created** (newest first), **Oldest** (oldest first). |
| **Hide drafts** | On or off. |
| **Pipeline** | **Any**, **✓ Passed**, **✗ Failed**, **● Running**. |
| **Project** | A dropdown: **All projects (N)**, then each project with its count. Two projects with the same name show the last two parts of their path. Where no dropdown can be drawn, the projects show as buttons instead. |
| **Search** | Type words. An MR matches when every word is found in its title, `!number`, author, project path or branch names. |

The highlighted filter button is the one in use. Changing a filter scrolls the list back to the top.

## Buttons

| Button | Key | Does |
| --- | --- | --- |
| **Review** | `v` | Starts a review of the highlighted MR. On a project header, folds or opens it. |
| **Open in GitLab** | `o` | Opens the highlighted MR in your browser. |
| **Refresh** | `r` | Reloads the list. Shows **Refreshing…** while it works. |
| **Close** | | Closes the dialog. |
| **↑** / **↓** | `k` / `j` | Move the highlight one row. |
| **Fold all** / **Unfold all** | `f` / `u` | Fold or open every project group. |
| **PgUp** / **PgDn** | `p` / `n` | Scroll the list by a page. |
| **Search** | `s` | Puts the cursor in the search box. |

## Keyboard

| Key | Does |
| --- | --- |
| ↑ ↓ | Move the highlight. |
| Page Up / Page Down | Move the highlight a page at a time. |
| ← | Fold the group of the highlighted row. |
| → | Open the group of the highlighted row. |
| Enter | On an MR: start its review. On a project header: fold or open it. |
| Esc | Close the dialog. |
| Mouse wheel | Scroll the list. |
| `v` `o` `r` `k` `j` `f` `u` `p` `n` `s` | The buttons above. |

Clicking status-bar buttons needs Claude Code's fullscreen layout (`/tui fullscreen`). `/git-review` works anywhere.

## Starting a review

Press Enter on an MR, click it, or press **Review**. The mod then:

1. **Checks it is not already running.** In the Herdr terminal app, if a live terminal is already reviewing this MR, the mod says where it is and does not start another. A second click while a review is starting is ignored.
2. **Finds your local copy of the project**, in this order:
   1. the folder you used for this project before (checked again that it is still a copy of it);
   2. a search of your **code folders** (see [Settings](#settings)), about 5 levels deep, for a git folder whose `origin` is this project. It skips `node_modules`, `Pods`, `build`, `.build`, `DerivedData`, `.dart_tool` and `.mr-worktrees`. When there are several copies, the one closest to the top is used. The result is kept for 10 minutes, and searched again once if nothing is found;
   3. otherwise it asks you (see the next section).
3. **Opens a new terminal** in that folder:
   - in the Herdr terminal app, a new Herdr terminal in the same tab as this session;
   - in Herdr's own command-line server, a new pane split to the right;
   - anywhere else, a new macOS Terminal window.
4. **Runs Claude there** with the review:

   ```
   claude --permission-mode auto "/git-review:review-mr <MR URL>"
   ```

   When the **Allowed paths** setting is set, ` --allowed <patterns>` is added to the end.
5. **Closes the dialog** and shows a toast saying where the review started.

If Claude Code has not yet been told to trust that folder, the message says so: answer **"Yes, I trust this folder"** in the new terminal, once.

## When no local copy is found

The dialog asks **"⎇ Where is \<project\> on this Mac?"** and fills in a suggested folder (your first code folder plus the project name). Type a path, then:

| Button | Does |
| --- | --- |
| **Use this folder** (or Enter) | Uses an existing copy. The folder must exist, be a git folder, and have this project as its `origin`. |
| **Clone here** | Clones the project into the folder over SSH, then starts the review. The folder must be new or empty. Cloning can take a few minutes. |
| **Back** | Returns to the list. |

The folder is remembered for this project, so you are only asked once.

## The review, step by step

The review is the `git-review:review-mr` skill. It runs in the new terminal and prints one short line per stage.

1. **Conflict check.** Reads the MR from GitLab. If the MR is not open, it asks whether to continue. If the MR has merge conflicts, it lists the conflicting files when GitLab shows them, notifies you ("\<project\> !\<number\> has merge conflicts; review stopped") and **stops**.
2. **Worktree.** Checks that the folder's `origin` is the MR's project (it stops if not). Fetches the MR into a separate working copy next to your project:
   - folder: `<your project folder>/../.mr-worktrees/<project folder name>-mr-<number>`;
   - branch: `review/mr-<number>`.

   If the worktree already exists, it is reused and updated. If the worktree's latest commit does not match the MR's, it tells you the MR moved since step 1. It then collects the list of changed files.
3. **Four checks at once.** Four helper agents run side by side (see [The four checks](#the-four-checks)).
4. **Report.** Everything goes into one report with a verdict (see [The report and the verdict](#the-report-and-the-verdict)). The summary and top findings are printed in the terminal, with the report's path.
5. **Notification.** A macOS notification "\<project\> !\<number\>: \<verdict\>", and a toast in your Claude Code sessions.
6. **Optional comment.** It asks whether to post the summary to the MR as one comment. The default is **don't post**. Before posting, it checks the comment holds no secret longer than its first 4 characters.
7. **Worktree clean-up.** It asks:
   - **Delete the worktree**: removes the folder and the `review/mr-<number>` branch. If removal is refused because of build output, it asks again before forcing it.
   - **Keep it**: says where it is. Opening the same MR from Git Review again reuses it.

Rules the review always follows:

- It never pushes, approves, merges, closes or changes the MR.
- It never commits in the worktree. The worktree is for reading, building and scanning only.
- It never deletes anything without asking: the worktree, its branch, or any Docker container or image it did not start.
- It never prints a secret in full, anywhere: only its first 4 characters followed by `…`.
- A missing tool or login is reported, not a reason to stop.

## The four checks

### A. Code review (the project's own)

The `git-review:mr-code-review` agent looks inside the worktree, including app folders such as `mobile/`, `ios/`, `android/`, `web/` and `backend/`, for the review kit the project ships with:

- Claude Code skills whose name or description mentions review, quality, audit, lint or governance;
- Claude Code agents whose name or description mentions review;
- slash commands with "review" in their name;
- review instructions in `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` or `docs/*review*`.

It reads them and applies them to the changed lines, using their own rules and severity scale. If a skill says to run a script or linter, it runs it read-only in the worktree, if that is safe and takes under 10 minutes. Findings come back in a table: severity (`blocker`, `high`, `medium`, `low`, `nit`), `file:line`, the finding and a suggested fix, plus up to 3 things done well.

**If the project has no review kit**, you are asked:

- **Run a generic review**: Claude Code's own `code-review` skill on the diff, or, if that is not available, a general review for bugs, security problems and missing tests;
- **Skip the code review.**

Either way the report says no review skills or agents were found.

### B. Pipelines and security scans

The `git-review:mr-pipelines` agent:

1. **Waits** for every pipeline of the MR's latest commit to finish, checking every 60 seconds, for up to **90 minutes**. If there is no pipeline for the latest commit, it uses the newest one and says so. It never retries, cancels or starts a pipeline.
2. **Lists failed jobs**, with the cause of each in one line, read from the end of the job log. It also notes skipped or manual jobs that matter, such as deploys or security jobs.
3. **Reads the security scans**: jobs for SAST, secret detection, dependency scanning and container scanning (names such as `sast`, `semgrep`, `secret`, `gitleaks`, `dependency`, `gemnasium`, `container`, `trivy`, `dast`, `mobsf`, `scan`). It reads their report files, or GitLab's summary when the files are missing. It counts findings by severity and lists every Critical and High one, saying whether its file is part of the MR. Every secret-detection finding is listed, shown by its first 4 characters only.

### C. Sonar

The `git-review:mr-sonar` agent first checks whether the project is set up for **SonarCloud** (in `sonar-project.properties`, Gradle or Maven files, or the GitLab CI file).

- **On SonarCloud**: it reads the MR's quality gate, measures (coverage, duplication, ratings, new bugs, vulnerabilities, code smells, hotspots), open issues and security hotspots. It signs in through the SonarQube connection in Claude Code if there is one, else `sonar api`, else `SONAR_TOKEN`. If none works, or SonarCloud has no analysis for the MR, it falls back to a local scan.
- **Local scan in Docker**: it starts a throwaway SonarQube Community server on a free port, scans the worktree with the Sonar scanner (skipping `node_modules`, `Pods`, `build`, `.dart_tool` and generated Dart files), keeps only issues in the MR's changed files, then removes the container it started, even after an error. If Docker is not running, it says so and skips the scan.

The local scan cannot check Swift, Objective-C or C/C++, has no coverage without test reports, and has no quality gate.

### D. Files and secrets

The `git-review:mr-files-secrets` agent runs a check that ships with the mod. It looks at **every commit** in the MR, not only the final changes, so something added and later removed is still caught.

| Group | Examples | Effect on the verdict |
| --- | --- | --- |
| **Secrets** | Anything gitleaks finds | Changes needed |
| **Sensitive files** | `.env` and `.env.*` (but not `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults`), `*.pem`, `*.key`, `*.p8`, `*.p12`, `*.pfx`, keystores, `key.properties`, provisioning profiles, SSH private keys, `credentials.json`, service-account JSON, `.netrc`, `.pgpass`, `.htpasswd`, password databases | Changes needed |
| **Build output** | `build/`, `dist/`, `node_modules/`, `Pods/`, `.dart_tool/`, `DerivedData/`, `.gradle/`, `.build/`, `__pycache__/`, `*.apk`, `*.aab`, `*.ipa`, Xcode archives, debug symbols, compiled files, generated Flutter files | Changes needed |
| **Warnings** | Local clutter (`.DS_Store`, `Thumbs.db`, `.idea/`, `*.iml`, `.vscode/settings.json`, `xcuserdata/`, `*.log`, `local.properties`, swap and backup files) and any file over **5 MB** | Listed only |
| **Suspicious** | Firebase configs, changes to `.gitleaks.toml`, `.gitleaksignore` or `.gitignore`, `.npmrc`, `.pypirc`, archives, `*.jar` (except `gradle-wrapper.jar`), SQL and database files, data dumps, `*.bak` / `*.orig` / `*.rej` / `*.tmp` leftovers, certificates, VPN profiles, executables and native libraries, files marked executable that are not scripts, binary files that are not normal assets | Listed only |

How the secret scan works:

- It uses the **target** branch's `.gitleaks.toml` and `.gitleaksignore`, so an MR cannot loosen the rules for itself. Without them, gitleaks' default rules are used.
- A line marked `gitleaks:allow` is still reported, under **Suspicious**.
- A value that is clearly a placeholder or a test value (for example in a test fixture folder) is moved to **Suspicious**. When unsure, it stays under Secrets.
- A secret is shown only by its first 4 characters plus `…`. The agent never opens the file to read more.

Each finding says whether it is **in the final changes** or **only in history**, how many commits touched it, and (for files) whether the target branch already has it. Under secrets the report says to rotate them, because they have been pushed to GitLab. For history-only secrets it adds that deleting the file is not enough: the branch history must be squashed or rewritten.

Paths that match the **Allowed paths** setting are not counted. They are listed under **Allowed by settings**, with the pattern that matched.

## The report and the verdict

The report is a Markdown file:

```
~/.claude/git-review/reports/<group>__<project>-mr-<number>-<YYYYMMDD-HHMM>.md
```

(the project path with each `/` written as `__`). Its sections:

1. **Summary**: title, author, branches, latest commit and the verdict. If secrets were found, the first line under the verdict is `🔑 <n> secret(s) found - rotate them`.
2. **Files and secrets**: from check D, merged with the pipeline's own secret detection. A finding both found is shown once, tagged "also found by CI"; one only the pipeline found is tagged "found by CI only".
3. **Pipelines and scans**: from check B.
4. **Sonar**: from check C, saying whether the results came from SonarCloud or a local scan.
5. **Code review**: from check A, or the generic review.
6. **Not checked**: anything skipped, and why.

| Verdict | When |
| --- | --- |
| **Approve** | Nothing blocking. |
| **Changes needed** | Any high-severity finding; a failed pipeline or quality gate; a security issue of high severity or worse; or a secret, sensitive file or build output from the files-and-secrets check. |
| **Blocked** | Merge conflicts, or the pipelines did not finish within 90 minutes. |

Warnings and suspicious files are listed but never change the verdict.

## Following a review from the dialog

While a review runs, it writes its progress to a small status file. Every Claude Code session with the mod reads these files once a minute:

- the MR's line in the dialog shows the current **stage**, then the **verdict** when it is done;
- when a verdict appears or changes, a toast says `Git Review <project>!<number>: <verdict>`.

## Slash commands

| Command | Does |
| --- | --- |
| `/git-review` | Opens the dialog. |
| `/git-review:review-mr <MR URL> [--allowed <patterns>]` | Runs the review directly. Use it in a local copy of the MR's project; `<patterns>` is a comma-separated list. The dialog runs this for you. |

## Settings

Set at install, and changed later in `/config` → git-review. They are read when the mod loads, so a change applies from the next session.

| Setting | Default | What it does |
| --- | --- | --- |
| **GitLab group** (`group`) | `example-group/example-subgroup` | The group whose open MRs are listed beside yours, subgroups included. A full `https://gitlab.com/...` address works too. |
| **Code folders** (`codeRoots`) | `~/Documents/Projects ~/Desktop ~/code ~/dev` | Where to look for local copies of a project. Separate with spaces or commas. The first one is also used for the suggested folder when none is found. |
| **Allowed paths** (`allowedPaths`) | empty | File patterns the files-and-secrets check allows in every project, for example `google-services.json`. Separate with spaces or commas. Matches still appear in the report under "Allowed by settings". |

Inside the dialog, your filters apply while it is open, and your folded groups are remembered.

## What it stores and where

| What | Where |
| --- | --- |
| The local folder chosen for each project, and folded groups | The mod's own store, on your machine. |
| Review progress (stage, verdict, report path) | `~/.claude/git-review/status/<group>__<project>__<number>.json` |
| Review reports | `~/.claude/git-review/reports/` |
| Review worktrees | `.mr-worktrees/` beside your project folder, until you delete them. |
| Review branches | `review/mr-<number>` in your local copy, until you delete them. |
| Docker | The local Sonar scan downloads the `sonarqube:community` and `sonarsource/sonar-scanner-cli` images the first time. It removes its container afterwards; the images stay. |

Nothing is posted to GitLab unless you say yes to the comment in step 6.

## Turning it off or hiding it

The **Mods** panel (`/mods`, from the mod-manager mod) has a switch for Git Review:

- **Off**: the button goes away in every chat within about 3 seconds. `/git-review` answers "Git Review is off. Turn it on in /mods."
- **Hidden**: the mod keeps working but draws no button.

Git Review shares the status-bar layout with the other mods in this collection: every mod's button sits in one three-row grid at the right edge of the status bar, in a fixed order.

## Limits and good to know

- **gitlab.com only.** MR addresses and project remotes are matched against `gitlab.com`.
- **List size.** Up to 100 MRs assigned to you, 100 waiting for your review, and 500 from the group (5 pages of 100).
- **The pipeline mark** shows the MR's newest pipeline only. States other than passed, failed and running show as `·`, and only the **Any** pipeline filter shows them.
- **Reviews take time.** The pipeline check alone can wait up to 90 minutes, and a local Sonar scan several minutes more.
- **The review runs in Claude Code's auto permission mode** (`--permission-mode auto`) in the new terminal.
- **The worktree** is kept until you choose to delete it. Opening the same MR again reuses it.
- If the dialog shows `Could not load merge requests`, run `glab auth login` and press **Refresh**.

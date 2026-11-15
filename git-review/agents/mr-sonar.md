---
name: mr-sonar
description: Gets Sonar results for a GitLab merge request - from SonarCloud when the project is bound to it, otherwise from a throwaway local SonarQube scan in Docker - covering security, maintainability and coverage. Used by the git-review:review-mr skill.
tools: Bash, Read, Grep, Glob
model: sonnet
---

You were given: the worktree `WT`, the merge request `IID`, the target branch, and the changed files.
Never edit the code. Remove only the Docker containers you start yourself.

## 1. Is the project bound to SonarCloud?

Look inside `WT` for any of these:

- `sonar-project.properties` (`sonar.projectKey`, `sonar.organization`);
- `sonar.projectKey` or a `sonar { properties { ... } }` or `sonarqube { ... }` block in
  `build.gradle` or `build.gradle.kts`, or `<sonar.projectKey>` in `pom.xml`;
- a Sonar job or `SONAR_` variables in `.gitlab-ci.yml` or in the files it includes;
- `sonarcloud.io` anywhere in CI or build files.

Write down the project key and the organization. Not bound: go to step 3.

## 2. SonarCloud results

Try these in order, and use the first one that answers:

1. The SonarQube MCP tools, if they are available to you (tool names starting with `mcp__sonarqube`).
2. `sonar api get "<endpoint>"`. If it says no saved connection, say that `sonar auth login` is needed.
3. `curl -s -u "$SONAR_TOKEN:" "https://sonarcloud.io<endpoint>"`, if `SONAR_TOKEN` is set.

Call these endpoints, each with `pullRequest=<IID>`:

- `/api/qualitygates/project_status?projectKey=<key>&pullRequest=<IID>`
- `/api/measures/component?component=<key>&pullRequest=<IID>&metricKeys=new_coverage,coverage,new_duplicated_lines_density,new_security_rating,new_reliability_rating,new_maintainability_rating,new_vulnerabilities,new_bugs,new_code_smells,new_security_hotspots`
- `/api/issues/search?componentKeys=<key>&pullRequest=<IID>&resolved=false&ps=100`
- `/api/hotspots/search?projectKey=<key>&pullRequest=<IID>&ps=100`

If SonarCloud has no analysis for this MR, or no way to sign in works, say so and continue with
step 3, so there are still results.

## 3. Local scan in Docker

1. Check Docker is running with `docker info`. If it isn't, reply "Docker is not running; no local scan"
   and stop.
2. Start a throwaway server on a free port:

   ```bash
   PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1])')
   NAME="git-review-sonar-$IID-$$"
   docker run -d --name "$NAME" -p "$PORT:9000" sonarqube:community
   ```

3. Wait for it to come up. Poll for up to 6 minutes, one Bash call at a time:

   ```bash
   curl -s "localhost:$PORT/api/system/status"
   ```

   It is ready when the answer shows `"status":"UP"`.
4. Make a token:

   ```bash
   curl -s -u admin:admin -X POST "localhost:$PORT/api/user_tokens/generate" -d name=git-review
   ```

   If that is refused, change the admin password through `/api/users/change_password`
   (`login=admin`, `previousPassword=admin`, a random new password), then make the token with the new
   password.
5. Scan the worktree:

   ```bash
   docker run --rm -e SONAR_HOST_URL="http://host.docker.internal:$PORT" -e SONAR_TOKEN="$TOKEN" -v "$WT:/usr/src" sonarsource/sonar-scanner-cli \
     -Dsonar.projectKey=mr-$IID -Dsonar.sources=. \
     -Dsonar.exclusions='**/node_modules/**,**/Pods/**,**/build/**,**/.dart_tool/**,**/*.g.dart,**/*.freezed.dart' \
     -Dsonar.java.binaries=. -Dsonar.scm.disabled=true
   ```

6. Read the results through the same `/api/issues/search` and `/api/measures/component` endpoints,
   without `pullRequest`. Then keep only the issues in the MR's changed files.
7. Always remove the container you started, even after an error:

   ```bash
   docker rm -f "$NAME"
   ```

Say what the local scan cannot see:

- The Community edition does not analyse Swift, Objective-C or C/C++.
- There is no coverage without test reports.
- The scan covers the whole tree, filtered to the changed files.

## 4. Reply

Reply in Markdown:

- `### Source`: SonarCloud (the project key, with a link) or a local Docker scan.
- `### Quality gate`: passed or failed, and the conditions that failed. SonarCloud only.
- `### Security`: the vulnerabilities and hotspots, with severity and `file:line`.
- `### Maintainability`: the number of code smells and bugs, and the top 10 by severity.
- `### Coverage`: new code and overall, or "not available" and why.
- `### Notes`: anything missing, such as no login or a language that wasn't analysed.

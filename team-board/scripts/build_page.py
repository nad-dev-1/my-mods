"""Builds dashboard/team-board.html: the page with the shared rules (hooks/core.js) inlined."""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
server = sys.argv[1] if len(sys.argv) > 1 else 'Atlassian MCP'
core = (root / 'hooks/core.js').read_text()
core = re.sub(r'^export (const|function|let) ', r'\1 ', core, flags=re.M)
page = (root / 'dashboard/page.html').read_text()
assert page.count('/*@@CORE@@*/') == 1
out = page.replace('/*@@CORE@@*/', core).replace('@@JIRA_SERVER@@', server)
(root / 'dashboard/team-board.html').write_text(out)
print('built', len(out), 'bytes, Jira server name:', server)

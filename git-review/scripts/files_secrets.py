#!/usr/bin/env python3
"""Files-and-secrets check for one merge request checked out in a worktree.

Looks at every commit in BASE..HEAD (not only the final diff) for:
  - secrets (gitleaks, using the TARGET branch's .gitleaks.toml / .gitleaksignore),
  - sensitive files, build output, local clutter, oversized files,
  - suspicious files.

Prints one JSON object on stdout. A secret's value never leaves this process
in full: only its first 4 characters followed by an ellipsis.

Usage: files_secrets.py --wt <worktree> --base <origin/target> [--allowed "a,b"] [--max-mb 5]
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import subprocess
import sys
import tempfile

SHOWN_CHARS = 4

# Each rule: (glob, reason). A glob with a "/" at its end matches a folder anywhere in the path.
SENSITIVE = [
    ('.env', 'environment file'),
    ('.env.*', 'environment file'),
    ('*.pem', 'private key or certificate'),
    ('*.key', 'private key'),
    ('*.p8', 'private key (Apple)'),
    ('*.p12', 'certificate bundle with private key'),
    ('*.pfx', 'certificate bundle with private key'),
    ('*.jks', 'Java keystore'),
    ('*.keystore', 'keystore'),
    ('key.properties', 'Android signing properties'),
    ('*.mobileprovision', 'iOS provisioning profile'),
    ('*.provisionprofile', 'macOS provisioning profile'),
    ('id_rsa', 'SSH private key'),
    ('id_dsa', 'SSH private key'),
    ('id_ecdsa', 'SSH private key'),
    ('id_ed25519', 'SSH private key'),
    ('*.ppk', 'PuTTY private key'),
    ('credentials.json', 'credentials file'),
    ('credentials', 'credentials file'),
    ('serviceAccount*.json', 'service-account key'),
    ('service-account*.json', 'service-account key'),
    ('*-service-account.json', 'service-account key'),
    ('*.kdbx', 'password database'),
    ('.netrc', 'login credentials'),
    ('.pgpass', 'database passwords'),
    ('.htpasswd', 'password file'),
]
# Example files that are meant to be committed.
SENSITIVE_EXCEPT = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults']

BUILD = [
    ('build/', 'build output'),
    ('.dart_tool/', 'Dart tool output'),
    ('node_modules/', 'dependency folder'),
    ('Pods/', 'CocoaPods dependency folder'),
    ('dist/', 'build output'),
    ('DerivedData/', 'Xcode build output'),
    ('.gradle/', 'Gradle cache'),
    ('.build/', 'Swift build output'),
    ('__pycache__/', 'Python cache'),
    ('*.apk', 'Android app binary'),
    ('*.aab', 'Android app bundle'),
    ('*.ipa', 'iOS app binary'),
    ('*.xcarchive/', 'Xcode archive'),
    ('*.dSYM/', 'debug symbols'),
    ('*.class', 'compiled Java class'),
    ('*.o', 'object file'),
    ('*.pyc', 'Python bytecode'),
    ('Generated.xcconfig', 'Flutter generated file'),
    ('flutter_export_environment.sh', 'Flutter generated file'),
    ('.flutter-plugins', 'Flutter generated file'),
    ('.flutter-plugins-dependencies', 'Flutter generated file'),
]

CLUTTER = [
    ('.DS_Store', 'macOS folder metadata'),
    ('Thumbs.db', 'Windows thumbnail cache'),
    ('.idea/', 'IDE settings'),
    ('*.iml', 'IDE module file'),
    ('.vscode/settings.json', 'personal editor settings'),
    ('xcuserdata/', 'personal Xcode settings'),
    ('*.xcuserstate', 'personal Xcode state'),
    ('*.log', 'log file'),
    ('local.properties', 'machine-local Android paths'),
    ('*.swp', 'editor swap file'),
    ('*~', 'editor backup file'),
]

SUSPICIOUS = [
    ('google-services.json', 'Firebase config (often committed on purpose)'),
    ('GoogleService-Info.plist', 'Firebase config (often committed on purpose)'),
    ('.gitleaks.toml', 'changes the secret-scan rules'),
    ('.gitleaksignore', 'changes which secrets are ignored'),
    ('.gitignore', 'changes which files git ignores'),
    ('.npmrc', 'may hold a registry token'),
    ('.pypirc', 'may hold a registry token'),
    ('*.zip', 'archive'),
    ('*.tar', 'archive'),
    ('*.tar.gz', 'archive'),
    ('*.tgz', 'archive'),
    ('*.7z', 'archive'),
    ('*.rar', 'archive'),
    ('*.jar', 'Java archive'),
    ('*.sql', 'SQL file (could be a data dump)'),
    ('*.dump', 'data dump'),
    ('*.sqlite', 'database file'),
    ('*.sqlite3', 'database file'),
    ('*.db', 'database file'),
    ('*.bak', 'backup leftover'),
    ('*.orig', 'merge leftover'),
    ('*.rej', 'patch leftover'),
    ('*.tmp', 'temporary file'),
    ('*.cer', 'certificate'),
    ('*.crt', 'certificate'),
    ('*.der', 'certificate'),
    ('*.ovpn', 'VPN profile'),
    ('*.exe', 'executable'),
    ('*.dll', 'native library'),
    ('*.so', 'native library'),
    ('*.dylib', 'native library'),
    ('*.bin', 'binary blob'),
]
SUSPICIOUS_EXCEPT = ['gradle-wrapper.jar']

# Binary files with these extensions are normal assets, not suspicious.
ASSET_EXT = {
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'icns', 'bmp', 'heic', 'tiff',
    'ttf', 'otf', 'woff', 'woff2', 'eot', 'pdf', 'mp3', 'mp4', 'wav', 'm4a', 'aac', 'ogg',
    'mov', 'webm', 'riv', 'lottie', 'json', 'car', 'strings', 'jar', 'zip',
}
# Files that are expected to be executable.
EXEC_OK_EXT = {'sh', 'bash', 'zsh', 'py', 'rb', 'pl', 'js', 'mjs', 'ts', 'command'}
EXEC_OK_NAME = {'gradlew', 'mvnw', 'configure', 'pre-commit', 'pre-push', 'commit-msg'}

TEST_HINTS = ('test', 'spec', 'mock', 'fixture', 'example', 'sample', 'fake', 'dummy', 'stub')


def git(wt: str, *args: str, check: bool = True) -> str:
    r = subprocess.run(['git', '-C', wt, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")

    return r.stdout


def git_bytes(wt: str, *args: str) -> bytes | None:
    r = subprocess.run(['git', '-C', wt, *args], capture_output=True)

    return r.stdout if r.returncode == 0 else None


def matches(path: str, glob: str) -> bool:
    """A glob ending in "/" matches a folder anywhere in the path; others match the path or its basename."""
    parts = path.split('/')
    if glob.endswith('/'):
        g = glob[:-1]
        if '/' in g:
            return f'/{g}/' in f'/{path}'

        return any(fnmatch.fnmatchcase(p, g) for p in parts[:-1])
    if '/' in glob:
        return path == glob or path.endswith(f'/{glob}')

    return fnmatch.fnmatchcase(parts[-1], glob)


def first_match(path: str, rules: list[tuple[str, str]], exceptions: list[str] = ()) -> tuple[str, str] | None:
    if any(matches(path, e) for e in exceptions):
        return None
    for glob, reason in rules:
        if matches(path, glob):
            return glob, reason

    return None


def is_allowed(path: str, allowed: list[str]) -> str | None:
    for a in allowed:
        if matches(path, a) or fnmatch.fnmatchcase(path, a):
            return a

    return None


def shown(secret: str) -> str:
    return f'{secret[:SHOWN_CHARS]}…' if secret else ''


def collect_changes(wt: str, base: str):
    """Every path any commit in base..HEAD touched, with its commits, modes and blobs."""
    out = git(wt, 'log', '--no-renames', '--raw', '--no-abbrev', '--format=commit %H', f'{base}..HEAD')
    commits: list[str] = []
    touched: dict[str, dict] = {}
    current = ''
    for line in out.splitlines():
        if line.startswith('commit '):
            current = line.split()[1]
            commits.append(current)
            continue
        if not line.startswith(':'):
            continue
        meta, path = line.split('\t', 1)
        _, new_mode, _, new_blob, status = meta[1:].split(' ')
        t = touched.setdefault(path, {'commits': [], 'modes': set(), 'blobs': set(), 'statuses': set()})
        t['commits'].append(current)
        t['statuses'].add(status[0])
        if status[0] != 'D':
            t['modes'].add(new_mode)
            t['blobs'].add(new_blob)

    return commits, touched


def final_changes(wt: str, base: str) -> tuple[set[str], set[str]]:
    """(paths added/changed by the MR as it stands, paths whose final version is binary)."""
    mb = git(wt, 'merge-base', base, 'HEAD').strip()
    present: set[str] = set()
    for line in git(wt, 'diff', '--no-renames', '--name-status', mb, 'HEAD').splitlines():
        status, path = line.split('\t', 1)
        if status[0] in 'AMT':
            present.add(path)
    binary: set[str] = set()
    for line in git(wt, 'diff', '--no-renames', '--numstat', mb, 'HEAD').splitlines():
        added, deleted, path = line.split('\t', 2)
        if added == '-' and deleted == '-':
            binary.add(path)

    return present, binary


def in_base(wt: str, base: str, path: str) -> bool:
    return subprocess.run(['git', '-C', wt, 'cat-file', '-e', f'{base}:{path}'], capture_output=True).returncode == 0


def blob_size(wt: str, blob: str) -> int:
    try:
        return int(git(wt, 'cat-file', '-s', blob).strip())
    except (RuntimeError, ValueError):
        return 0


def check_files(wt: str, base: str, touched: dict, present: set[str], binary: set[str], allowed: list[str], max_bytes: int):
    groups: dict[str, list] = {'sensitive': [], 'build': [], 'clutter': [], 'large': [], 'suspicious': [], 'allowed': []}

    def add(group: str, path: str, reason: str, extra: dict | None = None):
        t = touched[path]
        item = {
            'path': path,
            'reason': reason,
            'where': 'final' if path in present else 'history-only',
            'commits': len(set(t['commits'])),
            'alreadyInTarget': in_base(wt, base, path),
        }
        if extra:
            item.update(extra)
        rule = is_allowed(path, allowed)
        if rule:
            groups['allowed'].append({**item, 'group': group, 'allowedBy': rule})
        else:
            groups[group].append(item)

    for path in sorted(touched):
        t = touched[path]
        if not t['blobs']:
            continue  # only ever deleted by this MR
        hit = first_match(path, SENSITIVE, SENSITIVE_EXCEPT)
        if hit:
            add('sensitive', path, hit[1])
            continue
        hit = first_match(path, BUILD)
        if hit:
            add('build', path, hit[1])
            continue
        hit = first_match(path, CLUTTER)
        if hit:
            add('clutter', path, hit[1])
        size = max((blob_size(wt, b) for b in t['blobs']), default=0)
        if size > max_bytes:
            add('large', path, f'{size / 1_048_576:.1f} MB', {'bytes': size})
        if hit:
            continue
        hit = first_match(path, SUSPICIOUS, SUSPICIOUS_EXCEPT)
        if hit:
            add('suspicious', path, hit[1])
            continue
        name = path.rsplit('/', 1)[-1]
        ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
        if '100755' in t['modes'] and ext not in EXEC_OK_EXT and name not in EXEC_OK_NAME:
            add('suspicious', path, 'has the executable bit')
        elif path in binary and ext not in ASSET_EXT:
            add('suspicious', path, 'binary file in the source tree')

    return groups


def find_gitleaks() -> str | None:
    found = shutil.which('gitleaks')
    if found:
        return found
    for p in ('/opt/homebrew/bin/gitleaks', '/usr/local/bin/gitleaks'):
        if os.access(p, os.X_OK):
            return p

    return None


def scan_secrets(wt: str, base: str, present: set[str], allowed: list[str]) -> dict:
    exe = find_gitleaks()
    if not exe:
        return {'status': 'missing', 'fix': 'brew install gitleaks', 'findings': [], 'allowed': []}

    env = {k: v for k, v in os.environ.items() if k not in ('GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML')}
    with tempfile.TemporaryDirectory(prefix='git-review-gitleaks-') as tmp:
        # Rules come from the TARGET branch, so the MR cannot loosen them for itself.
        cfg_path = os.path.join(tmp, 'gitleaks.toml')
        target_cfg = git_bytes(wt, 'show', f'{base}:.gitleaks.toml')
        config_source = f'{base}:.gitleaks.toml' if target_cfg is not None else 'gitleaks default rules'
        with open(cfg_path, 'wb') as f:
            f.write(target_cfg if target_cfg is not None else b'[extend]\nuseDefault = true\n')
        ignore_dir = os.path.join(tmp, 'ignore')
        os.mkdir(ignore_dir)
        target_ignore = git_bytes(wt, 'show', f'{base}:.gitleaksignore')
        if target_ignore is not None:
            with open(os.path.join(ignore_dir, '.gitleaksignore'), 'wb') as f:
                f.write(target_ignore)

        r = subprocess.run(
            [exe, 'git', wt, '--log-opts', f'{base}..HEAD', '--config', cfg_path, '--gitleaks-ignore-path', ignore_dir,
             '--ignore-gitleaks-allow', '--report-format', 'json', '--report-path', '-', '--no-banner',
             '--log-level', 'error', '--exit-code', '0'],
            capture_output=True, text=True, env=env, cwd=tmp,
        )
    if r.returncode != 0:
        return {'status': 'error', 'error': r.stderr.strip()[-500:], 'findings': [], 'allowed': []}

    raw = json.loads(r.stdout or '[]')
    head_text: dict[str, str] = {}

    def in_head(path: str, secret: str) -> bool:
        if path not in present:
            return False
        if path not in head_text:
            b = git_bytes(wt, 'show', f'HEAD:{path}')
            head_text[path] = b.decode('utf-8', 'replace') if b is not None else ''

        return bool(secret) and secret in head_text[path]

    def line_at(commit: str, path: str, n: int) -> str:
        """The finding's line as that commit has it (gitleaks' git mode does not report it)."""
        b = git_bytes(wt, 'show', f'{commit}:{path}') if commit and n > 0 else None
        lines = b.decode('utf-8', 'replace').splitlines() if b is not None else []

        return lines[n - 1] if n <= len(lines) else ''

    merged: dict[tuple, dict] = {}
    for f in raw:
        secret = f.get('Secret') or ''
        path = f.get('File') or ''
        key = (path, f.get('RuleID'), secret)
        item = merged.get(key)
        if item is None:
            low = path.lower()
            item = merged[key] = {
                'rule': f.get('RuleID'),
                'description': f.get('Description'),
                'path': path,
                'line': f.get('StartLine'),
                'shown': shown(secret),
                'where': 'final' if in_head(path, secret) else 'history-only',
                'commits': [],
                'inlineAllow': False,
                'pathLooksLikeTest': any(h in low for h in TEST_HINTS),
                'entropy': round(f.get('Entropy') or 0, 2),
            }
        item['commits'].append((f.get('Commit') or '')[:10])
        if not item['inlineAllow'] and 'gitleaks:allow' in line_at(f.get('Commit') or '', path, f.get('StartLine') or 0):
            item['inlineAllow'] = True
        # Nothing else from the raw finding (Secret, Match, Line) is kept.

    findings, allowed_hits = [], []
    for item in merged.values():
        item['commits'] = sorted(set(item['commits']))
        rule = is_allowed(item['path'], allowed)
        if rule:
            allowed_hits.append({**item, 'allowedBy': rule})
        else:
            findings.append(item)

    return {'status': 'ok', 'config': config_source, 'findings': findings, 'allowed': allowed_hits}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--wt', required=True)
    ap.add_argument('--base', required=True, help='the target branch ref, e.g. origin/main')
    ap.add_argument('--allowed', default='', help='comma- or space-separated path globs allowed in every project')
    ap.add_argument('--max-mb', type=float, default=5)
    a = ap.parse_args(argv)

    allowed = [x for x in a.allowed.replace(',', ' ').split() if x]
    commits, touched = collect_changes(a.wt, a.base)
    present, binary = final_changes(a.wt, a.base)
    files = check_files(a.wt, a.base, touched, present, binary, allowed, int(a.max_mb * 1_048_576))
    secrets = scan_secrets(a.wt, a.base, present, allowed)

    blocking_secrets = [s for s in secrets['findings'] if not s['inlineAllow']]
    result = {
        'base': a.base,
        'commitsScanned': len(commits),
        'pathsTouched': len(touched),
        'allowedSetting': allowed,
        'secrets': secrets,
        'files': files,
        'changesNeeded': bool(blocking_secrets or files['sensitive'] or files['build']),
    }
    json.dump(result, sys.stdout, indent=1)
    print()

    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

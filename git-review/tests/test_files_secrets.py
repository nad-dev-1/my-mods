"""Tests for scripts/files_secrets.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'"""

import json
import os
import random
import shutil
import string
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'scripts', 'files_secrets.py')
HAS_GITLEAKS = bool(shutil.which('gitleaks') or os.access('/opt/homebrew/bin/gitleaks', os.X_OK))


def fake_aws_key() -> str:
    # Built at run time so this test file never holds a secret-shaped string.
    rnd = random.Random(7)

    return 'AKIA' + ''.join(rnd.choice('ABCDEFGHJKLMNPQRSTUVWXYZ234567') for _ in range(16))


def fake_github_token() -> str:
    rnd = random.Random(11)

    return 'gh' + 'p_' + ''.join(rnd.choice(string.ascii_letters + string.digits) for _ in range(36))


class Repo:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix='fs-test-')
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 't@example.invalid')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'commit.gpgsign', 'false')

    def git(self, *args):
        return subprocess.run(['git', '-C', self.dir, *args], check=True, capture_output=True, text=True).stdout

    def write(self, path, content, mode=None):
        full = os.path.join(self.dir, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'wb') as f:
            f.write(content if isinstance(content, bytes) else content.encode())
        if mode:
            os.chmod(full, mode)

    def remove(self, path):
        self.git('rm', '-q', path)

    def commit(self, msg):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', msg)

    def run(self, allowed='', base='main'):
        r = subprocess.run([sys.executable, SCRIPT, '--wt', self.dir, '--base', base, '--allowed', allowed, '--max-mb', '1'],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise AssertionError(r.stderr)

        return json.loads(r.stdout), r.stdout

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def paths(items):
    return sorted(i['path'] for i in items)


class FilesSecretsTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        r = self.repo
        r.write('README.md', 'hello\n')
        r.write('local.properties', 'sdk.dir=/x\n')  # tracked on main already
        r.commit('base')
        r.git('checkout', '-q', '-b', 'feature')

    def tearDown(self):
        self.repo.cleanup()

    def test_clean_mr_needs_no_changes(self):
        self.repo.write('lib/main.dart', 'void main() {}\n')
        self.repo.commit('code')
        out, _ = self.repo.run()
        self.assertFalse(out['changesNeeded'])
        self.assertEqual(out['commitsScanned'], 1)
        for group in out['files'].values():
            self.assertEqual(group, [])

    def test_groups_each_kind_of_file(self):
        r = self.repo
        r.write('.env', 'X=1\n')
        r.write('.env.example', 'X=\n')
        r.write('android/app/upload.jks', b'\x00\x01')
        r.write('build/app/output.txt', 'x\n')
        r.write('app-release.apk', b'\x00apk')
        r.write('.DS_Store', b'\x00\x00')
        r.write('.idea/workspace.xml', '<x/>\n')
        r.write('android/app/google-services.json', '{}\n')
        r.write('db/backup.sql', 'select 1;\n')
        r.write('tools/run', 'echo hi\n', mode=0o755)
        r.write('scripts/ok.sh', 'echo hi\n', mode=0o755)
        r.write('assets/blob.dat', b'\x00\x01\x02\x03' * 10)
        r.write('assets/logo.png', b'\x89PNG\x00\x01')
        r.write('assets/big.txt', 'a' * (1_048_576 + 10))
        r.commit('lots')
        out, _ = r.run()
        f = out['files']
        self.assertEqual(paths(f['sensitive']), ['.env', 'android/app/upload.jks'])
        self.assertEqual(paths(f['build']), ['app-release.apk', 'build/app/output.txt'])
        self.assertEqual(paths(f['clutter']), ['.DS_Store', '.idea/workspace.xml'])
        self.assertEqual(paths(f['large']), ['assets/big.txt'])
        self.assertEqual(paths(f['suspicious']), ['android/app/google-services.json', 'assets/blob.dat', 'db/backup.sql', 'tools/run'])
        self.assertTrue(out['changesNeeded'])

    def test_file_removed_later_is_history_only(self):
        r = self.repo
        r.write('.env', 'X=1\n')
        r.commit('add env')
        r.remove('.env')
        r.commit('remove env')
        out, _ = r.run()
        self.assertEqual(len(out['files']['sensitive']), 1)
        item = out['files']['sensitive'][0]
        self.assertEqual(item['where'], 'history-only')
        self.assertEqual(item['commits'], 2)
        self.assertTrue(out['changesNeeded'])

    def test_file_already_on_target_is_marked(self):
        self.repo.write('local.properties', 'sdk.dir=/y\n')
        self.repo.commit('touch local.properties')
        out, _ = self.repo.run()
        self.assertEqual(paths(out['files']['clutter']), ['local.properties'])
        self.assertTrue(out['files']['clutter'][0]['alreadyInTarget'])

    def test_allowed_paths_are_listed_not_counted(self):
        self.repo.write('android/app/google-services.json', '{}\n')
        self.repo.write('.env', 'X=1\n')
        self.repo.commit('cfg')
        out, _ = self.repo.run(allowed='google-services.json, .env')
        self.assertEqual(out['files']['suspicious'], [])
        self.assertEqual(out['files']['sensitive'], [])
        self.assertEqual(sorted((a['path'], a['group'], a['allowedBy']) for a in out['files']['allowed']),
                         [('.env', 'sensitive', '.env'), ('android/app/google-services.json', 'suspicious', 'google-services.json')])
        self.assertFalse(out['changesNeeded'])

    def test_gitleaks_rule_changes_are_suspicious(self):
        self.repo.write('.gitleaksignore', 'abc:def:1\n')
        self.repo.commit('ignore')
        out, _ = self.repo.run()
        self.assertEqual(paths(out['files']['suspicious']), ['.gitleaksignore'])


@unittest.skipUnless(HAS_GITLEAKS, 'gitleaks not installed')
class SecretsTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.repo.write('README.md', 'hello\n')
        self.repo.commit('base')
        self.repo.git('checkout', '-q', '-b', 'feature')

    def tearDown(self):
        self.repo.cleanup()

    def test_secret_in_final_changes_shows_only_four_chars(self):
        key = fake_aws_key()
        self.repo.write('lib/config.dart', f'const awsKey = "{key}";\n')
        self.repo.commit('key')
        out, raw = self.repo.run()
        s = out['secrets']
        self.assertEqual(s['status'], 'ok')
        self.assertEqual(s['config'], 'gitleaks default rules')
        self.assertEqual(len(s['findings']), 1)
        f = s['findings'][0]
        self.assertEqual(f['path'], 'lib/config.dart')
        self.assertEqual(f['line'], 1)
        self.assertEqual(f['where'], 'final')
        self.assertEqual(f['shown'], key[:4] + '…')
        self.assertNotIn(key, raw)
        self.assertNotIn(key[4:], raw)
        self.assertTrue(out['changesNeeded'])

    def test_secret_removed_later_is_history_only(self):
        tok = fake_github_token()
        self.repo.write('lib/api.dart', f'const t = "{tok}";\n')
        self.repo.commit('add token')
        self.repo.write('lib/api.dart', 'const t = String.fromEnvironment("T");\n')
        self.repo.commit('remove token')
        out, raw = self.repo.run()
        f = out['secrets']['findings']
        self.assertEqual(len(f), 1)
        self.assertEqual(f[0]['where'], 'history-only')
        self.assertNotIn(tok, raw)
        self.assertTrue(out['changesNeeded'])

    def test_mr_cannot_silence_itself_with_its_own_gitleaksignore_or_inline_allow(self):
        key = fake_aws_key()
        self.repo.write('lib/a.dart', f'const k = "{key}"; // gitleaks:allow\n')
        self.repo.write('.gitleaks.toml', '[allowlist]\npaths = [".*"]\n')
        self.repo.commit('try to hide')
        out, _ = self.repo.run()
        f = out['secrets']['findings']
        self.assertEqual(len(f), 1)
        self.assertTrue(f[0]['inlineAllow'])
        self.assertEqual(out['secrets']['config'], 'gitleaks default rules')
        self.assertIn('.gitleaks.toml', paths(out['files']['suspicious']))

    def test_target_branch_gitleaks_config_is_used(self):
        r = self.repo
        r.git('checkout', '-q', 'main')
        r.write('.gitleaks.toml', '[extend]\nuseDefault = true\n[allowlist]\npaths = ["^fixtures/"]\n')
        r.commit('rules on main')
        r.git('checkout', '-q', 'feature')
        r.git('rebase', '-q', 'main')
        key = fake_aws_key()
        r.write('fixtures/k.txt', f'{key}\n')
        r.write('lib/k.dart', f'const k = "{key}";\n')
        r.commit('keys')
        out, _ = r.run()
        self.assertEqual(out['secrets']['config'], 'main:.gitleaks.toml')
        self.assertEqual(paths(out['secrets']['findings']), ['lib/k.dart'])

    def test_allowed_path_moves_secret_to_allowed(self):
        self.repo.write('lib/k.dart', f'const k = "{fake_aws_key()}";\n')
        self.repo.commit('key')
        out, _ = self.repo.run(allowed='lib/k.dart')
        self.assertEqual(out['secrets']['findings'], [])
        self.assertEqual(len(out['secrets']['allowed']), 1)
        self.assertFalse(out['changesNeeded'])


if __name__ == '__main__':
    unittest.main()

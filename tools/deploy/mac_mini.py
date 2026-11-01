#!/usr/bin/env python3
"""Private, serialized main-commit deployment with an activation gate and verified rollback."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request


class DeployError(RuntimeError):
    """A sanitized, actionable deployment failure."""


class RecoveryError(DeployError):
    """Runtime/data recovery is unresolved; newer commits must not be attempted."""


def queued_commits(deployed, commits):
    """Keep first-parent history order and never redeploy a successful revision."""
    return [sha for sha in commits if sha != deployed]


def checked_revision(value):
    """Accept only full immutable Git object identifiers, never command-line options."""
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise DeployError('Expected a full Git commit SHA')
    return value


def write_json(path, value):
    """Publish state atomically; interrupted writes leave the previous state readable."""
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


class Deployer:
    """Host-controlled worker: Git transport and loopback Docker only, no public webhook."""
    def __init__(self, config_path):
        self.config_path = Path(config_path).resolve()
        self.config = json.loads(self.config_path.read_text())
        self.root = Path(self.config['state_dir']).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.repo = Path(self.config['repo']).resolve()
        self.state_path = self.root / 'deployment-state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.log = None
        self.project = self.config.get('project', 'fredy')
        self.port = int(self.config.get('port', 9998))
        self.db_volume = f'{self.project}_fredy_db'
        self.conf_volume = f'{self.project}_fredy_conf'

    def reload_state(self):
        """Read deployment decisions only after taking the cross-process lock."""
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def run(self, args, *, cwd=None, env=None, capture=False, timeout=1800):
        """Commands never contain credentials; provider secrets travel only in process environment."""
        options = {'cwd': cwd, 'env': env, 'timeout': timeout, 'text': True}
        if capture:
            options.update(stdout=subprocess.PIPE, stderr=self.log or subprocess.DEVNULL)
        else:
            options.update(stdout=self.log, stderr=self.log)
        result = subprocess.run(args, **options)
        if result.returncode:
            raise DeployError(f'Command failed ({result.returncode}): {args[0]} {args[1]}')
        return result.stdout.strip() if capture else None

    def docker(self, *args, **kwargs):
        return self.run(['docker', '--context', 'orbstack', *args], **kwargs)

    def git(self, *args):
        return self.run(['git', '-C', str(self.repo), *args], capture=True, timeout=120)

    def compose(self, path, *args):
        return self.docker('compose', '-p', self.project, '-f', str(path), *args, env=self.runtime_env())

    def runtime_env(self):
        """Read only the user's personal key; never persist a credential in config or logs."""
        env = os.environ.copy()
        if not env.get('OPENROUTER_API_KEY_PERSONAL'):
            result = subprocess.run(['security', 'find-generic-password', '-s', 'OPENROUTER_API_KEY_PERSONAL', '-w'],
                                    capture_output=True, text=True, timeout=15)
            if result.returncode == 0:
                env['OPENROUTER_API_KEY_PERSONAL'] = result.stdout.rstrip('\n')
        return env

    def fetch_queue(self):
        self.git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/fredy/main')
        head = checked_revision(self.git('rev-parse', 'refs/fredy/main'))
        old = self.state.get('deployed')
        if not old:
            return [head]
        checked_revision(old)
        # A force push is a recovery decision, never an excuse to erase deployment history.
        self.git('merge-base', '--is-ancestor', old, head)
        return queued_commits(old, self.git('rev-list', '--first-parent', '--reverse', f'{old}..{head}').splitlines())

    def archive(self, sha, target):
        """Use a detached clone with no shared working-tree edits or untracked files."""
        self.run(['git', 'clone', '--no-hardlinks', '--no-checkout', '--quiet', str(self.repo), str(target)], timeout=120)
        self.run(['git', '-C', str(target), 'checkout', '--detach', '--quiet', checked_revision(sha)], timeout=120)
        # These are not needed in the Docker context or tests, and remove local path remotes.
        shutil.rmtree(target / '.git')

    def validate_source(self, source):
        """Require main to contain a protected live overlay before replacing its running image."""
        protected = ['automatic_deployment_hold', 'worktree_source_digest', 'worktree_source_manifest']
        if not any(key in self.state for key in protected):
            return
        try:
            manifest = json.loads(Path(self.state['worktree_source_manifest']).read_text())
            files = manifest['files']
            digest = self.state['worktree_source_digest']
            base = checked_revision(manifest['baseGitRevision'])
            contents = manifest.get('contents')
            if (not isinstance(files, dict) or not files or
                    base != self.state['deployed'] or manifest['taskSourceDigest'] != digest or
                    hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest() != digest or
                    self.state.get('automatic_deployment_hold', {}).get('source_digest', digest) != digest):
                raise ValueError('Inconsistent protected source manifest')
            if contents is not None:
                if not isinstance(contents, dict) or set(contents) != set(files):
                    raise ValueError('Incomplete approved source contents')
                for name, expected in files.items():
                    if hashlib.sha256(contents[name].encode('utf-8')).hexdigest() != expected:
                        raise ValueError('Approved source contents changed')
            for name, expected in files.items():
                candidate = (source / name).resolve()
                if not candidate.is_relative_to(source.resolve()):
                    raise ValueError('Protected source path escapes snapshot')
                if hashlib.sha256(candidate.read_bytes()).hexdigest() != expected:
                    if contents is None or not self.preserves_source(candidate, base, name, contents[name]):
                        raise ValueError('Protected live source differs')
        except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
            raise DeployError('Main must include the protected live changes; verify and integrate the source manifest before deployment') from None

    def preserves_source(self, candidate, base, name, approved):
        """Allow newer main edits only when merging the authenticated live delta changes nothing."""
        # Confirm an absent path before treating a newly added file's baseline as empty.
        existing = self.git('ls-tree', '--name-only', base, '--', name)
        baseline = b''
        if existing:
            if existing != name:
                return False
            result = subprocess.run(['git', '-C', str(self.repo), 'show', f'{base}:{name}'],
                                    capture_output=True, timeout=120)
            if result.returncode:
                return False
            baseline = result.stdout
        with tempfile.TemporaryDirectory(prefix='fredy-source-merge-') as temporary:
            folder = Path(temporary)
            candidate_bytes = candidate.read_bytes()
            for filename, content in [('candidate', candidate_bytes), ('base', baseline),
                                      ('approved', approved.encode('utf-8'))]:
                (folder / filename).write_bytes(content)
            result = subprocess.run(['git', 'merge-file', '-p', '--', str(folder / 'candidate'),
                                     str(folder / 'base'), str(folder / 'approved')],
                                    capture_output=True, timeout=30)
            return result.returncode == 0 and result.stdout == candidate_bytes

    def check(self, source, sha):
        command = ('unlink /fredy/db; unlink /fredy/conf; cp -a /source/. /fredy/ && '
                   'NODE_ENV=development yarn install --frozen-lockfile --production=false --ignore-scripts && '
                   'yarn lint && yarn format:check && yarn test:offline --maxWorkers=2')
        self.docker('run', '--rm', '--memory', '3g', '--cpus', '3',
                    '--mount', f'type=bind,source={source},target=/source,readonly',
                    '--entrypoint', 'sh', self.config.get('check_image', 'fredy-development:base'), '-c', command)
        self.run(['python3', '-m', 'unittest', 'discover', '-s', str(source / 'test/deploy'), '-p', 'test_*.py'], cwd=source)

    def compose_config(self, sha, image):
        return {'name': self.project, 'services': {'fredy': {
            'image': image,
            'environment': {'NODE_ENV': 'production', 'TZ': 'Europe/Berlin', 'FREDY_REVISION': sha,
                            'FREDY_DEPLOYMENT_GATED': '1',
                            'OPENROUTER_API_KEY_PERSONAL': '${OPENROUTER_API_KEY_PERSONAL:-}'},
            'ports': [f'127.0.0.1:{self.port}:9998'],
            'volumes': ['fredy_conf:/conf', 'fredy_db:/db'],
            'restart': 'unless-stopped', 'shm_size': '256mb', 'mem_limit': '1g',
            'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
            'healthcheck': {'test': ['CMD', 'curl', '--fail', '--silent', '--max-time', '5', 'http://localhost:9998/'],
                            'interval': '10s', 'timeout': '6s', 'retries': 3, 'start_period': '60s'},
        }}, 'volumes': {'fredy_conf': {}, 'fredy_db': {}}}

    def snapshot(self, image, folder):
        """Both volumes are copied and compared only after the application writer has stopped."""
        folder.mkdir(mode=0o700)
        integrity = self.docker('run', '--rm', '--mount', f'type=volume,source={self.db_volume},target=/db,readonly',
                                '--entrypoint', 'node', image, '-e',
                                'const D=require("better-sqlite3");const d=new D("/db/listings.db",{readonly:true});'
                                'if(d.pragma("quick_check",{simple:true})!=="ok")process.exit(1);d.close();', capture=True)
        self.docker('run', '--rm', '--mount', f'type=volume,source={self.db_volume},target=/db,readonly',
                    '--mount', f'type=volume,source={self.conf_volume},target=/conf,readonly',
                    '--mount', f'type=bind,source={folder},target=/backup', '--entrypoint', 'sh', image, '-c',
                    'tar -C / -cf /backup/volumes.tar db conf && tar -C / -df /backup/volumes.tar')
        archive = folder / 'volumes.tar'
        archive.chmod(0o600)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        write_json(folder / 'snapshot.json', {'sha256': digest, 'sqlite': integrity or 'ok'})

    def restore(self, image, folder):
        archive = folder / 'volumes.tar'
        expected = json.loads((folder / 'snapshot.json').read_text())['sha256']
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise DeployError('Snapshot checksum mismatch; refusing restore')
        self.docker('run', '--rm', '--mount', f'type=volume,source={self.db_volume},target=/db',
                    '--mount', f'type=volume,source={self.conf_volume},target=/conf',
                    '--mount', f'type=bind,source={folder},target=/backup,readonly',
                    '--entrypoint', 'sh', image, '-c',
                    'find /db /conf -mindepth 1 -delete && tar -C / -xf /backup/volumes.tar')

    def ready(self, sha, active):
        """Read-only verification: auth guards must protect private new APIs."""
        from urllib.error import HTTPError
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/api/deployment', timeout=10) as response:
            status = json.load(response)
        if status.get('revision') != sha or status.get('active') is not active:
            raise DeployError('Served revision or activation status does not match deployment')
        for path in ['/api/fit/profile', '/api/applications']:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{self.port}' + path, timeout=10)
                raise DeployError('Private API allowed unauthenticated access')
            except HTTPError as error:
                if error.code != 401:
                    raise DeployError('Private API is unavailable') from None
        self.docker('compose', '-p', self.project, '-f', str(self.active_compose), 'exec', '-T', '--user', 'node', 'fredy',
                    'node', '-e', 'const D=require("better-sqlite3");const d=new D("/db/listings.db",{readonly:true});'
                    'if(d.pragma("quick_check",{simple:true})!=="ok")process.exit(1);'
                    'for(const t of ["apartment_fit_profiles","application_records"])'
                    '{if(!d.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get("table",t))process.exit(1)}d.close();')

    def activate(self, path):
        self.compose(path, 'exec', '-T', 'fredy', 'touch', '/tmp/fredy-deployment-active')

    def switch(self, sha, image, next_compose, backup):
        """Snapshot rollback is confined to the preactivation interval, never later."""
        previous_path = Path(self.state.get('compose', self.config['initial_compose']))
        previous_image = self.state.get('image', self.config['initial_image'])
        released = False
        stopped = False
        snapshotted = False
        try:
            self.compose(previous_path, 'stop', '--timeout', '45')
            stopped = True
            self.snapshot(previous_image, backup)
            snapshotted = True
            self.active_compose = next_compose
            self.compose(next_compose, 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '180')
            self.ready(sha, False)
            # Set the conservative boundary before invoking an operation whose outcome could be ambiguous.
            released = True
            self.activate(next_compose)
            self.ready(sha, True)
            return previous_path, previous_image
        except Exception:
            if stopped:
                try:
                    self.compose(next_compose, 'stop', '--timeout', '45')
                    if snapshotted and not released:
                        self.restore(previous_image, backup)
                    # Post-release rollback is code-only: preserve user writes and all SMTP receipts.
                    self.compose(previous_path, 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '180')
                    if self.state.get('deployed'):
                        self.activate(previous_path)
                except Exception:
                    raise RecoveryError('Recovery incomplete; inspect deployment logs before retrying') from None
            raise

    def deploy(self, sha, *, refresh=False, checks=True):
        sha = checked_revision(sha)
        if self.state.get('recovery_required'):
            raise RecoveryError('Manual recovery is required before another deployment')
        if self.state.get('deployed') == sha and not refresh:
            return
        folder = self.root / 'deployments' / f'{int(time.time())}-{sha[:12]}'
        folder.mkdir(parents=True, mode=0o700)
        with (folder / 'deploy.log').open('a') as log:
            self.log = log
            write_json(folder / 'result.json', {'revision': sha, 'status': 'building'})
            try:
                with tempfile.TemporaryDirectory(prefix='fredy-build-', dir=self.root) as temp:
                    source = Path(temp) / 'source'
                    self.archive(sha, source)
                    self.validate_source(source)
                    if checks:
                        self.check(source, sha)
                    image = f'fredy-local:{sha[:12]}'
                    self.docker('build', '--label', f'org.opencontainers.image.revision={sha}',
                                '--label', 'org.opencontainers.image.source=https://github.com/renato-dransay/fredy',
                                '-t', image, str(source))
                    next_worker = (source / 'tools/deploy/mac_mini.py').read_bytes()
                next_compose = folder / 'compose.json'
                write_json(next_compose, self.compose_config(sha, image))
                old_path, old_image = self.switch(sha, image, next_compose, folder / 'backup')
                self.state.update(deployed=sha, image=image, compose=str(next_compose), previous_compose=str(old_path),
                                  previous_image=old_image, deployed_at=time.time(), last_error=None)
                for key in ['automatic_deployment_hold', 'worktree_source_digest', 'worktree_source_manifest']:
                    self.state.pop(key, None)
                self.state.get('failures', {}).pop(sha, None)
                write_json(self.state_path, self.state)
                worker_update = self.root / 'mac_mini.py.next'
                worker_update.write_bytes(next_worker)
                worker_update.chmod(0o700)
                worker_update.replace(self.root / 'mac_mini.py')
                write_json(folder / 'result.json', {'revision': sha, 'status': 'deployed', 'activated': True})
                print(f'Deployed {sha}', flush=True)
            except Exception as error:
                write_json(folder / 'result.json', {'revision': sha, 'status': 'failed', 'error': type(error).__name__})
                self.state['last_error'] = f'{sha}: {type(error).__name__}; see {folder / "deploy.log"}'
                if isinstance(error, RecoveryError):
                    self.state['recovery_required'] = True
                failures = self.state.setdefault('failures', {})
                failures[sha] = {'failed_at': time.time(), 'retry_after': time.time() + 900}
                self.state['failures'] = dict(list(failures.items())[-50:])
                write_json(self.state_path, self.state)
                raise
            finally:
                self.log = None

    def poll(self):
        if self.state.get('recovery_required'):
            raise RecoveryError('Manual recovery is required before another deployment')
        pending = self.fetch_queue()
        for index, sha in enumerate(pending):
            failure = self.state.get('failures', {}).get(sha)
            if failure:
                # An immutable broken commit cannot be repaired in place. Keep its failed
                # receipt, but let a newer pushed fix proceed through the full gate.
                if index < len(pending) - 1:
                    continue
                if time.time() < failure['retry_after']:
                    return
            try:
                self.deploy(sha)
            except RecoveryError:
                raise
            except Exception:
                if index == len(pending) - 1:
                    raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('command', choices=['poll', 'status', 'deploy', 'refresh'])
    parser.add_argument('revision', nargs='?')
    args = parser.parse_args()
    os.umask(0o077)
    worker = Deployer(args.config)
    with (worker.root / 'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('A deployment is already running')
            return
        worker.reload_state()
        if args.command == 'status':
            print(json.dumps(worker.state, indent=2))
        elif args.command == 'deploy':
            worker.deploy(args.revision)
        elif args.command == 'refresh':
            worker.deploy(worker.state['deployed'], refresh=True)
        else:
            worker.poll()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No provider credential, response body, or subprocess environment can be printed here.
        print(f'Deployment failed: {type(error).__name__}: {error}', flush=True)
        raise SystemExit(1) from None

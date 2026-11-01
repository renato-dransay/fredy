"""Exercise the rollback boundary without touching Docker, live data, or credentials."""
import importlib.util
import hashlib
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('mac_mini', Path(__file__).resolve().parents[2] / 'tools/deploy/mac_mini.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class DeploymentTest(unittest.TestCase):
    def worker(self):
        worker = module.Deployer.__new__(module.Deployer)
        worker.state = {'deployed': 'a' * 40}
        worker.config = {'initial_compose': 'old.json', 'initial_image': 'old-image'}
        worker.compose = Mock()
        worker.snapshot = Mock()
        worker.restore = Mock()
        worker.activate = Mock()
        worker.ready = Mock()
        return worker

    def test_snapshot_failure_never_starts_new_app_and_restarts_old(self):
        worker = self.worker()
        worker.snapshot.side_effect = RuntimeError('injected snapshot failure')
        with self.assertRaises(RuntimeError):
            worker.switch('b' * 40, 'new-image', Path('new.json'), Path('backup'))
        worker.restore.assert_not_called()
        self.assertTrue(any(call.args[0] == Path('old.json') and call.args[1] == 'up' for call in worker.compose.call_args_list))
        self.assertFalse(any(call.args[0] == Path('new.json') and call.args[1] == 'up' for call in worker.compose.call_args_list))

    def test_failed_preactivation_probe_restores_with_new_app_stopped(self):
        worker = self.worker()
        worker.ready.side_effect = RuntimeError('injected startup failure')
        events = []
        worker.compose.side_effect = lambda path, command, *args: events.append((str(path), command))
        worker.restore.side_effect = lambda *args: events.append(('snapshot', 'restore'))
        with self.assertRaises(RuntimeError):
            worker.switch('b' * 40, 'new-image', Path('new.json'), Path('backup'))
        self.assertLess(events.index(('new.json', 'stop')), events.index(('snapshot', 'restore')))
        worker.restore.assert_called_once()

    def test_ambiguous_activation_never_restores_old_database(self):
        worker = self.worker()
        worker.activate.side_effect = [RuntimeError('activation outcome unknown'), None]
        with self.assertRaises(RuntimeError):
            worker.switch('b' * 40, 'new-image', Path('new.json'), Path('backup'))
        worker.restore.assert_not_called()

    def test_postactivation_failure_rolls_back_code_preserving_send_receipts(self):
        worker = self.worker()
        worker.ready.side_effect = [None, RuntimeError('postrelease check failed')]
        with self.assertRaises(RuntimeError):
            worker.switch('b' * 40, 'new-image', Path('new.json'), Path('backup'))
        worker.restore.assert_not_called()
        worker.activate.assert_any_call(Path('old.json'))

    def test_success_releases_once_and_does_not_restore(self):
        worker = self.worker()
        old, image = worker.switch('b' * 40, 'new-image', Path('new.json'), Path('backup'))
        self.assertEqual((old, image), (Path('old.json'), 'old-image'))
        worker.activate.assert_called_once_with(Path('new.json'))
        worker.restore.assert_not_called()

    def test_atomic_state_and_revision_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            module.write_json(path, {'deployed': 'a' * 40})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(path.with_suffix('.json.tmp').exists())
        for invalid in ['main', '--all', 'a' * 39, '../secrets']:
            with self.assertRaises(module.DeployError):
                module.checked_revision(invalid)
        self.assertEqual(module.queued_commits('a' * 40, ['a' * 40, 'b' * 40, 'c' * 40]), ['b' * 40, 'c' * 40])

    def test_state_is_refreshed_after_lock_acquisition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'config.json'
            module.write_json(config, {'repo': directory, 'state_dir': directory})
            module.write_json(root / 'deployment-state.json', {'deployed': 'a' * 40})
            worker = module.Deployer(config)
            # Another process finishes a deployment between construction and taking the lock.
            module.write_json(root / 'deployment-state.json', {'deployed': 'b' * 40})
            worker.reload_state()
            self.assertEqual(worker.state['deployed'], 'b' * 40)

    def test_new_fix_commit_is_not_permanently_blocked_by_an_older_failed_check(self):
        worker = self.worker()
        worker.state['failures'] = {'b' * 40: {'retry_after': 99999999999}}
        worker.fetch_queue = Mock(return_value=['b' * 40, 'c' * 40])
        worker.deploy = Mock()
        worker.poll()
        worker.deploy.assert_called_once_with('c' * 40)

    def test_latest_failed_commit_observes_backoff(self):
        worker = self.worker()
        worker.state['failures'] = {'b' * 40: {'retry_after': 99999999999}}
        worker.fetch_queue = Mock(return_value=['b' * 40])
        worker.deploy = Mock()
        worker.poll()
        worker.deploy.assert_not_called()

    def test_unresolved_recovery_stops_even_when_a_newer_fix_exists(self):
        worker = self.worker()
        worker.fetch_queue = Mock(return_value=['b' * 40, 'c' * 40])
        worker.deploy = Mock(side_effect=module.RecoveryError('injected restore failure'))
        with self.assertRaises(module.RecoveryError):
            worker.poll()
        worker.deploy.assert_called_once_with('b' * 40)

    def test_recovery_failure_is_distinct_from_a_bad_immutable_commit(self):
        worker = self.worker()
        worker.ready.side_effect = RuntimeError('injected startup failure')
        worker.restore.side_effect = RuntimeError('injected restore failure')
        with self.assertRaises(module.RecoveryError):
            worker.switch('b' * 40, 'new-image', Path('new.json'), Path('backup'))


class ProtectedSourceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'approved.js').write_text('approved live behavior')
        files = {'approved.js': hashlib.sha256((self.source / 'approved.js').read_bytes()).hexdigest()}
        digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        self.manifest = self.root / 'manifest.json'
        module.write_json(self.manifest, {'baseGitRevision': 'a' * 40, 'taskSourceDigest': digest, 'files': files})
        config = self.root / 'config.json'
        module.write_json(config, {'repo': str(self.root), 'state_dir': str(self.root)})
        self.worker = module.Deployer(config)
        self.worker.state = {
            'deployed': 'a' * 40,
            'worktree_source_digest': digest,
            'worktree_source_manifest': str(self.manifest),
            'automatic_deployment_hold': {'source_digest': digest},
        }

    def test_matching_main_snapshot_preserves_every_live_file(self):
        self.worker.validate_source(self.source)
        self.assertIn('automatic_deployment_hold', self.worker.state)

    def test_missing_or_changed_live_file_is_refused_before_release(self):
        for content in [None, 'old behavior']:
            file = self.source / 'approved.js'
            if content is None:
                file.unlink()
            else:
                file.write_text(content)
            with self.assertRaises(module.DeployError):
                self.worker.validate_source(self.source)
            self.assertIn('automatic_deployment_hold', self.worker.state)

    def test_missing_malformed_empty_or_inconsistent_manifest_fails_closed(self):
        original = self.manifest.read_text()
        variants = [None, '{broken', '{}', json.dumps({'files': {}}), original.replace('a' * 40, 'b' * 40)]
        data = json.loads(original)
        data['files']['approved.js'] = '0' * 64
        variants.append(json.dumps(data))
        for content in variants:
            with self.subTest(content=content):
                if content is None:
                    self.manifest.unlink(missing_ok=True)
                else:
                    self.manifest.write_text(content)
                with self.assertRaises(module.DeployError):
                    self.worker.validate_source(self.source)
        self.manifest.write_text(original)
        self.worker.state.pop('worktree_source_manifest')
        with self.assertRaises(module.DeployError):
            self.worker.validate_source(self.source)

    def test_unreadable_manifest_is_refused(self):
        with patch.object(Path, 'read_text', side_effect=PermissionError('private file')):
            with self.assertRaises(module.DeployError):
                self.worker.validate_source(self.source)

    def test_mismatching_source_never_runs_checks_build_or_switch(self):
        (self.source / 'approved.js').write_text('old behavior')
        with self.assertRaises(module.DeployError):
            self.deploy_candidate()
        self.worker.check.assert_not_called()
        self.worker.docker.assert_not_called()
        self.worker.switch.assert_not_called()
        self.assertIn('automatic_deployment_hold', self.worker.state)

    def prepare_git_baseline(self):
        baseline = 'before\n' + 'unchanged\n' * 8 + 'after\n'
        approved = baseline.replace('before', 'approved')
        subprocess.run(['git', 'init', '--quiet', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'config', 'user.name', 'Deployment test'], check=True)
        subprocess.run(['git', '-C', str(self.root), 'config', 'user.email', 'test@example.invalid'], check=True)
        (self.root / 'approved.js').write_text(baseline)
        subprocess.run(['git', '-C', str(self.root), 'add', 'approved.js'], check=True)
        subprocess.run(['git', '-C', str(self.root), 'commit', '--quiet', '-m', 'baseline'], check=True)
        base = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
        files = {'approved.js': hashlib.sha256(approved.encode()).hexdigest()}
        digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        module.write_json(self.manifest, {'baseGitRevision': base, 'taskSourceDigest': digest,
                                        'files': files, 'contents': {'approved.js': approved}})
        self.worker.state.update(deployed=base, worktree_source_digest=digest,
                                 automatic_deployment_hold={'source_digest': digest})
        return baseline, approved

    def test_newer_main_edits_can_preserve_the_authenticated_live_delta(self):
        _, approved = self.prepare_git_baseline()
        candidate = approved.replace('after', 'new main ending')
        (self.source / 'approved.js').write_text(candidate)
        self.worker.validate_source(self.source)
        self.assertEqual((self.source / 'approved.js').read_text(), candidate)

    def test_missing_or_conflicting_live_delta_cannot_be_waived_by_new_main(self):
        baseline, _ = self.prepare_git_baseline()
        for candidate in [baseline.replace('after', 'new main ending'), baseline.replace('before', 'conflict')]:
            (self.source / 'approved.js').write_text(candidate)
            with self.assertRaises(module.DeployError):
                self.worker.validate_source(self.source)

    def test_tampered_or_partial_approved_contents_are_refused(self):
        _, approved = self.prepare_git_baseline()
        original = json.loads(self.manifest.read_text())
        for contents in [{}, {'approved.js': approved + 'changed'}]:
            module.write_json(self.manifest, {**original, 'contents': contents})
            with self.assertRaises(module.DeployError):
                self.worker.validate_source(self.source)

    def test_git_read_errors_are_not_treated_as_absent_baseline_files(self):
        _, approved = self.prepare_git_baseline()
        (self.source / 'approved.js').write_text(approved.replace('after', 'new main ending'))
        self.worker.git = Mock(side_effect=module.DeployError('Git unavailable'))
        with self.assertRaises(module.DeployError):
            self.worker.validate_source(self.source)

    def test_rejected_old_commit_does_not_block_matching_integration_commit(self):
        self.worker.fetch_queue = Mock(return_value=['b' * 40, 'c' * 40])
        self.worker.deploy = Mock(side_effect=[module.DeployError('protected files missing'), None])
        self.worker.poll()
        self.assertEqual([call.args[0] for call in self.worker.deploy.call_args_list], ['b' * 40, 'c' * 40])
        self.worker.state['deployed'] = 'c' * 40
        self.worker.fetch_queue.return_value = []
        self.worker.deploy.reset_mock()
        self.worker.poll()
        self.worker.deploy.assert_not_called()
        self.assertEqual(self.worker.state['deployed'], 'c' * 40)

    def deploy_candidate(self, failure=None, sha='b' * 40):
        self.worker.archive = Mock(side_effect=lambda sha, target: self.populate_source(target))
        self.worker.check = Mock()
        self.worker.docker = Mock()
        self.worker.switch = Mock(return_value=(Path('previous.json'), 'previous-image'), side_effect=failure)
        return self.worker.deploy(sha)

    def populate_source(self, target):
        (target / 'tools/deploy').mkdir(parents=True)
        (target / 'approved.js').write_bytes((self.source / 'approved.js').read_bytes())
        (target / 'tools/deploy/mac_mini.py').write_text('# checked worker')

    def test_only_successful_activation_clears_overlay_hold_and_retry(self):
        self.worker.state['failures'] = {'b' * 40: {'retry_after': 99999999999}}
        self.deploy_candidate()
        saved = json.loads(self.worker.state_path.read_text())
        self.assertEqual(saved['deployed'], 'b' * 40)
        for key in ['automatic_deployment_hold', 'worktree_source_digest', 'worktree_source_manifest']:
            self.assertNotIn(key, saved)
        self.assertNotIn('b' * 40, saved['failures'])

    def test_failed_checks_or_activation_preserve_live_metadata(self):
        for failure in ['checks', 'activation']:
            with self.subTest(failure=failure):
                if failure == 'checks':
                    self.worker.archive = Mock(side_effect=lambda sha, target: self.populate_source(target))
                    self.worker.check = Mock(side_effect=module.DeployError('injected failed checks'))
                    self.worker.switch = Mock()
                    deploy = lambda: self.worker.deploy('b' * 40)
                else:
                    deploy = lambda: self.deploy_candidate(module.RecoveryError('injected recovery failure'), sha='c' * 40)
                with self.assertRaises(module.DeployError):
                    deploy()
                self.assertEqual(self.worker.state['deployed'], 'a' * 40)
                self.assertIn('automatic_deployment_hold', self.worker.state)
                self.assertIn('worktree_source_manifest', self.worker.state)
                if failure == 'checks':
                    self.worker.switch.assert_not_called()


if __name__ == '__main__':
    unittest.main()

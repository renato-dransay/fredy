"""Exercise the rollback boundary without touching Docker, live data, or credentials."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

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


if __name__ == '__main__':
    unittest.main()

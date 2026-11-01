#!/usr/bin/env python3
"""Inject a failed startup into disposable Docker volumes; production is never mounted."""
import json
from pathlib import Path
import tempfile
import time
import uuid
from mac_mini import Deployer, write_json


def main():
    project = 'fredy-recovery-' + uuid.uuid4().hex[:8]
    image = 'fredy-local:54e6b3d58deb'
    with tempfile.TemporaryDirectory(prefix='fredy-recovery-') as directory:
        root = Path(directory)
        config = root / 'config.json'
        old = root / 'old.json'
        write_json(config, {'state_dir': str(root), 'repo': str(Path.cwd()), 'project': project,
                            'port': 19998, 'initial_compose': str(old), 'initial_image': image})
        worker = Deployer(config)
        compose = worker.compose_config('a' * 40, image)
        compose['services']['fredy']['restart'] = 'no'
        write_json(old, compose)
        try:
            # Initialize only this unique project's volumes with synthetic state.
            worker.compose(old, 'run', '--rm', '--no-deps', '--entrypoint', 'node', 'fredy', '-e',
                           'require("fs").writeFileSync("/conf/config.json",JSON.stringify({sqlitepath:"/db",analyticsEnabled:false}));'
                           'const D=require("better-sqlite3");const d=new D("/db/listings.db");'
                           'd.exec("CREATE TABLE deployment_probe(value TEXT); INSERT INTO deployment_probe VALUES (\'original\')");d.close();')
            worker.compose(old, 'up', '-d', '--wait', '--wait-timeout', '90')
            next_path = root / 'broken.json'
            broken = worker.compose_config('b' * 40, image)
            broken['services']['fredy']['restart'] = 'no'
            evidence = root / 'evidence'
            evidence.mkdir(mode=0o777)
            evidence.chmod(0o777)  # Disposable marker only; no credentials or application data.
            broken['services']['fredy']['volumes'].append(f'{evidence}:/evidence')
            # Simulates a failed migration/startup that changed data before becoming available.
            broken['services']['fredy']['command'] = ['node', '-e',
                'const D=require("better-sqlite3");const d=new D("/db/listings.db");'
                'd.exec("UPDATE deployment_probe SET value=\'changed\'");d.close();'
                'require("fs").writeFileSync("/evidence/startup-ran","changed");process.exit(42);']
            write_json(next_path, broken)
            try:
                worker.switch('b' * 40, image, next_path, root / 'backup')
                raise AssertionError('Injected startup failure was not detected')
            except Exception as error:
                if isinstance(error, AssertionError):
                    raise
            assert (evidence / 'startup-ran').read_text() == 'changed', 'Injected startup never ran'
            value = worker.compose(old, 'exec', '-T', '--user', 'node', 'fredy', 'node', '-e',
                           'const D=require("better-sqlite3");const d=new D("/db/listings.db",{readonly:true});'
                           'if(d.prepare("SELECT value FROM deployment_probe").get().value!=="original")process.exit(3);'
                           'if(d.pragma("quick_check",{simple:true})!=="ok")process.exit(4);d.close();')
            print(json.dumps({'isolated_project': project, 'startup_failure_detected': True,
                              'snapshot_restore_preserved_sentinel': True, 'sqlite_integrity': 'ok'}))
        finally:
            worker.compose(old, 'down', '-v', '--remove-orphans')


if __name__ == '__main__':
    main()

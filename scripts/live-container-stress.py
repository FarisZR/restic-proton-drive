#!/usr/bin/env python3
"""Phase-synchronized live test; requires the separate fault-test image.
LIVE_DISPOSABLE=1, STRESS_CONTAINER, FAULT_DIR, REST_TOKEN_FILE,
RESTIC_PASSWORD_FILE and RESTIC_BIN must identify disposable test resources.
FAULT_DIR must be bind-mounted at /fault with FAULT_DIR=/fault in the container.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import threading
import time

assert os.environ.get('LIVE_DISPOSABLE') == '1', 'Set LIVE_DISPOSABLE=1 only for a disposable repository'
container = os.environ['STRESS_CONTAINER']
fault_dir = Path(os.environ['FAULT_DIR']).resolve()
restic = os.environ.get('RESTIC_BIN', 'restic')
work = Path(tempfile.mkdtemp(prefix='restic-proton-live-'))
source = work / 'source'
source.mkdir()
(source / 'empty').touch()
(source / 'empty directory').mkdir()
(source / 'Unicode-Δ-文件\nnewline').write_text('restorable data')
(source / 'binary').write_bytes(bytes(range(256)) * 1000)
os.link(source / 'binary', source / 'hardlink')
os.symlink('missing', source / 'dangling')
os.symlink('.', source / 'loop')
for n in range(150):
    (source / ('small-' + str(n))).write_bytes(hashlib.sha256(str(n).encode()).digest())
(source / 'private').write_text('permissions')
(source / 'private').chmod(0o400)
with (source / 'sparse').open('wb') as file:
    file.seek(32 * 1024 * 1024)
    file.write(b'end')
env = {**os.environ, 'RESTIC_REPOSITORY': os.environ.get('RESTIC_REPOSITORY', 'rest:http://127.0.0.1:18000/'),
       'RESTIC_REST_USERNAME': 'backup', 'RESTIC_REST_PASSWORD': Path(os.environ['REST_TOKEN_FILE']).read_text().strip(),
       'RESTIC_CACHE_DIR': str(work / 'cache')}


def run(*args):
    result = subprocess.run([restic, *args], env=env, capture_output=True, text=True, timeout=600)
    with (work / 'restic.log').open('a') as output:
        output.write(' '.join(args) + '\n' + result.stdout + result.stderr + '\n')
    assert result.returncode == 0, result.stdout + result.stderr
    return result


def manifest(directory):
    result = {}
    for p in directory.rglob('*'):
        s = p.lstat()
        result[str(p.relative_to(directory))] = (stat.S_IMODE(s.st_mode),
            os.readlink(p) if p.is_symlink() else hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'directory')
    return result


def restore(snapshot, expected, label):
    shutil.rmtree(work / 'cache', ignore_errors=True)
    target = work / label
    run('restore', snapshot, '--target', str(target), '--verify')
    restored = target / str(source).lstrip('/')
    assert manifest(restored) == expected
    assert (restored / 'binary').stat().st_ino == (restored / 'hardlink').stat().st_ino


def faulted(phase, action, command):
    identifier = work.name + '-' + phase + '-' + action
    plan = fault_dir / 'plan.json'
    temp = fault_dir / 'plan.tmp'
    temp.write_text(json.dumps({'id': identifier, 'phase': phase}))
    temp.replace(plan)
    errors = []

    def interrupt():
        try:
            marker = fault_dir / ('reached-' + identifier + '.json')
            deadline = time.monotonic() + 180
            while not marker.exists():
                assert time.monotonic() < deadline, 'Target phase was never reached: ' + phase
                time.sleep(.02)
            record = json.loads(marker.read_text())
            assert record['leftAt'] is None, 'Operation left target phase before fault'
            fault_at = int(time.time() * 1000)
            if action == 'hold':
                # Keep the bulk request active while a real restic refresh cycle runs.
                lock_log = fault_dir / 'lock-writes.jsonl'
                deadline = time.monotonic() + 420
                while True:
                    records = [json.loads(line) for line in lock_log.read_text().splitlines()] if lock_log.exists() else []
                    if any(item['at'] > fault_at for item in records):
                        break
                    assert time.monotonic() < deadline, 'No successful lock refresh while bulk commit was held'
                    assert json.loads(marker.read_text())['leftAt'] is None
                    time.sleep(.2)
            elif action == 'pause':
                subprocess.run(['docker', 'pause', container], check=True, stdout=subprocess.DEVNULL)
                try:
                    assert json.loads(marker.read_text())['leftAt'] is None
                    time.sleep(2)
                finally:
                    subprocess.run(['docker', 'unpause', container], check=True, stdout=subprocess.DEVNULL)
            elif action == 'network':
                subprocess.run(['docker', 'network', 'disconnect', 'bridge', container], check=True)
                try:
                    (fault_dir / ('release-' + identifier)).touch()
                    time.sleep(3)
                finally:
                    subprocess.run(['docker', 'network', 'connect', 'bridge', container], check=True)
            else:
                subprocess.run(['docker', 'kill', '--signal', 'KILL', container], check=True, stdout=subprocess.DEVNULL)
                subprocess.run(['docker', 'start', container], check=True, stdout=subprocess.DEVNULL)
            record = json.loads(marker.read_text())
            assert record['leftAt'] is None or record['leftAt'] >= fault_at, 'Fault missed the active operation'
            (fault_dir / ('release-' + identifier)).touch()
            print('FAULT CONFIRMED: ' + phase + ' / ' + action, flush=True)
        except BaseException as error:
            errors.append(error)
            (fault_dir / ('release-' + identifier)).touch()

    thread = threading.Thread(target=interrupt)
    thread.start()
    try:
        command()
    finally:
        thread.join()
    assert not errors, errors


print('Live stress artifacts: ' + str(work), flush=True)
if os.environ.get('SKIP_INIT') != '1':
    run('init')
snapshots = []
cases = [('before-commit', 'network'), ('after-commit', 'kill')]
if os.environ.get('LOCK_REFRESH_SOAK') == '1':
    cases.append(('before-commit', 'hold'))
for phase, action in cases:
    (source / 'random').write_bytes(os.urandom(12 * 1024 * 1024))
    tag = work.name + '-' + phase + '-' + action
    expected = manifest(source)
    faulted(phase, action, lambda: run('backup', str(source), '--tag', tag))
    snapshot = json.loads(run('snapshots', '--json', '--tag', tag).stdout)[-1]['id']
    snapshots.append((snapshot, expected))
    run('check', '--read-data')
    restore(snapshot, expected, phase + '-restore')
    print('PASS: phase-synchronized backup, full check and cold-cache restore: ' + phase, flush=True)

first, original = snapshots[0]
second, current = snapshots[-1]
faulted('after-trash', 'kill', lambda: run('forget', first, '--prune'))
run('check', '--read-data')
restore(second, current, 'post-prune-restore')
print('PASS: acknowledged trash interrupted before response; retained snapshot checks and restores', flush=True)
(work / 'trashed-snapshot').write_text(first)

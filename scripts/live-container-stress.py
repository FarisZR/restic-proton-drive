#!/usr/bin/env python3
"""Destructive live test for a dedicated test repository and Docker container.
Requires LIVE_DISPOSABLE=1, STRESS_CONTAINER, REST_TOKEN_FILE, RESTIC_PASSWORD_FILE.
Only the named disposable container is paused/restarted/disconnected.
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

assert os.environ.get('LIVE_DISPOSABLE') == '1', 'Set LIVE_DISPOSABLE=1 for a disposable repository'
container = os.environ['STRESS_CONTAINER']
restic = os.environ.get('RESTIC_BIN', 'restic')
work = Path(tempfile.mkdtemp(prefix='restic-proton-live-'))
source = work / 'source'
source.mkdir()
(source / 'empty').touch()
(source / 'empty directory').mkdir()
(source / 'Unicode-Δ-文件\nnewline').write_text('restorable data')
(source / 'random').write_bytes(os.urandom(12 * 1024 * 1024))
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


fault_errors = []
def interrupt():
    try:
        time.sleep(2)
        subprocess.run(['docker', 'pause', container], check=True, stdout=subprocess.DEVNULL)
        time.sleep(3)
        subprocess.run(['docker', 'unpause', container], check=True, stdout=subprocess.DEVNULL)
        time.sleep(2)
        subprocess.run(['docker', 'network', 'disconnect', 'bridge', container], check=True)
        try:
            time.sleep(5)
        finally:
            subprocess.run(['docker', 'network', 'connect', 'bridge', container], check=True)
        time.sleep(2)
        subprocess.run(['docker', 'kill', '--signal', 'KILL', container], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['docker', 'start', container], check=True, stdout=subprocess.DEVNULL)
    except BaseException as error:
        fault_errors.append(error)


print('Live stress artifacts: ' + str(work), flush=True)
if os.environ.get('SKIP_INIT') != '1':
    run('init')
expected_first = manifest(source)
baseline_tag = work.name + '-baseline'
faulted_tag = work.name + '-faulted'
run('backup', str(source), '--tag', baseline_tag)
first = json.loads(run('snapshots', '--json', '--tag', baseline_tag).stdout)[0]['id']
restore(first, expected_first, 'baseline-restore')
print('PASS: live baseline backup and verified edge-case restore', flush=True)
(source / 'random').write_bytes(os.urandom(24 * 1024 * 1024))
(source / 'empty').unlink()
(source / 'new-empty').touch()
expected_second = manifest(source)
fault = threading.Thread(target=interrupt)
fault.start()
try:
    run('backup', str(source), '--tag', faulted_tag)
finally:
    fault.join()
assert not fault_errors, fault_errors
second = json.loads(run('snapshots', '--json', '--tag', faulted_tag).stdout)[-1]['id']
run('check', '--read-data')
restore(second, expected_second, 'faulted-restore')
restore(first, expected_first, 'historical-restore')
print('PASS: live backup survived pause, network removal and SIGKILL; full check and both cold-cache restores matched', flush=True)
run('forget', first, '--prune')
run('check', '--read-data')
restore(second, expected_second, 'post-prune-restore')
print('PASS: live prune, full check and post-prune restore', flush=True)

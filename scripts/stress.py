#!/usr/bin/env python3
"""Repeatable restic integration stress test. No Proton account required.
Uses the production HTTP handler and DriveStore with a fault-injectable SDK boundary.
"""
import base64
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
import urllib.request

BUN = os.environ.get('BUN_BIN', 'bun')
RESTIC = os.environ.get('RESTIC_BIN', 'restic')
ROOT = Path(__file__).resolve().parent.parent
TOKEN = 'test-token-' * 4
AUTH = 'Basic ' + base64.b64encode(('backup:' + TOKEN).encode()).decode()
work = Path(tempfile.mkdtemp(prefix='restic-proton-stress-'))
provider = work / 'provider'
provider.mkdir()
log = (work / 'server.log').open('w')
process = None
backend_port = None
proxy_faults = {}
counts = {}


def start():
    global process, backend_port
    port_file = provider / 'port'
    port_file.unlink(missing_ok=True)
    process = subprocess.Popen([BUN, str(ROOT / 'test/support/server.ts'), str(provider), str(backend_port or 0)], cwd=ROOT, stdout=log, stderr=log)
    for _ in range(200):
        if port_file.exists():
            backend_port = int(port_file.read_text())
            return
        if process.poll() is not None:
            raise RuntimeError('Server startup failed; see ' + str(work))
        time.sleep(0.025)
    raise TimeoutError('Server startup')


def control(**faults):
    req = urllib.request.Request(f'http://127.0.0.1:{backend_port}/_control', data=json.dumps(faults).encode(), method='POST')
    return json.load(urllib.request.urlopen(req, timeout=10))


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.forward()

    do_HEAD = do_GET
    do_POST = do_GET
    do_DELETE = do_GET

    def forward(self):
        connection = http.client.HTTPConnection('127.0.0.1', backend_port, timeout=120)
        try:
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            is_pack = self.path.startswith('/data/') and len(self.path) > 10
            drop_upload = self.command == 'POST' and is_pack and proxy_faults.get('upload', 0) > 0
            if drop_upload:
                proxy_faults['upload'] -= 1
                counts['upload_drop'] = counts.get('upload_drop', 0) + 1
                connection.putrequest(self.command, self.path)
                for key, value in self.headers.items():
                    if key.lower() not in ('host', 'connection'):
                        connection.putheader(key, value)
                connection.endheaders()
                connection.send(body[:max(1, len(body) // 2)])
                connection.sock.shutdown(socket.SHUT_RDWR)
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            if self.command == 'POST' and is_pack and proxy_faults.get('slow'):
                connection.putrequest(self.command, self.path)
                for key, value in self.headers.items():
                    if key.lower() not in ('host', 'connection'):
                        connection.putheader(key, value)
                connection.endheaders()
                for offset in range(0, len(body), 65536):
                    connection.send(body[offset:offset + 65536])
                    counts['slow_upload_chunks'] = counts.get('slow_upload_chunks', 0) + 1
                    time.sleep(0.01)
            else:
                connection.request(self.command, self.path, body, dict(self.headers))
            response = connection.getresponse()
            payload = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ('connection', 'transfer-encoding', 'content-length'):
                    self.send_header(key, value)
            self.send_header('Content-Length', response.getheader('Content-Length', str(len(payload))))
            self.end_headers()
            if self.command == 'HEAD':
                return
            if self.command == 'GET' and is_pack and proxy_faults.get('download', 0) > 0:
                proxy_faults['download'] -= 1
                counts['download_drop'] = counts.get('download_drop', 0) + 1
                self.wfile.write(payload[:max(1, len(payload) // 2)])
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            for offset in range(0, len(payload), 65536):
                self.wfile.write(payload[offset:offset + 65536])
                if proxy_faults.get('slow'):
                    time.sleep(0.002)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            self.close_connection = True
        finally:
            connection.close()


def run(*args, success=True, timeout=180):
    result = subprocess.run([RESTIC, *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    with (work / 'restic.log').open('a') as output:
        output.write(' '.join(args) + '\n' + result.stdout + '\n')
    if success and result.returncode:
        raise AssertionError(result.stdout)
    if not success and result.returncode == 0:
        raise AssertionError('Unexpected success: ' + ' '.join(args))
    return result


def manifest(source):
    result = {}
    for path in source.rglob('*'):
        info = path.lstat()
        value = {'mode': stat.S_IMODE(info.st_mode)}
        if path.is_symlink():
            value['link'] = os.readlink(path)
        elif path.is_file():
            value['size'] = info.st_size
            value['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif path.is_dir():
            value['directory'] = True
        result[str(path.relative_to(source))] = value
    return result


def restore(snapshot, expected, name):
    target = work / name
    # Discard the restic cache to exercise backend reads on every restore.
    shutil.rmtree(work / 'cache', ignore_errors=True)
    run('restore', snapshot, '--target', str(target), '--verify')
    restored = target / str(source).lstrip('/')
    assert manifest(restored) == expected, 'Restore byte/metadata mismatch: ' + name
    assert (restored / 'hardlink').stat().st_ino == (restored / 'binary').stat().st_ino
    return restored


try:
    start()
    proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
    proxy.daemon_threads = True
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    env = {**os.environ, 'RESTIC_REPOSITORY': f'rest:http://127.0.0.1:{proxy.server_port}/',
           'RESTIC_REST_USERNAME': 'backup', 'RESTIC_REST_PASSWORD': TOKEN,
           'RESTIC_PASSWORD': 'independent-test-repository-password', 'RESTIC_CACHE_DIR': str(work / 'cache')}
    # Do not inherit unrelated user passwords or repositories.
    env.pop('RESTIC_PASSWORD_FILE', None)
    source = work / 'source'
    source.mkdir()
    for n in range(1000):
        directory = source / ('dir-' + str(n % 20))
        directory.mkdir(exist_ok=True)
        (directory / f'file-{n}').write_bytes(hashlib.sha256(str(n).encode()).digest() * (n % 10))
    (source / 'empty').touch()
    (source / 'empty directory').mkdir()
    (source / 'binary').write_bytes(bytes(range(256)) * 400)
    os.link(source / 'binary', source / 'hardlink')
    (source / 'unicode-Δ-文件-🚀\nname').write_text('a unicode and newline filename')
    (source / 'Case').write_text('upper')
    (source / 'case').write_text('lower')
    (source / ('x' * 240)).write_text('long filename')
    os.symlink('missing', source / 'dangling')
    os.symlink('.', source / 'loop')
    (source / 'executable').write_text('#!/bin/sh\necho restored\n')
    (source / 'executable').chmod(0o751)
    (source / 'private').write_text('permission test')
    (source / 'private').chmod(0o400)
    with (source / 'sparse').open('wb') as file:
        file.seek(64 * 1024 * 1024)
        file.write(b'end')
    (source / 'random').write_bytes(os.urandom(24 * 1024 * 1024))
    expected_first = manifest(source)
    run('version')
    run('init')
    run('backup', str(source), '--tag', 'baseline')
    first = json.loads(run('snapshots', '--json').stdout)[0]['id']
    restore(first, expected_first, 'first-restore')
    # Re-restore over damaged/existing files and remove stale files explicitly.
    restored = work / 'first-restore' / str(source).lstrip('/')
    (restored / 'random').write_bytes(b'damaged local file')
    (restored / 'obsolete').write_text('not in snapshot')
    run('restore', first, '--target', str(work / 'first-restore'), '--verify', '--delete', '--sparse')
    assert manifest(restored) == expected_first
    selected = work / 'selected'
    run('restore', first, '--target', str(selected), '--include', '**/binary', '--verify')
    assert (selected / str(source).lstrip('/') / 'binary').read_bytes() == (source / 'binary').read_bytes()
    print('PASS: baseline snapshot; 1000+ files, sparse data, hardlinks, symlinks, permissions, Unicode, long and newline names', flush=True)

    (source / 'random').write_bytes(os.urandom(24 * 1024 * 1024))
    (source / 'empty').unlink()
    (source / 'new-empty').touch()
    (source / 'dir-0/file-0').write_bytes(b'changed file')
    expected_second = manifest(source)
    control(upload=2, lostAck=2, delay=1)
    proxy_faults.update(upload=2, slow=True)
    run('backup', str(source), '--tag', 'faulted', timeout=300)
    control()
    snapshots = json.loads(run('snapshots', '--json').stdout)
    second = snapshots[-1]['id']
    assert second != first
    assert counts.get('upload_drop') == 2
    assert counts.get('slow_upload_chunks', 0) > 100
    print('PASS: incremental backup through slow transfers, two mid-body socket drops, transient SDK 503s and lost commit acknowledgments', flush=True)

    control(download=2, listing=1, delay=1)
    proxy_faults.update(download=2)
    run('check', '--read-data', timeout=300)
    restore(second, expected_second, 'faulted-restore')
    assert counts.get('download_drop') == 2
    control()
    proxy_faults.clear()
    restore(first, expected_first, 'historical-restore')
    print('PASS: full-content check and cold-cache latest/historical restores through download drops and failed listing pages', flush=True)

    # Restart with the same remote objects and persisted deletion state.
    process.kill()
    process.wait()
    start()
    run('check', '--read-data')
    restore(second, expected_second, 'restart-restore')
    run('forget', first, '--prune')
    run('check', '--read-data')
    restore(second, expected_second, 'pruned-restore')
    print('PASS: abrupt process restart, retention, prune, full check and post-prune restore', flush=True)

    wrong_env = dict(env, RESTIC_PASSWORD='wrong password')
    bad = subprocess.run([RESTIC, 'snapshots'], env=wrong_env, capture_output=True, timeout=30)
    assert bad.returncode != 0
    # Corrupt a committed remote object on disk: the server must return a
    # failed read, never serve unverified bytes, even for a one-byte range.
    nodes = json.loads((provider / 'remote/nodes.json').read_text())
    pack = next(n for n in nodes.values() if n['name'].get('ok') and len(n['name']['value']) == 64
                and n.get('activeRevision', {}).get('claimedSize', 0) > 1000000)
    path = provider / 'remote' / pack['uid']
    original = path.read_bytes()
    path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
    req = urllib.request.Request(f'http://127.0.0.1:{backend_port}/data/{pack["name"]["value"]}', headers={'Authorization': AUTH, 'Range': 'bytes=0-0'})
    try:
        urllib.request.urlopen(req, timeout=30)
        raise AssertionError('Corrupt object served successfully')
    except urllib.error.HTTPError as error:
        assert error.code == 500
    finally:
        path.write_bytes(original)
    run('check', '--read-data')
    print('PASS: wrong repository password rejected; stored corruption blocked before range response; restored object passes full check', flush=True)
    # Simulate a provider losing a committed pack. Both checking and restoring
    # must fail instead of accepting an incomplete repository.
    metadata_path = provider / 'remote/nodes.json'
    original_metadata = metadata_path.read_bytes()
    del nodes[pack['uid']]
    process.kill(); process.wait()
    metadata_path.write_text(json.dumps(nodes))
    start()
    run('check', '--read-data', success=False, timeout=30)
    shutil.rmtree(work / 'cache', ignore_errors=True)
    run('restore', second, '--target', str(work / 'missing-pack-restore'), '--verify', success=False, timeout=30)
    process.kill(); process.wait()
    metadata_path.write_bytes(original_metadata)
    start()
    run('check', '--read-data')
    restore(second, expected_second, 'recovered-provider-restore')
    print('PASS: missing-pack check and restore fail; provider recovery followed by a cold-cache restore matches the manifest', flush=True)
    print('Stress test passed. Logs: ' + str(work), flush=True)
except BaseException:
    print('FAILED. Artifacts retained at ' + str(work), flush=True)
    raise
finally:
    if process is not None and process.poll() is None:
        process.kill()
        process.wait()
    if 'proxy' in globals():
        proxy.shutdown()
    log.close()

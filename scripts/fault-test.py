#!/usr/bin/env python3
"""Protocol failure/retry checks against a disposable live repository."""
import base64
import hashlib
import http.client
import json
import os
import time
import urllib.error
import urllib.request

url = os.environ.get('REST_URL', 'http://127.0.0.1:8000').rstrip('/')
token = open(os.environ['REST_TOKEN_FILE']).read().strip()
headers = {'Authorization': 'Basic ' + base64.b64encode(('backup:' + token).encode()).decode()}


def request(path, method='GET', data=None, extra=None):
    req = urllib.request.Request(url + path, method=method, data=data, headers={**headers, **(extra or {})})
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


payload = os.urandom(8 * 1024 * 1024)
name = hashlib.sha256(payload).hexdigest()
path = '/data/' + name
assert request(path, 'POST', b'wrong content')[0] == 400
assert request(path, 'HEAD')[0] == 404

# Disconnect during an SDK upload. An unknown outcome must be safe to retry.
from urllib.parse import urlsplit
parsed = urlsplit(url)
connection = http.client.HTTPConnection(parsed.hostname, parsed.port)
connection.request('POST', path, payload, headers)
time.sleep(0.3)
connection.close()
time.sleep(1)
status, body = request(path)
assert status == 404 or (status == 200 and body == payload), status
assert request(path, 'POST', payload)[0] == 200
assert request(path, 'POST', payload)[0] == 200
assert request(path)[1] == payload
assert request(path, extra={'Range': 'bytes=17-42'})[1] == payload[17:43]
assert request(path, 'POST', b'wrong content')[0] == 400
assert request(path)[1] == payload
assert request(path, 'DELETE')[0] == 200
assert request(path, 'HEAD')[0] == 404
assert request(path, 'DELETE')[0] == 200
print('Live interrupted upload, retry, digest, range and deletion checks passed.')

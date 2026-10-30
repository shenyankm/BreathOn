"""Check the disposable Compose stack without provider credentials or voice calls."""
import json
from http.client import HTTPException
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


origin = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'http://127.0.0.1:18080'


def request(path, data=None):
    headers = {'Origin': origin, 'Content-Type': 'application/json'} if data else {}
    try:
        response = urlopen(Request(origin+path, data=data, headers=headers), timeout=5)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read(2_000_000)


for attempt in range(30):
    try:
        if request('/api/ready')[0] == 200:
            break
    except (URLError, TimeoutError, OSError, HTTPException):
        pass
    time.sleep(1)
else:
    raise SystemExit('API did not become ready through the proxy')

status, headers, _ = request('/api/live')
assert status == 200 and headers.get('X-Request-ID')
status, headers, index = request('/')
assert status == 200 and headers.get('Cache-Control') == 'no-cache'
status, headers, admin = request('/admin')
assert status == 200 and headers.get('Cache-Control') == 'no-cache' and admin == index
for path in ('/app', '/app/records', '/preview-visit.html'):
    assert request(path)[0] == 410, 'Removed user page must not be served: '+path
for path in ('/_android/index.html', '/_android/assets/does-not-exist.js'):
    assert request(path)[0] == 404, 'Android assets must only come from the APK: '+path
asset = re.search(r'src="(/assets/[^\"]+\.js)"', index.decode())
assert asset, 'Built entry module is missing'
status, headers, _ = request(asset.group(1))
assert status == 200 and 'immutable' in headers.get('Cache-Control', '')
assert request('/assets/does-not-exist.js')[0] == 404
# A 1 MB proxy default must not block the API's supported larger uploads.
payload = json.dumps({'kind':'policy', 'query':'x'*1_100_000}).encode()
assert request('/api/research/jobs', payload)[0] == 422
unknown_key = 'unknown-key-'+'x'*10_000
status, _, body = request('/api/research/jobs', json.dumps({'kind':'policy', 'query':'public-topic', unknown_key:'synthetic'}).encode())
assert status == 422 and len(body) < 4_000 and unknown_key.encode() not in body
print('Compose HTTP checks passed: readiness, management routes, APK-only assets, cache policy, >1 MB body')

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
from threading import Thread
import pytest


@pytest.mark.parametrize('leaked_route', [None, '/app', '/_android/index.html'])
def test_stack_check_retries_a_truncated_response_during_restart(leaked_route):
    ready_calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == '/api/ready':
                ready_calls.append(self.path)
                if len(ready_calls) == 1:
                    self.send_response(200)
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    self.wfile.write(b'8\r\n{"sta')
                    self.close_connection = True
                    return
            if self.path == leaked_route:
                return self.respond(200)
            if self.path in ('/app', '/app/records', '/preview-visit.html'):
                return self.respond(410)
            if self.path.startswith('/_android/') or self.path == '/assets/does-not-exist.js':
                return self.respond(404)
            if self.path in ('/', '/admin'):
                return self.respond(200, b'<script src="/assets/app.js"></script>', 'no-cache')
            self.respond(200, cache='public, max-age=31536000, immutable')

        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.respond(422, b'{"detail":"invalid request"}')

        def respond(self, status, body=b'{}', cache='no-store'):
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Request-ID', 'synthetic-request')
            self.send_header('Cache-Control', cache)
            self.end_headers()
            self.wfile.write(body)

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            script = Path(__file__).resolve().parents[2]/'deploy/check-stack.py'
            result = subprocess.run(
                [sys.executable, str(script), f'http://127.0.0.1:{server.server_port}'],
                capture_output=True, text=True, timeout=10,
            )
        finally:
            server.shutdown()
            worker.join(timeout=2)
    assert len(ready_calls) == 2
    if leaked_route is None:
        assert result.returncode == 0, result.stderr
        assert 'Compose HTTP checks passed' in result.stdout
    else:
        assert result.returncode != 0
        assert leaked_route in result.stderr

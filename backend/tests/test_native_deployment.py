import io
import gzip
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import time

import pytest

SCRIPT = (Path(__file__).resolve().parents[2] / 'deploy/native-deploy.sh').read_text()
RECEIVER = SCRIPT.split("run 600 python3 -c '\n", 1)[1].split("\n' \"$stage\"", 1)[0]
EXTRACTOR = SCRIPT.split("run 60 python3 -c '\n", 1)[1].split("\n' \"$stage\"", 1)[0]
MIRROR = SCRIPT.split("run 30 python3 -c '\n", 1)[1].split("\n' /etc/medvisit-coach/compose.env", 1)[0]


@pytest.mark.parametrize('setting', ['', "PYPI_DOWNLOAD_BASE='https://mirrors.cloud.tencent.com/pypi'\n"])
def test_native_wheel_mirror_keeps_locked_hashes_and_ignores_private_settings(tmp_path, setting):
    config, lock = tmp_path/'compose.env', tmp_path/'uv.lock'
    config.write_text('POSTGRES_PASSWORD=synthetic-private-value\n'+setting)
    original = 'url = "https://files.pythonhosted.org/packages/test.whl"\nhash = "sha256:locked-value"\n'
    lock.write_text(original)
    result = subprocess.run([sys.executable, '-c', MIRROR, str(config), str(lock)], capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    base = 'https://mirrors.cloud.tencent.com/pypi' if setting else 'https://files.pythonhosted.org'
    assert lock.read_text() == original.replace('https://files.pythonhosted.org', base)
    assert b'synthetic-private-value' not in result.stdout+result.stderr


def test_native_wheel_mirror_rejects_embedded_credentials_without_changing_lock(tmp_path):
    config, lock = tmp_path/'compose.env', tmp_path/'uv.lock'
    config.write_text('PYPI_DOWNLOAD_BASE=https://user:synthetic-secret@mirror.example\n')
    lock.write_text('original-lock')
    result = subprocess.run([sys.executable, '-c', MIRROR, str(config), str(lock)], capture_output=True)
    assert result.returncode != 0 and lock.read_text() == 'original-lock'
    assert b'synthetic-secret' not in result.stdout+result.stderr


def archive(entries, *, compressed=True):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz' if compressed else 'w:') as tar:
        for name, data in entries:
            member = tarfile.TarInfo(name)
            if data is None:
                member.type = tarfile.SYMTYPE
                member.linkname = '/tmp/native-escape'
                tar.addfile(member)
            else:
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
    return stream.getvalue()


def payload(extra=()):
    required = ('backend/pyproject.toml', 'backend/uv.lock', 'backend/medvisit/main.py',
                'deploy/native-backup.py', 'deploy/Caddyfile.native')
    source = archive([(name, b'synthetic') for name in required] + list(extra))
    web = archive([('./index.html', b'<script src="/assets/app.js"></script>'), ('./assets/app.js', b'console.log(1)')])
    return [('REVISION', b'a'*40), ('source.tar', source), ('web.tar.gz', web)]


def receive(tmp_path, entries):
    return subprocess.run([sys.executable, '-c', RECEIVER, str(tmp_path)], input=archive(entries, compressed=False), capture_output=True)


def test_native_protocol_roundtrip_accepts_prebuilt_web_and_compressed_source(tmp_path):
    assert receive(tmp_path, payload()).returncode == 0
    release = tmp_path/'release'
    release.mkdir()
    result = subprocess.run([sys.executable, '-c', EXTRACTOR, str(tmp_path), str(release)], capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    assert (release/'frontend/dist/assets/app.js').is_file()
    assert (release/'backend/uv.lock').read_bytes() == b'synthetic'


@pytest.mark.parametrize('entries', [payload()[:-1], payload()+[('REVISION', b'b'*40)], payload()+[('../escape', b'bad')], [('REVISION', None)]])
def test_native_envelope_rejects_missing_duplicate_traversal_and_symlink(tmp_path, entries):
    assert receive(tmp_path, entries).returncode != 0
    assert not (tmp_path.parent/'escape').exists()


@pytest.mark.parametrize('entry', [('../escape', b'x'), ('/absolute', b'x'), ('backend/.env', b'private'), ('backend/.venv/config', b'bad'), ('backend/link', None), ('backend/uv.lock', b'duplicate')])
def test_native_extractor_rejects_unsafe_source_members(tmp_path, entry):
    assert receive(tmp_path, payload([entry])).returncode == 0
    release = tmp_path/'release'
    release.mkdir()
    result = subprocess.run([sys.executable, '-c', EXTRACTOR, str(tmp_path), str(release)], capture_output=True)
    assert result.returncode != 0


def test_native_receive_size_is_checked_before_reading_large_body(tmp_path):
    member = tarfile.TarInfo('source.tar')
    member.size = 17*1024*1024
    result = subprocess.run([sys.executable, '-c', RECEIVER, str(tmp_path)], input=member.tobuf()+b'\0'*1024, capture_output=True)
    assert result.returncode != 0
    assert not (tmp_path/'source.tar').exists()


def test_native_extractor_bounds_gzip_expansion_before_tar_parsing(tmp_path):
    entries = payload()
    entries[-1] = ('web.tar.gz', gzip.compress(b'\0'*(33*1024*1024)))
    assert receive(tmp_path, entries).returncode == 0
    release = tmp_path/'release'
    release.mkdir()
    result = subprocess.run([sys.executable, '-c', EXTRACTOR, str(tmp_path), str(release)], capture_output=True)
    assert result.returncode != 0 and b'expanded size limit' in result.stderr


@pytest.mark.parametrize('interrupt', [None, signal.SIGTERM, signal.SIGHUP, signal.SIGINT])
def test_native_failure_and_cancellation_restore_previous_release(tmp_path, interrupt):
    root = tmp_path/'root'
    root.mkdir()
    previous, release, stage = [root/name for name in ('previous', 'candidate', 'stage')]
    for path in (previous, release, stage):
        path.mkdir()
    (root/'current').symlink_to(release)
    (stage/'Caddyfile.previous').write_text('old proxy')
    caddy = root/'Caddyfile'
    caddy.write_text('candidate proxy')
    cancel = 'cancel() {' + SCRIPT.split('cancel() {', 1)[1].split('\n\nfinish()', 1)[0]
    finish = 'finish() {' + SCRIPT.split('finish() {', 1)[1].split('\ntrap finish EXIT', 1)[0]
    finish = finish.replace('/etc/caddy/Caddyfile', str(caddy))
    # macOS lacks GNU mv -T; os.replace exercises the same atomic symlink replacement.
    harness = '''set -Eeuo pipefail
root=$1; previous=$root/previous; release=$root/candidate; stage=$root/stage
changed=true; committed=false; active_pid=; service=medvisit-coach.service
mv() { python3 -c 'import os,sys; os.replace(sys.argv[-2],sys.argv[-1])' "$@"; }
systemctl() { printf '%s\\n' "$*" >> "$root/actions"; }
timeout() { shift 2; "$@"; }
''' + cancel + '\n' + finish + '''
trap finish EXIT
trap 'cancel 143' TERM
trap 'cancel 129' HUP
trap 'cancel 130' INT
'''
    harness += 'exit 7\n' if interrupt is None else 'sleep 30 &\nactive_pid=$!\nprintf ready > "$root/ready"\nwait "$active_pid"\n'
    process = subprocess.Popen(['bash', '-c', harness, 'native-test', str(root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if interrupt is not None:
        for _ in range(100):
            if (root/'ready').exists():
                break
            time.sleep(0.01)
        assert (root/'ready').exists()
        process.send_signal(interrupt)
    _, error = process.communicate(timeout=5)
    assert process.returncode == (7 if interrupt is None else 128+interrupt), error.decode()
    assert (root/'current').resolve() == previous
    assert caddy.read_text() == 'old proxy'
    assert (root/'actions').read_text().splitlines() == ['restart medvisit-coach.service', 'reload caddy']
    assert not release.exists() and not stage.exists()

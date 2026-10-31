#!/usr/bin/env bash
# Installed root-owned as the restricted SSH entry point after native bootstrap.
set -Eeuo pipefail
umask 077
root=/srv/medvisit-coach
service=medvisit-coach.service
[[ "$(id -u)" == 0 && "$(id -u medvisit)" == 10001 ]]
exec 9>"$root/deploy.lock"
flock -w 900 9
previous=$(readlink -f "$root/current")
[[ "$previous" == "$root/releases/"* && -x "$previous/backend/.venv/bin/python" ]]
systemctl is-active --quiet "$service"
stage=$(mktemp -d "$root/.native-incoming.XXXXXX")
release=
active_pid=
changed=false
committed=false
lock_saved=false

run() {
    local duration=$1 status=0
    shift
    timeout --signal=TERM --kill-after=10s "$duration" "$@" <&0 &
    active_pid=$!
    wait "$active_pid" || status=$?
    active_pid=
    return "$status"
}

cancel() {
    local status=$1
    trap '' TERM HUP INT
    if [[ -n "$active_pid" ]]; then
        kill -TERM -- "-$active_pid" 2>/dev/null || kill -TERM "$active_pid" 2>/dev/null || true
        wait "$active_pid" 2>/dev/null || true
    fi
    exit "$status"
}

finish() {
    local status=$?
    trap - EXIT
    trap '' TERM HUP INT
    if ${lock_saved:-false} && [[ -f "$stage/uv.lock.original" ]]; then
        cp "$stage/uv.lock.original" "$release/backend/uv.lock"
    fi
    if $changed && ! $committed; then
        echo 'Native deployment interrupted; restoring the previous release.' >&2
        ln -s "$previous" "$stage/current-previous"
        mv -Tf "$stage/current-previous" "$root/current"
        cp "$stage/Caddyfile.previous" /etc/caddy/Caddyfile
        timeout --kill-after=10s 120 systemctl restart "$service" || true
        timeout --kill-after=10s 30 systemctl reload caddy || true
    fi
    rm -rf "$stage"
    if [[ -n "$release" ]] && ! $committed; then rm -rf "$release"; fi
    exit "$status"
}
trap finish EXIT
trap 'cancel 143' TERM
trap 'cancel 129' HUP
trap 'cancel 130' INT
cp /etc/caddy/Caddyfile "$stage/Caddyfile.previous"

# Bound the slow SSH receive before any running service is touched.
run 600 python3 -c '
import pathlib, sys, tarfile
stage = pathlib.Path(sys.argv[1])
limits = {"REVISION": 41, "source.tar": 16*1024*1024, "web.tar.gz": 16*1024*1024}
seen = set()
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    for member in archive:
        if member.name not in limits or member.name in seen or not member.isfile() or member.sparse is not None or not 0 < member.size <= limits[member.name]:
            raise SystemExit("Invalid native deployment envelope")
        seen.add(member.name)
        archive.extract(member, stage, filter="data")
if seen != set(limits):
    raise SystemExit("Incomplete native deployment envelope")
' "$stage"
revision=$(cat "$stage/REVISION")
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
release="$root/releases/$revision-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$release"
run 60 python3 -c '
import gzip, pathlib, sys, tarfile
stage, release = map(pathlib.Path, sys.argv[1:])
for filename, destination, allowed, maximum in (
    ("source.tar", release, {"backend", "deploy", "LICENSE"}, 64*1024*1024),
    ("web.tar.gz", release/"frontend/dist", {"index.html", "assets", "licenses", "favicon.svg"}, 32*1024*1024),
):
    destination.mkdir(parents=True, exist_ok=True)
    unpacked = stage/(filename+".unpacked")
    expanded = 0
    with gzip.open(stage/filename, "rb") as compressed, unpacked.open("wb") as raw:
        while chunk := compressed.read(1024*1024):
            expanded += len(chunk)
            if expanded > maximum:
                raise SystemExit("Native release exceeds expanded size limit")
            raw.write(chunk)
    seen, total = set(), 0
    with tarfile.open(unpacked, mode="r:") as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if not name.parts and member.isdir():
                continue
            total += member.size
            if name.is_absolute() or ".." in name.parts or "\\" in member.name or not name.parts or name.parts[0] not in allowed or not (member.isdir() or member.isfile()) or member.sparse is not None or member.size < 0 or total > maximum or str(name) in seen or any(p == ".env" or p.startswith(".env.") or p == ".venv" for p in name.parts):
                raise SystemExit("Unsafe native release archive")
            seen.add(str(name))
            archive.extract(member, destination, filter="data")
    for path in destination.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)
required = ("backend/pyproject.toml", "backend/uv.lock", "backend/medvisit/main.py", "deploy/native-backup.py", "deploy/Caddyfile.native", "frontend/dist/index.html")
if any(not (release/name).is_file() for name in required) or not any((release/"frontend/dist/assets").glob("*.js")):
    raise SystemExit("Incomplete native release")
' "$stage" "$release"
printf '%s\n' "$revision" > "$release/REVISION"
# The host runtime is administrator-installed; CD never downloads Python or builds Web UI.
python3 -c 'import sys; assert sys.version_info >= (3,12)'
[[ -f /etc/medvisit-coach/database.compose.yaml && -f /etc/medvisit-coach/compose.env ]]
cp "$release/backend/uv.lock" "$stage/uv.lock.original"
lock_saved=true
# Reuse the existing administrator-selected wheel mirror without changing locked hashes.
run 30 python3 -c '
from pathlib import Path
import shlex, sys
from urllib.parse import urlsplit
base = "https://files.pythonhosted.org"
for line in Path(sys.argv[1]).read_text().splitlines():
    key, separator, value = line.partition("=")
    if separator and key.strip() == "PYPI_DOWNLOAD_BASE":
        parts = shlex.split(value, comments=True)
        if len(parts) != 1:
            raise SystemExit("Invalid administrator wheel mirror configuration")
        base = parts[0].rstrip("/")
parsed = urlsplit(base)
if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
    raise SystemExit("Wheel mirror must be an HTTPS origin without credentials")
lock = Path(sys.argv[2])
lock.write_text(lock.read_text().replace("https://files.pythonhosted.org", base))
' /etc/medvisit-coach/compose.env "$release/backend/uv.lock"
run 900 /usr/local/bin/uv sync --directory "$release/backend" --locked --no-dev --no-install-project --python /usr/bin/python3 --no-python-downloads
cp "$stage/uv.lock.original" "$release/backend/uv.lock"
lock_saved=false
chmod -R a+rX "$release"
run 30 /usr/bin/caddy validate --config "$release/deploy/Caddyfile.native" --adapter caddyfile
sessions_dir=$(docker volume inspect --format '{{.Mountpoint}}' medvisit-coach_research_data)
[[ "$sessions_dir" == /var/lib/docker/volumes/*/_data && -d "$sessions_dir" ]]
# Bootstrap installs these private, database-only files and the hardened systemd unit.
changed=true
run 90 systemctl stop "$service"
run 900 python3 "$release/deploy/native-backup.py" --project medvisit-coach \
    --compose-file /etc/medvisit-coach/database.compose.yaml --env-file /etc/medvisit-coach/compose.env \
    --sessions-dir "$sessions_dir" --service "$service" backup \
    "/var/backups/medvisit-coach/$(date -u +%Y%m%dT%H%M%SZ)-$(cat "$previous/REVISION")"
ln -s "$release" "$stage/current-next"
mv -Tf "$stage/current-next" "$root/current"
install -m 644 "$release/deploy/Caddyfile.native" /etc/caddy/Caddyfile
run 90 systemctl restart "$service"
run 30 systemctl reload caddy
run 90 python3 -c '
import json, time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
origin = "http://127.0.0.1:8000"
for attempt in range(30):
    try:
        with urlopen(origin+"/api/ready", timeout=2) as response:
            if response.status == 200: break
    except (OSError, URLError): pass
    time.sleep(1)
else: raise SystemExit("Native API did not become ready")
with urlopen(origin+"/api/auth/session", timeout=5) as response:
    session = json.load(response)
    assert session["enabled"] is True and session["authenticated"] is False
try:
    urlopen(origin+"/api/sessions", timeout=5)
except HTTPError as error:
    assert error.code == 401
    error.close()
else: raise AssertionError("Anonymous business access must be denied")
with urlopen("https://openwook.cloud/api/ready", timeout=10) as response:
    assert response.status == 200
for path, expected in (("/app",410), ("/_android/index.html",404)):
    try: urlopen("https://openwook.cloud"+path, timeout=10)
    except HTTPError as error:
        assert error.code == expected
        error.close()
    else: raise AssertionError("Invalid native Web route boundary")
'
committed=true
printf 'Deployed native release %s\n' "$revision"

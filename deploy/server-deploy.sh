#!/usr/bin/env bash
# Installed root-owned at /usr/local/sbin/medvisit-deploy; invoked by a restricted SSH key.
set -Eeuo pipefail
umask 077
root=/srv/medvisit-coach
mkdir -p "$root/releases" /var/backups/medvisit-coach
exec 9>"$root/deploy.lock"
flock -w 900 9
stage=$(mktemp -d "$root/.incoming.XXXXXX")
previous=$(readlink -f "$root/current" || true)
changed=false
caddy_backup="$stage/Caddyfile.previous"
cp /etc/caddy/Caddyfile "$caddy_backup"

compose() {
    docker compose --project-name medvisit-coach --project-directory "$1" "${@:2}"
}

finish() {
    status=$?
    trap - EXIT
    if (( status != 0 )) && $changed; then
        echo 'Deployment failed; restoring the previous application and proxy configuration.' >&2
        if [[ -n "$previous" && -f "$previous/REVISION" ]]; then
            compose "$previous" up -d --no-build --pull never --wait --wait-timeout 180 || true
        else
            compose "$release" stop api web || true
        fi
        cp "$caddy_backup" /etc/caddy/Caddyfile
        systemctl reload caddy || true
    fi
    rm -rf "$stage"
    exit "$status"
}
trap finish EXIT

# Only the three regular files emitted by CI may enter the privileged staging directory.
python3 -c '
import sys, tarfile
allowed = {"REVISION", "source.tar", "images.tar.gz"}
seen = set()
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    for member in archive:
        if member.name not in allowed or not member.isfile() or member.name in seen:
            raise SystemExit("Unexpected deployment archive entry")
        seen.add(member.name)
        archive.extract(member, path=sys.argv[1], filter="data")
if seen != allowed:
    raise SystemExit("Incomplete deployment archive")
' "$stage"
revision=$(cat "$stage/REVISION")
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release revision' >&2; exit 1; }
release="$root/releases/$revision-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$release"
python3 -c '
import sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
' "$stage/source.tar" "$release"
cp "$stage/REVISION" "$release/REVISION"
cp /etc/medvisit-coach/compose.env "$release/.env"
printf '\nRELEASE_SHA=%s\n' "$revision" >> "$release/.env"
ln -s /etc/medvisit-coach/backend.env "$release/backend/.env"
grep -qx 'AUTH_REQUIRED=true' "$release/.env"
grep -qx 'ALLOWED_ORIGINS=https://openwook.cloud' "$release/.env"
compose "$release" config --quiet
caddy validate --config "$release/deploy/Caddyfile" --adapter caddyfile
# Images are built on GitHub; the production host needs no registry credentials or build toolchain.
docker load --input "$stage/images.tar.gz"
if [[ -n "$previous" && -f "$previous/REVISION" ]]; then
    python3 "$previous/deploy/backup.py" --project medvisit-coach backup \
        "/var/backups/medvisit-coach/$(date -u +%Y%m%dT%H%M%SZ)-$(cat "$previous/REVISION")"
fi
changed=true
compose "$release" up -d --no-build --pull never --wait --wait-timeout 180
python3 - <<'PY'
import json
from urllib.error import HTTPError
from urllib.request import urlopen
origin = 'http://127.0.0.1:8080'
for path in ('/', '/api/live', '/api/ready'):
    with urlopen(origin+path, timeout=10) as response:
        assert response.status == 200
with urlopen(origin+'/api/auth/session', timeout=10) as response:
    session = json.load(response)
    assert session['enabled'] is True and session['authenticated'] is False
try:
    urlopen(origin+'/api/sessions', timeout=10)
except HTTPError as error:
    assert error.code == 401
    error.close()
else:
    raise AssertionError('Anonymous record access must be denied')
print('Production health and authentication checks passed')
PY
install -m 644 "$release/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy
ln -s "$release" "$root/.current-next"
mv -Tf "$root/.current-next" "$root/current"
printf 'Deployed %s\n' "$revision"

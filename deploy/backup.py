#!/usr/bin/env python3
"""Private, consistent Compose backups; restore only into a fresh project."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PAYLOADS = ('database.dump', 'files.tar')
COUNTS = "SELECT json_build_object('postgres_major',current_setting('server_version_num')::int/10000,'sessions',(SELECT count(*) FROM sessions),'platform_entities',(SELECT count(*) FROM platform_entities))"


def command(args, *, source=None, output=None, missing_ok=False):
    result = subprocess.run(args, stdin=source, stdout=output or subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=900)
    if result.returncode:
        if missing_ok and b'Could not find the file' in result.stderr:
            return None
        raise RuntimeError(f'{args[0]} operation failed; inspect the selected project logs.')
    return result.stdout or b''


def private_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb')


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda:stream.read(1024*1024), b''):
        result.update(chunk)
    return result.hexdigest()


def sha256(path):
    with path.open('rb') as stream:
        return digest(stream)


def archive_files(path):
    files, names = {}, set()
    archive_size = path.stat().st_size
    with tarfile.open(path, 'r:') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name or not (member.isdir() or member.isfile()) or member.sparse is not None or member.size > archive_size or (member.isfile() and not name.parts):
                raise ValueError('Unsafe filesystem archive member.')
            if any(part == '.env' or part.startswith('.env.') for part in name.parts):
                raise ValueError('Environment files must not be included in backups.')
            normalized = str(name)
            if normalized in names:
                raise ValueError('Duplicate filesystem archive member.')
            names.add(normalized)
            if member.isfile():
                with archive.extractfile(member) as stream:
                    files[normalized] = digest(stream)
    return files


def verify(folder):
    if folder.is_symlink() or any((folder/name).is_symlink() for name in (*PAYLOADS, 'manifest.json')):
        raise ValueError('Backup paths must not be symbolic links.')
    if not folder.is_dir() or any(not (folder/name).is_file() for name in (*PAYLOADS, 'manifest.json')):
        raise ValueError('Backup must contain regular files for every payload and manifest.')
    manifest = json.loads((folder/'manifest.json').read_text())
    if not isinstance(manifest, dict) or type(manifest.get('format')) is not int or manifest['format'] != 1:
        raise ValueError('Unsupported or incomplete backup.')
    if any(not isinstance(manifest.get(key), dict) for key in ('sha256', 'files', 'database')) or set(manifest['sha256']) != set(PAYLOADS):
        raise ValueError('Unsupported or incomplete backup.')
    if not isinstance(manifest.get('source_project'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', manifest['source_project']):
        raise ValueError('Invalid source project.')
    if set(manifest['database']) != {'postgres_major', 'sessions', 'platform_entities'} or any(
            type(value) is not int or value < 0 for value in manifest['database'].values()):
        raise ValueError('Missing database schema/count verification data.')
    for name in PAYLOADS:
        if sha256(folder/name) != manifest['sha256'][name]:
            raise ValueError(f'Backup checksum mismatch: {name}')
    with (folder/'database.dump').open('rb') as stream:
        if stream.read(5) != b'PGDMP':
            raise ValueError('Expected a PostgreSQL custom-format dump.')
    if archive_files(folder/'files.tar') != manifest.get('files'):
        raise ValueError('Filesystem member checksums do not match the manifest.')
    return manifest


def db(compose, executable, *args, **kwargs):
    return command([*compose, 'exec', '-T', 'db', 'sh', '-c',
        'exec "$@" -U "$POSTGRES_USER" -d "$POSTGRES_DB"', 'medvisit-backup', executable, *args], **kwargs)


def backup(compose, project, target):
    if target.exists():
        raise ValueError('Backup destination already exists; use a new directory.')
    container = command([*compose, 'ps', '-a', '-q', 'api']).decode().strip()
    if not container or '\n' in container:
        raise ValueError('Expected exactly one existing API container.')
    running = bool(command([*compose, 'ps', '--status', 'running', '-q', 'api']).strip())
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = Path(tempfile.mkdtemp(prefix=f'.{target.name}.', dir=target.parent))
    captured = False
    restart_error = None
    try:
        try:
            if running:
                command([*compose, 'stop', 'api'])
            counts = json.loads(db(compose, 'psql', '-Atc', COUNTS))
            with private_file(stage/'database.dump') as stream:
                db(compose, 'pg_dump', '-Fc', '--no-owner', '--no-acl', output=stream)
            with private_file(stage/'files.tar') as stream:
                # docker cp also captures pre-volume container-layer archives during the first upgrade.
                copied = command(['docker', 'cp', f'{container}:/app/data/sessions/.', '-'], output=stream, missing_ok=True)
            if copied is None:
                with tarfile.open(stage/'files.tar', 'w:'):
                    pass
                (stage/'files.tar').chmod(0o600)
            captured = True
        finally:
            if running:
                try:
                    command([*compose, 'up', '-d', '--no-deps', '--no-recreate', '--wait', '--wait-timeout', '90', 'api'])
                except (OSError, RuntimeError, subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
                    if not captured:
                        raise
                    # A failed API restart must not discard a completed backup.
                    restart_error = exc
        manifest = {'format':1, 'created_at':datetime.now(timezone.utc).isoformat(), 'source_project':project,
            'database':counts, 'sha256':{name:sha256(stage/name) for name in PAYLOADS},
            'files':archive_files(stage/'files.tar')}
        with private_file(stage/'manifest.json') as stream:
            stream.write(json.dumps(manifest, ensure_ascii=False, indent=2).encode())
        verify(stage)
        if target.exists():
            raise ValueError('Backup destination appeared during the operation.')
        stage.rename(target)
        if restart_error is not None:
            print(f'Backup verified and retained at {target}; API restart failed.', file=sys.stderr)
            raise restart_error
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def restore(compose, project, folder):
    manifest = verify(folder)
    if project == manifest['source_project']:
        raise ValueError('Restore requires a different, fresh project name.')
    for resource in ('container', 'volume'):
        if command(['docker', resource, 'ls', '-q', *(['-a'] if resource == 'container' else []), '--filter', f'label=com.docker.compose.project={project}']).strip():
            raise ValueError('Restore target already has containers or volumes; nothing was restored.')
    command([*compose, 'up', '-d', '--wait', 'db'])
    existing = db(compose, 'psql', '-Atc', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    if existing.strip() != b'0':
        raise ValueError('Target database is not empty; API remains stopped.')
    version = db(compose, 'psql', '-Atc', "SELECT current_setting('server_version_num')::int/10000")
    if int(version) != manifest['database']['postgres_major']:
        raise ValueError('Restore with the same PostgreSQL major version first.')
    with (folder/'database.dump').open('rb') as stream:
        db(compose, 'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', source=stream)
    helper = [*compose, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'api', '-c']
    with (folder/'files.tar').open('rb') as stream:
        command([*helper, 'test -z "$(ls -A /app/data/sessions)" && umask 077 && exec tar --no-same-owner --no-same-permissions -C /app/data/sessions -xf -'], source=stream)
    check_files = """import hashlib,json,pathlib
root=pathlib.Path('/app/data/sessions')
files={}
for path in root.rglob('*'):
 if path.is_file():
  with path.open('rb') as stream: files[str(path.relative_to(root))]=hashlib.file_digest(stream,'sha256').hexdigest()
print(json.dumps(files))
"""
    actual = command([*compose, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'python', 'api', '-c', check_files])
    if json.loads(actual) != manifest['files'] or json.loads(db(compose, 'psql', '-Atc', COUNTS)) != manifest['database']:
        raise ValueError('Restored database or filesystem verification failed; API remains stopped.')


@contextmanager
def project_lock(project):
    path = Path(tempfile.gettempdir())/f'medvisit-backup-{os.getuid()}-{project}.lock'
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another backup or restore is already using this project.')
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default='medvisit-coach')
    parser.add_argument('--compose-file', type=Path, default=ROOT/'compose.yaml')
    parser.add_argument('operation', choices=['backup', 'verify', 'restore'])
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', args.project):
        parser.error('Use a lowercase Compose project name containing letters, digits, - or _.')
    compose = ['docker', 'compose', '--project-directory', str(ROOT), '-f', str(args.compose_file.resolve()), '-p', args.project]
    try:
        with project_lock(args.project):
            if args.operation == 'backup':
                backup(compose, args.project, args.directory.resolve())
            elif args.operation == 'restore':
                restore(compose, args.project, args.directory.absolute())
            else:
                verify(args.directory.absolute())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, tarfile.TarError) as exc:
        parser.exit(1, f'{exc}\n')
    print(f'{args.operation} verified: {args.directory}')
    if args.operation == 'restore':
        print('API and web were not started. Review restored tracking settings before starting services.')


if __name__ == '__main__':
    main()

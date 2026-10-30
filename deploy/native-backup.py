#!/usr/bin/env python3
"""Back up PostgreSQL and session archives while the native API is stopped."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('medvisit_backup_common', Path(__file__).with_name('backup.py'))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def stopped(service):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*\.service', service):
        raise ValueError('Use an explicit systemd service name.')
    output = shared.command(['systemctl', 'show', service, '--property=LoadState', '--property=ActiveState'])
    state = dict(line.split('=', 1) for line in output.decode().splitlines() if '=' in line)
    if state.get('LoadState') != 'loaded' or state.get('ActiveState') not in ('inactive', 'failed'):
        raise ValueError('Stop the loaded native API service before taking a consistent backup.')


def archive_member(member):
    parts = PurePosixPath(member.name).parts
    if 'visit-audio' in parts:
        return None
    if (not (member.isdir() or member.isfile()) or member.sparse is not None
            or any(part == '.env' or part.startswith('.env.') for part in parts)):
        raise ValueError('Session archives must not contain links, devices, or environment files.')
    return member


def backup(compose, project, target, sessions, service):
    if target.exists() or target.is_symlink():
        raise ValueError('Backup destination already exists; use a new directory.')
    if sessions.is_symlink() or not sessions.is_dir():
        raise ValueError('Session source must be an existing directory, not a symbolic link.')
    if target.resolve().is_relative_to(sessions.resolve()):
        raise ValueError('Backup destination must be outside the session source.')
    stopped(service)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = Path(tempfile.mkdtemp(prefix=f'.{target.name}.', dir=target.parent))
    try:
        counts = json.loads(shared.db(compose, 'psql', '-Atc', shared.COUNTS))
        with shared.private_file(stage/'database.dump') as output:
            shared.db(compose, 'pg_dump', '-Fc', '--no-owner', '--no-acl', output=output)
        with shared.private_file(stage/'files.tar') as output:
            with tarfile.open(fileobj=output, mode='w:', dereference=False) as archive:
                archive.add(sessions, arcname='.', filter=archive_member)
        manifest = {'format':1, 'created_at':datetime.now(timezone.utc).isoformat(), 'source_project':project,
            'database':counts, 'sha256':{name:shared.sha256(stage/name) for name in shared.PAYLOADS},
            'files':shared.archive_files(stage/'files.tar'), 'excluded_directories':['visit-audio']}
        with shared.private_file(stage/'manifest.json') as output:
            output.write(json.dumps(manifest, ensure_ascii=False, indent=2).encode())
        shared.verify(stage)
        if target.exists() or target.is_symlink():
            raise ValueError('Backup destination appeared during the operation.')
        stage.rename(target)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default='medvisit-coach')
    parser.add_argument('--compose-file', type=Path, default=Path('/etc/medvisit-coach/database.compose.yaml'))
    parser.add_argument('--env-file', type=Path, default=Path('/etc/medvisit-coach/compose.env'))
    parser.add_argument('--sessions-dir', type=Path)
    parser.add_argument('--service', default='medvisit-coach.service')
    parser.add_argument('operation', choices=['backup', 'verify'])
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', args.project):
        parser.error('Use a lowercase Compose project name containing letters, digits, - or _.')
    if args.operation == 'backup' and args.sessions_dir is None:
        parser.error('--sessions-dir is required for backup.')
    compose = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(args.env_file.absolute()),
               '-f', str(args.compose_file.absolute()), '-p', args.project]
    try:
        with shared.project_lock(args.project):
            if args.operation == 'backup':
                backup(compose, args.project, args.directory.absolute(), args.sessions_dir.absolute(), args.service)
            else:
                shared.verify(args.directory.absolute())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, tarfile.TarError) as exc:
        parser.exit(1, f'{exc}\n')
    print(f'{args.operation} verified: {args.directory}')


if __name__ == '__main__':
    main()

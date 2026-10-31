"""Authenticated, isolated E2E server. Provider settings come from the normal local configuration."""
import os
from pathlib import Path
from urllib.parse import urlsplit

from medvisit.api.app import create_app
from medvisit.api.auth import hash_password
from medvisit.core.config import Settings


def build():
    root = Path(os.environ['E2E_DATA_DIR']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError('E2E_DATA_DIR must be a fresh empty directory')
    database = os.getenv('E2E_DATABASE_URL', '')
    if database:
        parsed = urlsplit(database)
        if parsed.hostname not in ('127.0.0.1', 'localhost') or not parsed.path.startswith('/breathon_e2e'):
            raise ValueError('E2E database must be a dedicated local breathon_e2e database')
    password = hash_password('local-e2e-only-password')
    return create_app(Settings(records=root/'sessions', database_url=database,
        auth_required=True, admin_username='e2e-admin', admin_password_hash=password,
        login_users={name:password for name in ('e2e-admin','e2e-medical','e2e-compliance','e2e-a','e2e-b')},
        admin_users=['e2e-admin','e2e-medical','e2e-compliance'],
        origins=('http://127.0.0.1:5187',)))

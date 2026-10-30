"""Transactional workspace data; PostgreSQL in Compose, SQLite for local use."""
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
from uuid import uuid4

from psycopg.errors import UniqueViolation


def now():
    return datetime.now(timezone.utc).isoformat()


class Conflict(Exception):
    pass


class Transaction:
    def __init__(self, connection, postgres=False):
        self.connection, self.postgres = connection, postgres

    def execute(self, sql, params=()):
        return self.connection.execute(sql.replace('?', '%s') if self.postgres else sql, params)

    def get(self, tenant, kind, item_id):
        row = self.execute('SELECT document FROM platform_entities WHERE tenant_id=? AND kind=? AND id=?',
                           (tenant, kind, item_id)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, tenant, kind):
        rows = self.execute('SELECT document FROM platform_entities WHERE tenant_id=? AND kind=? ORDER BY updated_at DESC, id',
                            (tenant, kind)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def create(self, tenant, kind, data, *, item_id=None):
        item = {**data, 'id': item_id or str(uuid4()), 'version': 1, 'created_at': now(), 'updated_at': now()}
        try:
            self.execute('INSERT INTO platform_entities (tenant_id,kind,id,version,document,updated_at) VALUES (?,?,?,?,?,?)',
                         (tenant, kind, item['id'], 1, json.dumps(item, ensure_ascii=False), item['updated_at']))
        except (sqlite3.IntegrityError, UniqueViolation) as exc:
            raise Conflict('记录已存在，请刷新后重试。') from exc
        return item

    def update(self, tenant, kind, item_id, data, version):
        old = self.get(tenant, kind, item_id)
        if old is None or old['version'] != version:
            raise Conflict('记录已被修改，请刷新后重试。')
        item = {**data, 'id': item_id, 'created_at': old['created_at'], 'updated_at': now(), 'version': version + 1}
        result = self.execute('UPDATE platform_entities SET document=?,version=?,updated_at=? WHERE tenant_id=? AND kind=? AND id=? AND version=?',
                              (json.dumps(item, ensure_ascii=False), item['version'], item['updated_at'], tenant, kind, item_id, version))
        if result.rowcount != 1:
            raise Conflict('记录已被修改，请刷新后重试。')
        return item

    def delete(self, tenant, kind, item_id):
        self.execute('DELETE FROM platform_entities WHERE tenant_id=? AND kind=? AND id=?', (tenant, kind, item_id))

    def audit(self, tenant, actor, action, kind, item_id, detail=None):
        return self.create(tenant, 'audit', {'actor_id': actor, 'action': action, 'kind': kind,
                                           'object_id': item_id, 'detail': detail or {}})


class PlatformStore:
    def __init__(self, path: Path, pool=None):
        self.path, self.pool = path, pool

    def open(self):
        if not self.pool:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
            os.close(fd)
            os.chmod(self.path, 0o600)
            # Readers keep their snapshot without holding up commits from other requests.
            with closing(sqlite3.connect(self.path, timeout=5)) as connection:
                connection.execute('PRAGMA journal_mode=WAL')
        schema = Path(__file__).resolve().parents[2] / 'migrations/002_platform.sql'
        with self.transaction() as tx:
            for statement in schema.read_text().split(';'):
                if statement.strip():
                    tx.execute(statement)

    @contextmanager
    def transaction(self, tenant='', *, write=True):
        if self.pool:
            with self.pool.connection() as connection:
                # Workspace mutations serialize across workers; unrelated workspaces remain independent.
                if write:
                    connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (tenant,))
                yield Transaction(connection, postgres=True)
        else:
            connection = sqlite3.connect(self.path, timeout=5)
            try:
                connection.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
                yield Transaction(connection)
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            finally:
                connection.close()

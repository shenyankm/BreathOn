"""PostgreSQL session repository; calls run outside the ASGI event loop."""
from pathlib import Path
from uuid import UUID

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .records import SessionRecord, timestamp, activity_record, usable_activity


def scope_sql(workspace, owner_id, team):
    conditions, params = [], []
    if workspace is not None:
        conditions.append("document->>'workspace' = %s")
        params.append(workspace)
    if owner_id is not None:
        conditions.append("(document->>'owner_id' = %s OR (%s <> '' AND document->>'team' = %s))")
        params.extend((owner_id, team or '', team or ''))
    return (' WHERE ' + ' AND '.join(conditions) if conditions else ''), params


class PostgresRecords:
    def __init__(self, database_url: str):
        self.pool = ConnectionPool(
            database_url, open=False, min_size=1, max_size=4, timeout=5,
            kwargs={"connect_timeout": 5, "options": "-c statement_timeout=5000"},
        )

    def open(self):
        self.pool.open(wait=True, timeout=10)
        schema = Path(__file__).resolve().parents[2] / "migrations/001_sessions.sql"
        with self.pool.connection() as connection:
            connection.execute(schema.read_text(), prepare=False)

    def close(self):
        self.pool.close()

    def check(self):
        with self.pool.connection() as connection:
            connection.execute("SELECT 1")

    def save(self, record: SessionRecord, status: str):
        record.data.update(status=status, ended_at=timestamp())
        record.data['activity'] = activity_record(record.data)
        with self.pool.connection() as connection:
            connection.execute(
                "INSERT INTO sessions (id, document) VALUES (%s, %s) "
                "ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, saved_at = now()",
                (UUID(record.data["id"]), Jsonb(record.data)),
            )

    def list(self, *, workspace=None, owner_id=None, team=None, limit=50, include_owner=False):
        where, params = scope_sql(workspace, owner_id, team)
        limit_sql = ' LIMIT %s' if limit is not None else ''
        if limit is not None:
            params.append(limit)
        owner_sql = ", document->'owner_id'" if include_owner else ''
        with self.pool.connection() as connection:
            rows = connection.execute(
                "SELECT id, document->>'experience', document->>'mode', document->>'started_at', "
                "document->>'ended_at', document->>'status', jsonb_array_length(document->'messages'), document->'training'->'scenario'->>'title'"
                + owner_sql + " FROM sessions" + where + " ORDER BY saved_at DESC, id DESC" + limit_sql, params,
            ).fetchall()
        fields = ("id", "experience", "mode", "started_at", "ended_at", "status", "message_count", "scenario_title")
        if include_owner:
            fields += ('owner_id',)
        return [dict(zip(fields, (str(row[0]), *row[1:]))) for row in rows]

    def get(self, session_id: UUID):
        with self.pool.connection() as connection:
            row = connection.execute("SELECT document FROM sessions WHERE id = %s", (session_id,)).fetchone()
        return row[0] if row else None

    def get_many(self, session_ids):
        if not session_ids:
            return {}
        with self.pool.connection() as connection:
            rows = connection.execute('SELECT id, document FROM sessions WHERE id = ANY(%s)', (session_ids,)).fetchall()
        return {str(row[0]):row[1] for row in rows}

    def activity(self, *, workspace=None, owner_id=None, team=None):
        where, params = scope_sql(workspace, owner_id, team)
        with self.pool.connection() as connection:
            rows = connection.execute("SELECT id, document->'activity'->>'format' = '2', "
                "CASE WHEN document->'activity'->>'format' = '2' THEN document->'activity' ELSE document END "
                "FROM sessions" + where + " ORDER BY saved_at, id", params).fetchall()
        result = []
        for session_id, cached, data in rows:
            try:
                if cached and usable_activity(data, str(session_id)):
                    result.append(data)
                else:
                    rebuilt = activity_record(self.get(session_id) if cached else data)
                    if usable_activity(rebuilt, str(session_id)):
                        result.append(rebuilt)
            except (ValueError, TypeError, AttributeError, KeyError):
                continue
        return result

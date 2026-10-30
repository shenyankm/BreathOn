CREATE TABLE IF NOT EXISTS platform_entities (
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    document TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, kind, id)
);
CREATE INDEX IF NOT EXISTS platform_entities_kind ON platform_entities (tenant_id, kind, updated_at);

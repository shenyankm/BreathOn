CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY,
    document jsonb NOT NULL CHECK (
        jsonb_typeof(document) = 'object'
        AND jsonb_typeof(document->'id') = 'string' AND (document->>'id' = id::text) IS TRUE
        AND document ? 'messages' AND jsonb_typeof(document->'messages') = 'array'
    ),
    saved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_saved_at_idx ON sessions (saved_at DESC, id DESC);

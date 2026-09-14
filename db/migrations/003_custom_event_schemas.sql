-- Migration 003: Per-contract custom event schemas (subgraph-style indexing)
-- Run with: psql $DATABASE_URL -f db/migrations/003_custom_event_schemas.sql

\echo 'Running migration 003: custom event schemas...'

-- One row per contract that has registered a schema. The definition is stored
-- as JSONB rather than shredded into tables because it is read whole, once per
-- indexer start, and never queried by its parts.
CREATE TABLE IF NOT EXISTS contract_schemas (
    contract_id     TEXT PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 1,
    definition      JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Decoded events live in one shared table keyed by JSONB payload, rather than a
-- generated table per contract/event.
--
-- The alternative — CREATE TABLE custom_<contract>_<event> with real columns —
-- buys native column types and loses more than it gains: DDL on the indexing
-- hot path, table sprawl that grows with registrations, an ALTER TABLE
-- migration story every time a project revises a schema, and identifiers
-- derived from third-party input reaching SQL as identifiers rather than as
-- bind parameters.
--
-- Here a schema revision is a metadata update, one project's schema cannot
-- collide with another's table, and field names never leave the JSONB layer.
-- The cost is that ordered comparison needs a cast, which the query layer does
-- using the type the schema declares.
CREATE TABLE IF NOT EXISTS custom_events (
    event_id        TEXT NOT NULL,
    contract_id     TEXT NOT NULL,
    event_name      TEXT NOT NULL,
    ledger          BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    schema_version  INTEGER NOT NULL,
    fields          JSONB NOT NULL DEFAULT '{}',
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, event_name)
);

CREATE INDEX IF NOT EXISTS idx_custom_events_contract_event
    ON custom_events (contract_id, event_name, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_custom_events_ledger
    ON custom_events (ledger DESC);
-- Containment queries on exact-match filters go through the payload directly.
CREATE INDEX IF NOT EXISTS idx_custom_events_fields
    ON custom_events USING GIN (fields);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('003_custom_event_schemas', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 003 complete.'

-- Migration 004: Search and asset-filter indexes
-- Run with: psql $DATABASE_URL -f db/migrations/004_search_indexes.sql
--
-- ## Why trigram rather than tsvector for memos
--
-- `to_tsvector` is built for prose: it stems words, folds them to lexemes and
-- discards very short tokens. Stellar memos are mostly not prose — they are
-- order references, exchange deposit tags, invoice numbers, short codes. A memo
-- of "ORDER-4471" stems to nothing useful, and stemming an identifier is
-- actively wrong.
--
-- Trigram similarity treats a memo as a string rather than a sentence, which
-- makes substring matches, typos and case differences all behave the same way,
-- and one GIN trigram index serves both `similarity()` ranking and `ILIKE`.
--
-- ## Note on migration time
--
-- These are the two statements that will take real time on a populated
-- deployment; GIN builds are the slow part. `CONCURRENTLY` is used so the build
-- does not hold a write lock and stall the indexer — it cannot run inside a
-- transaction block, which is why this file has no BEGIN/COMMIT.

\echo 'Running migration 004: search indexes (this can take a while on a large database)...'

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Memo search. Partial, because most transactions carry no memo at all and
-- indexing millions of NULLs buys nothing.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_memo_trgm
    ON transactions USING GIN (memo gin_trgm_ops)
    WHERE memo IS NOT NULL;

-- Asset filtering. Expression indexes rather than generated columns: the same
-- effect for these queries without rewriting every row in `operations`, which
-- on a populated deployment is the difference between minutes and hours.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operations_asset_code
    ON operations ((details->>'asset_code'))
    WHERE details->>'asset_code' IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operations_asset_issuer
    ON operations ((details->>'asset_issuer'))
    WHERE details->>'asset_issuer' IS NOT NULL;

-- Native (XLM) payments carry no code or issuer, only asset_type, so they need
-- their own path or they are unfindable by asset.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operations_asset_type
    ON operations ((details->>'asset_type'))
    WHERE details->>'asset_type' IS NOT NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('004_search_indexes', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 004 complete.'

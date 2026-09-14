/**
 * The indexer's half of the real-time path.
 *
 * The indexer and the GraphQL server are separate processes, so an in-memory
 * `PubSub` cannot join them. Postgres `LISTEN`/`NOTIFY` can, and it costs no
 * new infrastructure: both processes already hold a connection to the same
 * database.
 *
 * ## Why the payload carries counts, not content
 *
 * The obvious design is to put the new transactions in the notification. It
 * does not survive contact with a real ledger: Postgres caps a NOTIFY payload
 * at 8000 bytes, and a busy Stellar ledger holds hundreds of transactions whose
 * 64-character hashes alone blow past that. A truncated notification is worse
 * than a small one, because the subscriber cannot tell that it was truncated.
 *
 * So the notification says only *what changed and where* — the ledger sequence,
 * plus counts for observability — and the GraphQL server reads the rows back
 * out of the database it is already connected to. One extra query per ledger
 * (~5s apart) buys a payload that cannot overflow.
 */
import type { PoolClient, Pool } from 'pg';

/** The single channel both processes agree on. */
export const INDEXED_CHANNEL = 'lumina_indexed';

/**
 * Postgres' hard limit is 8000 bytes; staying well under it means a future
 * field cannot quietly push a payload over the edge.
 */
const MAX_PAYLOAD_BYTES = 4000;

export type IndexedKind = 'ledger' | 'events';

export interface IndexedNotification {
  kind: IndexedKind;
  /** Ledger sequence the new rows belong to. */
  ledger: number;
  /** Counts, for logging and for a subscriber deciding whether to bother reading. */
  transactions?: number;
  operations?: number;
  events?: number;
}

/** Minimal queryable surface — a `Pool` or a `PoolClient` inside a transaction. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Emit a notification.
 *
 * Uses `pg_notify(...)` rather than the `NOTIFY` statement because `NOTIFY`
 * takes a literal, not a bind parameter — building the payload by string
 * concatenation would be an injection waiting to happen.
 *
 * Call this **inside** the writing transaction. Postgres queues notifications
 * and delivers them at commit, so a rolled-back ledger emits nothing and there
 * is no window where a subscriber is told about rows that never landed.
 */
export async function notifyIndexed(
  db: Queryable | PoolClient | Pool,
  notification: IndexedNotification
): Promise<void> {
  const payload = serializeNotification(notification);
  await (db as Queryable).query('SELECT pg_notify($1, $2)', [INDEXED_CHANNEL, payload]);
}

/**
 * Serialize, degrading to the bare essentials rather than emitting something
 * Postgres will reject. The ledger sequence is the only field a subscriber
 * actually needs; everything else is commentary.
 */
export function serializeNotification(notification: IndexedNotification): string {
  const full = JSON.stringify(notification);
  if (Buffer.byteLength(full, 'utf8') <= MAX_PAYLOAD_BYTES) return full;
  return JSON.stringify({ kind: notification.kind, ledger: notification.ledger });
}

/**
 * Parse a payload from the wire.
 *
 * Returns `null` rather than throwing for anything unrecognised: a malformed
 * notification must not take down the server's LISTEN connection, and the
 * indexer may be a newer version emitting a shape this server has not learned
 * about yet.
 */
export function parseNotification(payload: string | undefined): IndexedNotification | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<IndexedNotification>;
    if (typeof parsed.ledger !== 'number' || !Number.isFinite(parsed.ledger)) return null;
    if (parsed.kind !== 'ledger' && parsed.kind !== 'events') return null;
    return {
      kind: parsed.kind,
      ledger: parsed.ledger,
      transactions: numberOrUndefined(parsed.transactions),
      operations: numberOrUndefined(parsed.operations),
      events: numberOrUndefined(parsed.events),
    };
  } catch {
    return null;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

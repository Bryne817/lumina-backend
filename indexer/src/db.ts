import { Pool, PoolClient } from 'pg';
import type { HorizonAccount, HorizonLedger, HorizonOperation, HorizonTransaction } from './horizon';
import type { ContractEvent } from './soroban';
import { notifyIndexed } from './notify';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function getLatestIndexedLedger(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>('SELECT MAX(sequence) AS max FROM ledgers');
  return rows[0].max ? Number(rows[0].max) : 0;
}

/**
 * Writes a ledger and all of its transactions/operations in a single DB
 * transaction, so a crash mid-ledger leaves no partial rows behind — the
 * ledger sequence simply gets re-fetched and re-indexed on restart.
 */
export async function indexLedger(
  pool: Pool,
  ledger: HorizonLedger,
  transactions: HorizonTransaction[],
  operations: HorizonOperation[],
  accounts: HorizonAccount[] = []
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, base_fee, base_reserve)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sequence) DO NOTHING`,
      [
        ledger.sequence,
        ledger.closed_at,
        ledger.successful_transaction_count + ledger.failed_transaction_count,
        ledger.operation_count,
        ledger.base_fee_in_stroops,
        ledger.base_reserve_in_stroops,
      ]
    );

    for (const tx of transactions) {
      await client.query(
        `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (hash) DO NOTHING`,
        [
          tx.hash,
          tx.ledger,
          tx.created_at,
          tx.source_account,
          tx.fee_charged,
          tx.operation_count,
          tx.successful,
          tx.memo_type,
          tx.memo ?? null,
        ]
      );
    }

    for (const op of operations) {
      await client.query(
        `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [op.id, op.type, op.transaction_hash, ledger.sequence, op.created_at, op.source_account, JSON.stringify(op)]
      );
    }

    for (const account of accounts) {
      await upsertAccount(client, account);
    }

    // Queued inside the transaction on purpose: Postgres delivers notifications
    // at commit, so a rolled-back ledger announces nothing and no subscriber is
    // ever told about rows that did not land.
    await notifyIndexed(client, {
      kind: 'ledger',
      ledger: ledger.sequence,
      transactions: transactions.length,
      operations: operations.length,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertAccount(client: PoolClient, account: HorizonAccount): Promise<void> {
  await client.query(
    `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (address) DO UPDATE SET
       sequence = EXCLUDED.sequence,
       subentry_count = EXCLUDED.subentry_count,
       last_modified_ledger = EXCLUDED.last_modified_ledger,
       num_sponsored = EXCLUDED.num_sponsored,
       num_sponsoring = EXCLUDED.num_sponsoring,
       balances = EXCLUDED.balances,
       flags = EXCLUDED.flags,
       thresholds = EXCLUDED.thresholds,
       updated_at = NOW()`,
    [
      account.account_id,
      account.sequence,
      account.subentry_count,
      account.last_modified_ledger,
      account.num_sponsored,
      account.num_sponsoring,
      JSON.stringify(account.balances),
      JSON.stringify(account.flags),
      JSON.stringify(account.thresholds),
    ]
  );
}

export async function insertContractEvents(pool: Pool, events: ContractEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Events arrive from Soroban RPC on their own cadence, keyed by the ledger
  // they were emitted in — so the notification names the highest ledger in the
  // batch, which is what a subscriber would read up to.
  let highestLedger = 0;

  for (const event of events) {
    await pool.query(
      `INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.type,
        event.contractId,
        event.ledger,
        event.createdAt,
        event.pagingToken,
        event.topics,
        event.value === undefined ? null : JSON.stringify(event.value),
      ]
    );
    if (event.ledger > highestLedger) highestLedger = event.ledger;
  }

  await notifyIndexed(pool, {
    kind: 'events',
    ledger: highestLedger,
    events: events.length,
  });
}

export async function getLatestIndexedEventLedger(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>('SELECT MAX(ledger) AS max FROM contract_events');
  return rows[0].max ? Number(rows[0].max) : 0;
}

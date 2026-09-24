import DataLoader from 'dataloader';
import type { Pool } from 'pg';
import {
  getAccountsFromDb,
  getLedgersBySequences,
  getOperationsByTransactionHashes,
  getTransactionsByHashes,
  mapAccount,
} from './db';
import { getAccount as getAccountFromHorizon } from './horizon';

export interface RequestLoaders {
  account: DataLoader<string, ReturnType<typeof mapAccount> | null>;
  ledger: DataLoader<number, Awaited<ReturnType<typeof getLedgersBySequences>> extends Map<number, infer T> ? T | null : never>;
  transaction: DataLoader<string, Awaited<ReturnType<typeof getTransactionsByHashes>> extends Map<string, infer T> ? T | null : never>;
  operationsByTransactionHash: DataLoader<string, Awaited<ReturnType<typeof getOperationsByTransactionHashes>> extends Map<string, infer T> ? T : never>;
}

export function createLoaders(pool: Pool): RequestLoaders {
  return {
    account: new DataLoader(async addresses => {
      const rows = await getAccountsFromDb(pool, addresses);
      return Promise.all(addresses.map(async address => {
        const fromDb = rows.get(address);
        if (fromDb) return fromDb;

        const horizonAccount = await getAccountFromHorizon(address);
        if (!horizonAccount) return null;
        return mapAccount({
          address: horizonAccount.account_id,
          sequence: horizonAccount.sequence,
          subentry_count: horizonAccount.subentry_count,
          last_modified_ledger: horizonAccount.last_modified_ledger,
          num_sponsored: horizonAccount.num_sponsored,
          num_sponsoring: horizonAccount.num_sponsoring,
          balances: horizonAccount.balances,
          flags: horizonAccount.flags,
          thresholds: horizonAccount.thresholds,
        });
      }));
    }),
    ledger: new DataLoader(async sequences => {
      const rows = await getLedgersBySequences(pool, sequences);
      return sequences.map(sequence => rows.get(sequence) ?? null);
    }),
    transaction: new DataLoader(async hashes => {
      const rows = await getTransactionsByHashes(pool, hashes);
      return hashes.map(hash => rows.get(hash) ?? null);
    }),
    operationsByTransactionHash: new DataLoader(async hashes => {
      const rows = await getOperationsByTransactionHashes(pool, hashes);
      return hashes.map(hash => rows.get(hash) ?? []);
    }),
  };
}

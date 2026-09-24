import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndIndexLedgerWithRetry, runLedgerCatchUp } from './index';

test('ledger catch-up advances the cursor after each indexed ledger', async () => {
  const indexed: number[] = [];
  const advanced: number[] = [];

  const cursor = await runLedgerCatchUp(99, 102, async sequence => {
    indexed.push(sequence);
    return true;
  }, sequence => advanced.push(sequence));

  assert.equal(cursor, 102);
  assert.deepEqual(indexed, [100, 101, 102]);
  assert.deepEqual(advanced, [100, 101, 102]);
});

test('ledger catch-up stops at the first failed ledger without skipping the gap', async () => {
  const indexed: number[] = [];

  const cursor = await runLedgerCatchUp(99, 102, async sequence => {
    indexed.push(sequence);
    return sequence !== 101;
  });

  assert.equal(cursor, 100);
  assert.deepEqual(indexed, [100, 101]);
});

test('retry exhaustion reports failure so the cursor is not advanced', async () => {
  let attempts = 0;

  const indexed = await fetchAndIndexLedgerWithRetry(200, async () => {
    attempts++;
    throw new Error('scripted Horizon 429');
  }, 3, 0);

  assert.equal(indexed, false);
  assert.equal(attempts, 3);
});

test('a transient Horizon failure retries and then indexes the ledger', async () => {
  let attempts = 0;

  const indexed = await fetchAndIndexLedgerWithRetry(201, async () => {
    attempts++;
    if (attempts === 1) throw new Error('scripted Horizon 503');
  }, 3, 0);

  assert.equal(indexed, true);
  assert.equal(attempts, 2);
});

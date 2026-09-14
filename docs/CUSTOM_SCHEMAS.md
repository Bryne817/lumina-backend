# Custom event schemas

By default every Soroban event Lumina indexes lands in `contract_events` with a
raw JSON `value`. That is fine for browsing and useless for a question like
*"every `transfer` over 1000, by sender"*.

A **custom schema** tells the indexer how to decode your contract's events into
named, typed fields. Register one, and matching events become queryable through
`customEvents` with real types and real filters.

Your contract must already be indexed — either listed in `INDEXED_CONTRACT_IDS`
or discoverable through the Lumina Registry. A schema changes how events are
decoded; it does not decide which contracts are watched.

## A worked example

Take a token contract emitting:

```rust
env.events().publish(
    (Symbol::new(&env, "transfer"), from, to),
    TransferData { amount },   // amount: i128
);
```

Describe it in `transfer-schema.json`:

```json
{
  "contractId": "CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ",
  "version": 1,
  "events": [
    {
      "name": "transfer",
      "topic": "transfer",
      "fields": [
        { "name": "from",   "type": "address", "source": "topic[1]" },
        { "name": "to",     "type": "address", "source": "topic[2]" },
        { "name": "amount", "type": "i128",    "source": "value.amount" },
        { "name": "memo",   "type": "string",  "source": "value.memo", "optional": true }
      ]
    }
  ]
}
```

Register it:

```bash
DATABASE_URL=postgresql://lumina:lumina@localhost:5432/lumina \
  npm run register-schema -w @lumina/indexer -- apply transfer-schema.json
```

```
Registered schema v1 for CAYUDQPV3RKPM3EXD…
  transfer (topic "transfer") — from: address, to: address, amount: i128, memo: string

The indexer picks this up on its next poll; no restart needed.
```

Then query it:

```graphql
query BigTransfers {
  customEvents(
    contractId: "CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ"
    event: "transfer"
    where: [{ field: "amount", op: GT, value: "1000" }]
    limit: 20
  ) {
    items {
      ledger
      createdAt
      fields { name type value }
    }
    pageInfo { hasNextPage cursor }
  }
}
```

## Schema reference

| Key | Meaning |
| --- | --- |
| `contractId` | The `C…` address. Must be a real Soroban contract address. |
| `version` | Integer ≥ 1. Bump it when you change field mappings. |
| `events[].name` | What you query by. Letters, digits, underscores. |
| `events[].topic` | The first topic the contract emits for this event. |
| `events[].fields[].name` | Field name. Must not shadow a stored column (`ledger`, `event_id`, `contract_id`, `event_name`, `created_at`, `schema_version`, `fields`). |
| `events[].fields[].type` | One of `address`, `string`, `symbol`, `bool`, `bytes`, `i32`, `u32`, `i64`, `u64`, `i128`, `u128`, `json`. |
| `events[].fields[].source` | `topic[N]`, `value`, or `value.path.to.field`. |
| `events[].fields[].optional` | When true, an event missing the field still indexes, with the field null. Defaults to false. |

Limits: 50 events per schema, 40 fields per event, 63 characters per name.

## Why values come back as strings

`CustomEventField.value` is a `String` regardless of the declared `type`, and
`type` tells you how to parse it.

This is not laziness. The type this feature exists for is `i128` — token
amounts — and it does not fit in a JSON number. A GraphQL `Float` would
silently round anything above 2^53, and an indexer that rounds balances is
worse than one that does not decode them at all. So integers are kept as exact
decimal text end to end, and Postgres compares them as `numeric`, which is
exact at any width.

Filtering is where typing actually earns its keep, and that happens server-side
using your declared types: `GT`/`GTE`/`LT`/`LTE` are accepted only on numeric
fields, because `>` on an address would silently do a lexicographic comparison
and never mean what you wanted.

## Revising a schema

Re-run `apply` with a higher `version`. New events decode against the new
mapping immediately. Already-decoded rows keep the version they were written
with, and are corrected only if those events are re-indexed — `custom_events`
records `schemaVersion` per row so you can tell which mapping produced what.

Removing a schema with `remove` stops future decoding and leaves existing rows
in place.

```bash
npm run register-schema -w @lumina/indexer -- list
npm run register-schema -w @lumina/indexer -- show <contractId>
npm run register-schema -w @lumina/indexer -- remove <contractId>
```

## What happens when a schema is wrong

- **Malformed at registration** — rejected by the CLI with a message naming the
  offending path (`events[0].fields[2].source "result.amount" must be …`).
  Nothing is stored.
- **Valid but no longer matching the contract** — an event that matches the
  topic but lacks a required field is *not* indexed, and the indexer logs why.
  It is deliberately not stored with nulls, because a schema silently drifting
  out of sync with its contract is the failure you would never notice.
- **Events your schema does not mention** — skipped silently. A contract emits
  plenty you do not care about; that is not an error.
- **Anything at all** — generic `contract_events` indexing is unaffected.
  Custom decoding runs after it, in its own error boundary, so a broken schema
  cannot cost anyone else their indexing.

## Isolation

Schemas come from third parties, so:

- Field names never reach SQL as identifiers. They are JSONB keys, bound as
  parameters. Decoded events live in one shared `custom_events` table with a
  JSONB payload rather than a generated table per contract, so there is no DDL
  on the indexing path and no way for one project's schema to collide with
  another's storage.
- Names are restricted to an identifier charset and checked against a reserved
  list, and the size caps above bound what a single schema can cost.
- Filter operators come from a fixed table; a value outside it is rejected
  before any SQL is built.

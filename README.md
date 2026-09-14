# Lumina Backend

> Stellar event indexer + Apollo GraphQL API + PostgreSQL schema for Lumina, an open-source event indexer and GraphQL data layer for the Stellar network.

Part of the Lumina project, split across three repos:

- [lumina-frontend](https://github.com/Lumeeena/lumina-frontend) — Next.js explorer UI
- [lumina-backend](https://github.com/Lumeeena/lumina-backend) — this repo
- [lumina-contracts](https://github.com/Lumeeena/lumina-contracts) — Soroban Registry contract

## Structure

```
indexer/         Polls Stellar Horizon, writes ledgers/transactions/operations/accounts
                  to Postgres, and (opt-in) indexes Soroban contract events via RPC
graphql-server/   Apollo GraphQL API — reads from Postgres, falls back to Horizon
                  only for accounts that haven't been indexed yet
db/               PostgreSQL schema + migrations
docker/           Dockerfiles + docker-compose.yml for postgres + indexer + graphql
```

## How It Works

```
Stellar Horizon ──▶ indexer/ ──▶ PostgreSQL ──▶ graphql-server/ ──▶ lumina-frontend
                                                       ▲
                        Soroban RPC (contract events) ─┘  (opt-in, see below)
                                       ▲
              Lumina Registry (lumina-contracts) ─┘  (opt-in discovery, see below)
```

### Real-time path

Queries read from Postgres. Subscriptions add a push path alongside it, over
Postgres `LISTEN`/`NOTIFY` — the indexer and the GraphQL server are separate
processes, so an in-memory `PubSub` cannot join them, and both already hold a
connection to the same database.

```
indexer/                          graphql-server/                   client
   │                                    │                              │
   │ BEGIN                              │ LISTEN lumina_indexed        │
   │  INSERT ledger/txs/ops             │ (one supervised connection)  │
   │  pg_notify('lumina_indexed', …)    │                              │
   │ COMMIT ─────────────────────▶ notification ──▶ read that ledger   │
   │                                    │           from Postgres      │
   │                                    │              └──▶ push ─────▶│  ws://…/graphql
```

Two things are deliberate here:

- **The notification is queued inside the writing transaction.** Postgres
  delivers notifications at commit, so a rolled-back ledger announces nothing
  and no subscriber is ever told about rows that did not land.
- **The payload carries counts, not content.** Postgres caps a NOTIFY payload
  at 8000 bytes and a busy ledger's transaction hashes alone exceed that, so the
  notification names the ledger and the server reads the rows back out of the
  database. One extra query per ledger (~5s apart) buys a payload that cannot
  overflow or silently truncate.

Subscriptions are served over `graphql-ws` at `ws://localhost:4000/graphql` —
the same path and port as queries:

```graphql
subscription { newTransaction { hash ledger sourceAccount successful } }
subscription { accountActivity(address: "G…") { id type amount asset } }
```

`accountActivity` matches operations that *touch* the address — `source_account`
plus the counterparty fields in `details` — not merely those it submitted, so
being paid counts.

A [Lumina Registry](https://github.com/Lumeeena/lumina-contracts) is deployed
on testnet at `CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ` with
one demo entry (itself), used to verify the discovery wiring below end-to-end
against a live contract.

### Custom event schemas

A project can register a schema describing how its contract's events decode into
named, typed fields — "subgraph-style" indexing on top of the generic
`contract_events` table — and query them through `customEvents` with typed
filters:

```graphql
customEvents(
  contractId: "C…"
  event: "transfer"
  where: [{ field: "amount", op: GT, value: "1000" }]
) { items { fields { name type value } } }
```

Registration is a CLI operation against the database, so a schema can be
iterated on without a transaction, and the Registry keeps deciding *which*
contracts are indexed rather than *how* they decode:

```bash
npm run register-schema -w @lumina/indexer -- apply transfer-schema.json
```

See [docs/CUSTOM_SCHEMAS.md](docs/CUSTOM_SCHEMAS.md) for the format, a worked
example, and what happens when a schema stops matching its contract.

## Run with Docker

```bash
docker compose -f docker/docker-compose.yml up
```

- GraphQL: http://localhost:4000/graphql
- PostgreSQL: localhost:5432

## Run locally

```bash
# once
psql $DATABASE_URL -f db/schema.sql

# indexer
cd indexer && npm install && npm run dev

# graphql server
cd graphql-server && npm install && npm run dev
```

### Indexer environment variables

| Variable | Default | Notes |
|---|---|---|
| `HORIZON_URL` | `https://horizon.stellar.org` | |
| `DATABASE_URL` | `postgresql://localhost:5432/lumina` | |
| `START_LEDGER` | latest | Only used when the DB is empty |
| `POLL_INTERVAL_MS` | `5000` | |
| `HORIZON_MIN_REQUEST_INTERVAL_MS` | `100` | Minimum spacing between outbound Horizon requests, to avoid bursts tripping the per-IP rate limit |
| `SOROBAN_RPC_URL` | unset | Enables Soroban contract event indexing |
| `INDEXED_CONTRACT_IDS` | unset | Comma-separated contract IDs to index events for; requires `SOROBAN_RPC_URL` |
| `REGISTRY_CONTRACT_ID` | unset | Lumina Registry contract to poll for additional contract IDs; requires `SOROBAN_RPC_URL` + `REGISTRY_READ_ACCOUNT` |
| `REGISTRY_READ_ACCOUNT` | unset | Any funded G... account used to simulate the registry's read calls — no secret key needed, simulation doesn't sign or submit |
| `REGISTRY_NETWORK_PASSPHRASE` | Test SDF Network passphrase | Network the registry is deployed on |

Soroban event indexing and registry discovery are both entirely opt-in at
the code level — the indexer behaves exactly as it did before these
variables were introduced when they're unset. `docker/docker-compose.yml`
sets them by default, though, pointed at the deployed testnet registry, so
`docker compose up` shows real contract events out of the box; unset them
there to disable it. When `REGISTRY_CONTRACT_ID` is set, discovered contract
IDs are merged with `INDEXED_CONTRACT_IDS` (the registry is polled roughly
once a minute, independent of the 5s ledger poll loop).

Example against the deployed testnet registry:

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
REGISTRY_CONTRACT_ID=CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ \
REGISTRY_READ_ACCOUNT=<any funded testnet G... address> \
npm run dev
```

### GraphQL server environment variables

| Variable | Default |
|---|---|
| `DATABASE_URL` | `postgresql://localhost:5432/lumina` |
| `PORT` | `4000` |
| `MAX_SUBSCRIPTIONS` | `500` — concurrent subscriptions before new ones are refused |
| `SUBSCRIPTION_QUEUE_LIMIT` | `64` — notifications buffered per subscriber before the oldest are dropped |

`MAX_SUBSCRIPTIONS` is a ceiling, not a lifetime budget: closing a subscription
frees its slot. Past it, a new subscription is refused with a clear error rather
than degrading every existing one.

`SUBSCRIPTION_QUEUE_LIMIT` bounds what one stalled client — a paused browser
tab, a wedged socket — can accumulate in the server's heap. Past it the *oldest*
notifications are dropped, because on a live feed a client catching up wants the
head of the stream, not a replay of a backlog it no longer cares about.

## Testing

```bash
npm test   # runs indexer + graphql-server test suites
```

The subscription integration tests need a real Postgres and are skipped without
one, since they exist to check the things a faked `pg` client cannot: that
Postgres actually delivers a NOTIFY, that a rolled-back one is never delivered,
and that killing the listener's backend surfaces as the events the reconnect
supervisor waits for.

```bash
TEST_DATABASE_URL=postgresql://lumina:lumina@localhost:5432/lumina \
  npm run test:integration -w @lumina/graphql-server
```

CI runs them against its own Postgres service.

## License

MIT

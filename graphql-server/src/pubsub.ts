/**
 * The GraphQL server's half of the real-time path: one long-lived Postgres
 * `LISTEN` connection, fanned out to every open subscription.
 *
 * Three things this has to get right, none of which a naive `LISTEN` does:
 *
 * 1. **Survive the database going away.** The indexer restarting, a failover,
 *    an idle-connection reaper — any of these kill the listener silently, and a
 *    subscription server that stops receiving without noticing looks identical
 *    to a quiet network. So the connection is supervised and reconnected with
 *    backoff, and `LISTEN` is re-issued each time.
 * 2. **Never grow without bound.** A subscriber that stops reading — a stalled
 *    client, a paused browser tab — must not accumulate an unbounded queue in
 *    the server's heap. Each subscriber gets a small ring buffer and drops its
 *    oldest entries, because for a live feed the newest ledger is the one worth
 *    keeping.
 * 3. **Have a ceiling.** Connections are capped so a subscription flood cannot
 *    starve ordinary queries of memory or file descriptors.
 */
import { Client } from 'pg';
import { INDEXED_CHANNEL, parseNotification, type IndexedNotification } from './notifications';

export interface NotifierOptions {
  connectionString: string;
  /** Injected so tests can drive a fake connection without a database. */
  createClient?: (connectionString: string) => ListenClient;
  /** Maximum simultaneous subscriptions. Beyond this, `subscribe` throws. */
  maxSubscribers?: number;
  /** Per-subscriber buffer depth before the oldest notification is dropped. */
  queueLimit?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  log?: (message: string, detail?: unknown) => void;
  /** Injected for tests; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => void;
}

/** The slice of `pg.Client` this needs — small enough to fake honestly. */
export interface ListenClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', handler: (msg: { channel: string; payload?: string }) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'end', handler: () => void): void;
}

export class SubscriberLimitError extends Error {
  constructor(limit: number) {
    super(`Subscription rejected: server is at its limit of ${limit} concurrent subscriptions.`);
    this.name = 'SubscriberLimitError';
  }
}

interface Subscriber {
  queue: IndexedNotification[];
  /** Set when the consumer is parked waiting for the next notification. */
  resolve: ((result: IteratorResult<IndexedNotification>) => void) | null;
  closed: boolean;
  dropped: number;
}

export class LedgerNotifier {
  private client: ListenClient | null = null;
  private subscribers = new Set<Subscriber>();
  private stopped = false;
  private connecting = false;
  private attempt = 0;

  private readonly createClient: (connectionString: string) => ListenClient;
  private readonly maxSubscribers: number;
  private readonly queueLimit: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly options: NotifierOptions) {
    this.createClient =
      options.createClient ?? (connectionString => new Client({ connectionString }) as unknown as ListenClient);
    this.maxSubscribers = options.maxSubscribers ?? 500;
    this.queueLimit = options.queueLimit ?? 64;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.log = options.log ?? (() => {});
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** True once a LISTEN connection is established. */
  get connected(): boolean {
    return this.client !== null;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;

    try {
      const client = this.createClient(this.options.connectionString);

      // Both handlers funnel into the same recovery path: from this class's
      // point of view a socket error and a clean server-side close are the
      // same event — the listener is gone and has to be rebuilt.
      client.on('error', (err: Error) => {
        this.log('LISTEN connection errored', err.message);
        this.handleDisconnect(client);
      });
      client.on('end', () => {
        this.log('LISTEN connection ended');
        this.handleDisconnect(client);
      });
      client.on('notification', msg => {
        if (msg.channel !== INDEXED_CHANNEL) return;
        const notification = parseNotification(msg.payload);
        // An unparseable payload is dropped, not thrown: a malformed
        // notification must not take the listener down with it.
        if (notification) this.publish(notification);
      });

      await client.connect();
      await client.query(`LISTEN ${INDEXED_CHANNEL}`);

      this.client = client;
      this.attempt = 0;
      this.log('listening for indexed ledgers');
    } catch (err) {
      this.log('LISTEN connection failed', err instanceof Error ? err.message : err);
      this.client = null;
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private handleDisconnect(client: ListenClient): void {
    // Ignore an event from a connection already replaced — otherwise a late
    // 'end' from the old client cancels the new one.
    if (this.client !== null && this.client !== client) return;
    this.client = null;
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.reconnectDelayMs * 2 ** this.attempt, this.maxReconnectDelayMs);
    this.attempt++;
    this.log(`reconnecting to LISTEN in ${delay}ms`);
    this.schedule(() => {
      void this.connect();
    }, delay);
  }

  /** Fan a notification out to every open subscriber. */
  publish(notification: IndexedNotification): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.resolve) {
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve({ value: notification, done: false });
        continue;
      }

      subscriber.queue.push(notification);
      if (subscriber.queue.length > this.queueLimit) {
        // Drop the oldest: on a live feed, a stalled client is better served
        // catching up at the head than replaying a backlog it no longer cares
        // about.
        subscriber.queue.shift();
        subscriber.dropped++;
      }
    }
  }

  /**
   * One subscription's stream of notifications.
   *
   * Throws {@link SubscriberLimitError} when the server is already at its
   * ceiling — rejecting a new subscription is better than degrading every
   * existing one.
   */
  subscribe(): AsyncIterableIterator<IndexedNotification> & { droppedCount: () => number } {
    if (this.subscribers.size >= this.maxSubscribers) {
      throw new SubscriberLimitError(this.maxSubscribers);
    }

    const subscriber: Subscriber = { queue: [], resolve: null, closed: false, dropped: 0 };
    this.subscribers.add(subscriber);

    const close = (): Promise<IteratorResult<IndexedNotification>> => {
      if (!subscriber.closed) {
        subscriber.closed = true;
        this.subscribers.delete(subscriber);
        // Wake a parked consumer so `for await` unwinds instead of hanging.
        if (subscriber.resolve) {
          const resolve = subscriber.resolve;
          subscriber.resolve = null;
          resolve({ value: undefined, done: true });
        }
      }
      return Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
    };

    const iterator: AsyncIterableIterator<IndexedNotification> & { droppedCount: () => number } = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: () => {
        if (subscriber.closed) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
        }
        const buffered = subscriber.queue.shift();
        if (buffered) {
          return Promise.resolve({ value: buffered, done: false });
        }
        return new Promise<IteratorResult<IndexedNotification>>(resolve => {
          subscriber.resolve = resolve;
        });
      },
      return: close,
      throw: close,
      droppedCount: () => subscriber.dropped,
    };

    return iterator;
  }

  /** Close every subscription and the LISTEN connection. */
  async stop(): Promise<void> {
    this.stopped = true;

    for (const subscriber of [...this.subscribers]) {
      subscriber.closed = true;
      if (subscriber.resolve) {
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve({ value: undefined, done: true });
      }
    }
    this.subscribers.clear();

    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // Already gone; nothing useful left to do about it.
      }
    }
  }
}

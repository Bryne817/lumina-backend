/**
 * Structured logging.
 *
 * `pino` has been an indexer dependency since the beginning and was never
 * imported — everything went through `console.log` with values interpolated
 * into strings. That is the difference between grepping for a ledger number and
 * querying for one, and it is part of why a Horizon rate-limiting incident took
 * a live debugging session rather than showing up in a filter.
 *
 * So values are passed as *fields*, never interpolated:
 *
 *     log.warn({ ledger, status: 429 }, 'horizon request throttled')
 *
 * not `console.warn(\`throttled on ledger \${ledger}\`)`.
 */
import pino from 'pino';

/**
 * `LOG_LEVEL` controls verbosity; `LOG_PRETTY=true` switches to human-readable
 * output for local runs. JSON is the default because that is what a log
 * aggregator ingests, and a developer can always opt out.
 */
const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === 'true';

export const logger = pino({
  level,
  base: { service: 'lumina-indexer' },
  // Seconds-since-epoch as a number is what Prometheus and most aggregators
  // expect; pino's default is milliseconds.
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

/** A child logger tagged with the subsystem it belongs to. */
export function subsystem(name: string) {
  return logger.child({ subsystem: name });
}

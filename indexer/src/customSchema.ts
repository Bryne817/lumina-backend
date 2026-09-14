/**
 * Per-contract event schemas — the "subgraph-style" layer over the generic
 * `contract_events` table.
 *
 * A project declares, once, that its `transfer` event has a `from` Address in
 * topic 1, a `to` Address in topic 2 and an `amount` i128 in the value. The
 * indexer then decodes matching events into named, typed fields instead of the
 * opaque JSON blob a generic indexer can offer.
 *
 * ## Validation is the security boundary
 *
 * A schema is untrusted input from a third party, and it reaches the database.
 * The rule this module enforces is that **nothing from a schema is ever
 * interpolated into SQL as an identifier**: field names live as JSONB keys and
 * travel as bind parameters. That is what makes one project's bad schema
 * incapable of touching anyone else's data — combined with the caps below,
 * which stop a schema being large enough to be a denial-of-service on its own.
 */

/** Field types a schema may declare. */
export const FIELD_TYPES = [
  'address',
  'string',
  'symbol',
  'bool',
  'bytes',
  'i32',
  'u32',
  'i64',
  'u64',
  'i128',
  'u128',
  'json',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Types that support ordered comparison in a query filter. */
export const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'i32',
  'u32',
  'i64',
  'u64',
  'i128',
  'u128',
]);

export interface FieldDefinition {
  name: string;
  type: FieldType;
  /** Where to read it from: `topic[N]`, `value`, or `value.a.b`. */
  source: string;
  /** When true, an event missing this field still indexes, with the field null. */
  optional?: boolean;
}

export interface EventDefinition {
  /** Name this event is queried by. */
  name: string;
  /** The first topic identifying the event, as emitted by the contract. */
  topic: string;
  fields: FieldDefinition[];
}

export interface ContractSchema {
  contractId: string;
  version: number;
  events: EventDefinition[];
}

// Caps. A schema is third-party input; these stop one from being a
// denial-of-service by size alone.
export const MAX_EVENTS_PER_SCHEMA = 50;
export const MAX_FIELDS_PER_EVENT = 40;
export const MAX_NAME_LENGTH = 63;
export const MAX_TOPIC_LENGTH = 128;

/**
 * Names are restricted to an identifier-ish charset, and the reserved list
 * below covers the columns `custom_events` stores alongside the JSONB payload.
 *
 * Neither restriction is load-bearing for SQL safety — field names are never
 * concatenated into SQL — but a field called `ledger` would shadow a real
 * column in every human reading of a query, and that is a bug waiting to be
 * written.
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/i;

const RESERVED_FIELD_NAMES = new Set([
  'event_id',
  'eventid',
  'contract_id',
  'contractid',
  'event_name',
  'eventname',
  'ledger',
  'created_at',
  'createdat',
  'schema_version',
  'schemaversion',
  'fields',
]);

const SOURCE_PATTERN = /^(topic\[\d+\]|value(\.[A-Za-z_][A-Za-z0-9_]*)*)$/;

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

/**
 * Validate and normalise an untrusted schema document.
 *
 * Throws {@link SchemaValidationError} with a message naming the offending
 * field, so a project submitting a bad schema is told what to fix rather than
 * getting a stack trace or, worse, a silent partial registration.
 */
export function parseContractSchema(input: unknown): ContractSchema {
  const doc = requireObject(input, 'schema');

  const contractId = requireString(doc.contractId, 'contractId');
  if (!/^C[A-Z0-9]{55}$/.test(contractId)) {
    throw new SchemaValidationError(
      `contractId must be a Soroban contract address (C… , 56 characters), got "${contractId}"`
    );
  }

  const version = doc.version === undefined ? 1 : requireInteger(doc.version, 'version');
  if (version < 1) {
    throw new SchemaValidationError('version must be 1 or greater');
  }

  const rawEvents = doc.events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new SchemaValidationError('schema must declare at least one event');
  }
  if (rawEvents.length > MAX_EVENTS_PER_SCHEMA) {
    throw new SchemaValidationError(
      `schema declares ${rawEvents.length} events, more than the limit of ${MAX_EVENTS_PER_SCHEMA}`
    );
  }

  const events: EventDefinition[] = [];
  const seenEventNames = new Set<string>();

  for (const [index, rawEvent] of rawEvents.entries()) {
    const event = parseEvent(rawEvent, `events[${index}]`);
    if (seenEventNames.has(event.name)) {
      throw new SchemaValidationError(`duplicate event name "${event.name}"`);
    }
    seenEventNames.add(event.name);
    events.push(event);
  }

  return { contractId, version, events };
}

function parseEvent(input: unknown, path: string): EventDefinition {
  const doc = requireObject(input, path);

  const name = requireName(doc.name, `${path}.name`);
  const topic = requireString(doc.topic, `${path}.topic`);
  if (topic.length === 0 || topic.length > MAX_TOPIC_LENGTH) {
    throw new SchemaValidationError(`${path}.topic must be 1–${MAX_TOPIC_LENGTH} characters`);
  }

  const rawFields = doc.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw new SchemaValidationError(`${path}.fields must declare at least one field`);
  }
  if (rawFields.length > MAX_FIELDS_PER_EVENT) {
    throw new SchemaValidationError(
      `${path} declares ${rawFields.length} fields, more than the limit of ${MAX_FIELDS_PER_EVENT}`
    );
  }

  const fields: FieldDefinition[] = [];
  const seenFieldNames = new Set<string>();

  for (const [index, rawField] of rawFields.entries()) {
    const field = parseField(rawField, `${path}.fields[${index}]`);
    if (seenFieldNames.has(field.name)) {
      throw new SchemaValidationError(`duplicate field name "${field.name}" in event "${name}"`);
    }
    seenFieldNames.add(field.name);
    fields.push(field);
  }

  return { name, topic, fields };
}

function parseField(input: unknown, path: string): FieldDefinition {
  const doc = requireObject(input, path);

  const name = requireName(doc.name, `${path}.name`);
  if (RESERVED_FIELD_NAMES.has(name.toLowerCase())) {
    throw new SchemaValidationError(`${path}.name "${name}" is reserved`);
  }

  const type = requireString(doc.type, `${path}.type`) as FieldType;
  if (!FIELD_TYPES.includes(type)) {
    throw new SchemaValidationError(
      `${path}.type "${type}" is not one of: ${FIELD_TYPES.join(', ')}`
    );
  }

  const source = requireString(doc.source, `${path}.source`);
  if (!SOURCE_PATTERN.test(source)) {
    throw new SchemaValidationError(
      `${path}.source "${source}" must be "topic[N]", "value", or "value.path.to.field"`
    );
  }

  const optional = doc.optional === undefined ? false : requireBoolean(doc.optional, `${path}.optional`);

  return { name, type, source, optional };
}

// ── Primitive guards ───────────────────────────────────────────────────────

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new SchemaValidationError(`${path} must be a string`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaValidationError(`${path} must be a boolean`);
  }
  return value;
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SchemaValidationError(`${path} must be an integer`);
  }
  return value;
}

function requireName(value: unknown, path: string): string {
  const name = requireString(value, path);
  if (!NAME_PATTERN.test(name)) {
    throw new SchemaValidationError(
      `${path} "${name}" must start with a letter and contain only letters, digits and underscores`
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new SchemaValidationError(`${path} "${name}" is longer than ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

/** The event definition matching a raw event's first topic, if any. */
export function findEventDefinition(schema: ContractSchema, topics: string[]): EventDefinition | null {
  const first = normalizeTopic(topics[0]);
  if (first === null) return null;
  return schema.events.find(event => event.topic === first) ?? null;
}

/**
 * The indexer stores topics as JSON-encoded decoded ScVals, so a symbol topic
 * arrives as `"transfer"` — quotes included. Schemas are written in terms of
 * what the contract emits, so the quoting is stripped before matching.
 */
export function normalizeTopic(topic: string | undefined): string | null {
  if (typeof topic !== 'string') return null;
  try {
    const parsed = JSON.parse(topic);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
    return topic;
  } catch {
    return topic;
  }
}

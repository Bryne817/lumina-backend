#!/usr/bin/env node
/**
 * Register, inspect or remove a contract's custom event schema.
 *
 * ## Why registration is off-chain
 *
 * The issue floated repurposing the Registry contract's `description` field.
 * That field is user-facing metadata with a length the contract enforces, and
 * changing it costs a fee and needs the owner's signing key — for a document
 * that gets iterated on repeatedly while a project gets its field mappings
 * right. Overloading it would also mean anyone reading the Registry sees a JSON
 * blob where a description belongs.
 *
 * So the Registry keeps doing what it is good at — deciding *which* contracts
 * get indexed — and the schema describing *how* to decode them lives beside the
 * data it produces, where the indexer can read it without an RPC round trip and
 * a project can revise it without a transaction.
 *
 * Usage:
 *   register-schema apply   <schema.json>
 *   register-schema show    <contractId>
 *   register-schema list
 *   register-schema remove  <contractId>
 *
 * Reads DATABASE_URL from the environment.
 */
import { readFileSync } from 'fs';
import { createPool, deleteContractSchema, loadContractSchemas, upsertContractSchema } from './db';
import { parseContractSchema, SchemaValidationError } from './customSchema';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumina';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  register-schema apply  <schema.json>   Validate and register a schema',
      '  register-schema show   <contractId>    Print a registered schema',
      '  register-schema list                   List registered contracts',
      '  register-schema remove <contractId>    Remove a schema',
    ].join('\n')
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (!command) usage();

  const pool = createPool(DATABASE_URL);

  try {
    switch (command) {
      case 'apply': {
        if (!argument) usage();

        let document: unknown;
        try {
          document = JSON.parse(readFileSync(argument, 'utf-8'));
        } catch (err) {
          // A syntax error in the file is the most common failure by far, and
          // it deserves a better message than a stack trace.
          console.error(`Could not read ${argument}: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }

        // Validated before it touches the database, so a malformed schema is
        // rejected outright rather than stored and skipped later.
        const schema = parseContractSchema(document);
        await upsertContractSchema(pool, schema);

        console.log(`Registered schema v${schema.version} for ${schema.contractId}`);
        for (const event of schema.events) {
          const fields = event.fields.map(f => `${f.name}: ${f.type}`).join(', ');
          console.log(`  ${event.name} (topic "${event.topic}") — ${fields}`);
        }
        console.log('\nThe indexer picks this up on its next poll; no restart needed.');
        break;
      }

      case 'show': {
        if (!argument) usage();
        const schema = (await loadContractSchemas(pool)).get(argument);
        if (!schema) {
          console.error(`No schema registered for ${argument}`);
          process.exit(1);
        }
        console.log(JSON.stringify(schema, null, 2));
        break;
      }

      case 'list': {
        const schemas = await loadContractSchemas(pool);
        if (schemas.size === 0) {
          console.log('No custom schemas registered.');
          break;
        }
        for (const [contractId, schema] of schemas) {
          const events = schema.events.map(e => e.name).join(', ');
          console.log(`${contractId}  v${schema.version}  [${events}]`);
        }
        break;
      }

      case 'remove': {
        if (!argument) usage();
        await deleteContractSchema(pool, argument);
        console.log(`Removed schema for ${argument}`);
        console.log('Already-decoded rows in custom_events are left in place.');
        break;
      }

      default:
        usage();
    }
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      console.error(`Schema rejected: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

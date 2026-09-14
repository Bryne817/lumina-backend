import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import cors from 'cors';
import express from 'express';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import { Context, resolvers } from './resolvers';
import { LedgerNotifier, SubscriberLimitError } from './pubsub';

const typeDefs = readFileSync(join(__dirname, 'schema.graphql'), 'utf-8');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumina';
const PORT = parseInt(process.env.PORT ?? '4000', 10);
const MAX_SUBSCRIPTIONS = parseInt(process.env.MAX_SUBSCRIPTIONS ?? '500', 10);
const SUBSCRIPTION_QUEUE_LIMIT = parseInt(process.env.SUBSCRIPTION_QUEUE_LIMIT ?? '64', 10);

const pool = new Pool({ connectionString: DATABASE_URL });
const schema = makeExecutableSchema({ typeDefs, resolvers });

const notifier = new LedgerNotifier({
  connectionString: DATABASE_URL,
  maxSubscribers: MAX_SUBSCRIPTIONS,
  queueLimit: SUBSCRIPTION_QUEUE_LIMIT,
  log: (message, detail) => console.log(`[pubsub] ${message}`, detail ?? ''),
});

async function main() {
  const app = express();
  const httpServer = createServer(app);

  // Subscriptions need a real HTTP server to upgrade from, which
  // `startStandaloneServer` does not expose — hence Express here. The GraphQL
  // endpoint is mounted at both paths the previous standalone server answered
  // on, so no existing client has to change its URL.
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });

  const wsCleanup = useServer(
    {
      schema,
      context: async (): Promise<Context> => ({ pool, notifier }),
      onError: (_ctx: unknown, _message: unknown, errors: readonly Error[]) => {
        for (const error of errors) {
          console.error('[subscription] error', error.message);
        }
      },
      // A subscription refused for being over the cap should close cleanly with
      // a reason, not surface as an unhandled server error.
      onSubscribe: () => {
        if (notifier.subscriberCount >= MAX_SUBSCRIPTIONS) {
          // Returned as a GraphQLError so graphql-ws sends the client a proper
          // `error` message and closes the operation, rather than the
          // subscription failing later as an unhandled server error.
          return [new GraphQLError(new SubscriberLimitError(MAX_SUBSCRIPTIONS).message)];
        }
        return undefined;
      },
    },
    wsServer
  );

  const server = new ApolloServer<Context>({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        // Draining the websocket layer on shutdown as well, so a deploy does
        // not leave sockets hanging.
        async serverWillStart() {
          return {
            async drainServer() {
              await wsCleanup.dispose();
              await notifier.stop();
            },
          };
        },
      },
    ],
  });

  await server.start();
  await notifier.start();

  const middleware = [
    cors(),
    express.json(),
    expressMiddleware(server, { context: async () => ({ pool }) }),
  ];
  app.use('/graphql', ...middleware);
  app.use('/', ...middleware);

  await new Promise<void>(resolve => httpServer.listen({ port: PORT }, resolve));

  console.log(`Lumina GraphQL server running at http://localhost:${PORT}/graphql`);
  console.log(`Subscriptions at ws://localhost:${PORT}/graphql`);
  console.log(`Database: ${DATABASE_URL}`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received — shutting down.`);
      void server.stop().then(() => process.exit(0));
    });
  }
}

main().catch(err => {
  console.error('Failed to start GraphQL server:', err);
  process.exit(1);
});

import { createServer } from 'node:http';
import {
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { createYoga } from 'graphql-yoga';
import pg from 'pg';
import { createPostgres } from '@simtlix/simfinity-postgres';

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    createdBy: {
      type: GraphQLString,
      extensions: { readOnly: true },
    },
    seasons: {
      type: new GraphQLList(SeasonType),
      extensions: {
        relation: { embedded: false, connectionField: 'serie' },
      },
    },
  }),
});

const SeasonType = new GraphQLObjectType({
  name: 'Season',
  fields: () => ({
    id: { type: GraphQLID },
    number: { type: new GraphQLNonNull(GraphQLInt) },
    serie: {
      type: new GraphQLNonNull(SerieType),
      extensions: {
        relation: { embedded: false, connectionField: 'serie' },
      },
    },
  }),
});

const serieController = {
  async onSaving(record, args, session, context) {
    record.name = args.name.trim();
    record.createdBy = context.user.id;
    await session.query('SELECT 1');
  },
};

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
const simfinity = createPostgres({
  pool,
  schema: process.env.PGSCHEMA || 'series_api',
});

simfinity.connect(null, SerieType, 'serie', 'series', serieController);
simfinity.connect(null, SeasonType, 'season', 'seasons');
const schema = simfinity.createSchema();

const initializationMode = process.env.SIMFINITY_SCHEMA_MODE === 'validate'
  ? 'validate'
  : 'create';
await simfinity.initializeDatabase({ mode: initializationMode });

const yoga = createYoga({
  schema,
  context: () => ({ user: { id: 'quickstart-user' } }),
});
const server = createServer(yoga);
await new Promise((resolve) => server.listen(4000, '127.0.0.1', resolve));
console.log('GraphQL ready at http://127.0.0.1:4000/graphql');

const shutdown = async () => {
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  await pool.end();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

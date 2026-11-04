import { GraphQLID, GraphQLObjectType, GraphQLString, GraphQLNonNull, GraphQLList, graphql } from 'graphql';
import { createRuntime } from '../../packages/core/src/index.js';
import { buildClientDescriptor } from '../../packages/descriptor/src/index.js';

export const clientSchema = ({ singular = 'book', plural = 'books', protectedRecords = false } = {}) => {
  const adapter = { createModel: (type) => ({ name: type.name }), writeFeatures: { optimisticConcurrency: true }, assertTransactionModels() {}, withTransaction: async (session, body) => body(session || {}) };
  const runtime = createRuntime(adapter);
  const Book = new GraphQLObjectType({ name: 'book', extensions: protectedRecords ? { concurrency: { mode: 'optimistic' } } : {}, fields: {
    id: { type: GraphQLID }, title: { type: new GraphQLNonNull(GraphQLString) },
    tags: { type: new GraphQLList(GraphQLString) },
    computed: { type: GraphQLString, extensions: { virtual: true }, args: { prefix: { type: new GraphQLNonNull(GraphQLString) } }, resolve: (_, { prefix }) => prefix },
  } });
  runtime.connect(null, Book, singular, plural);
  runtime.registerView('recent', { type: Book, description: 'Recent books', params: { term: { type: GraphQLString } }, where: () => [] });
  runtime.registerCustomQuery('same', 'Custom query', null, GraphQLString, () => 'query');
  runtime.registerMutation('same', 'Custom mutation', null, GraphQLString, () => 'mutation');
  const schema = runtime.createSchema(null, null, null, { transaction: { types: [Book], name: 'saveBooks' } });
  const descriptor = buildClientDescriptor(schema);
  return { runtime, schema, descriptor };
};

export const schemaFetch = (schema, descriptor, requests = []) => async (url, options = {}) => {
  requests.push({ url, ...options });
  if (options.method === 'GET') return new Response(JSON.stringify(descriptor), { headers: { 'Content-Type': 'application/json' } });
  const { query, variables } = JSON.parse(options.body);
  const contextValue = {};
  const result = await graphql({ schema, source: query, variableValues: variables, contextValue });
  if (contextValue.count !== undefined) result.extensions = { ...result.extensions, count: contextValue.count };
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};

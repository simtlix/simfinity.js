import { GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime } from '../../packages/core/src/index.js';
import { buildClientDescriptor } from '../../packages/descriptor/src/index.js';
import { createOptimisticMemoryAdapter } from './optimistic-memory-adapter.js';

export const clientWriteSchema = (runtime = createRuntime(createOptimisticMemoryAdapter())) => {
  const State = new GraphQLEnumType({ name: 'ClientEntryState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Detail = new GraphQLObjectType({ name: 'ClientDetail', fields: { text: { type: GraphQLString }, count: { type: GraphQLInt } } });
  const Entry = new GraphQLObjectType({ name: 'ClientEntry', extensions: { concurrency: { mode: 'optimistic' } }, fields: () => ({
    id: { type: GraphQLID }, name: { type: GraphQLString }, state: { type: State },
    tags: { type: new GraphQLList(GraphQLString) }, numbers: { type: new GraphQLList(GraphQLInt) },
    detail: { type: Detail, extensions: { relation: { embedded: true } } },
    lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: false, connectionField: 'entry' } } },
  }) });
  const Line = new GraphQLObjectType({ name: 'ClientLine', extensions: { concurrency: { mode: 'optimistic' } }, fields: () => ({
    id: { type: GraphQLID }, title: { type: GraphQLString },
    entry: { type: new GraphQLNonNull(Entry), extensions: { relation: { embedded: false } } },
  }) });
  runtime.addNoEndpointType(Detail);
  runtime.connect(null, Entry, 'entry', 'entries', {}, null, { initialState: { name: 'OPEN', value: 'OPEN' }, actions: { close: { from: { name: 'OPEN', value: 'OPEN' }, to: { name: 'CLOSED', value: 'CLOSED' } } } });
  runtime.connect(null, Line, 'line', 'lines');
  const schema = runtime.createSchema(null, null, null, { transaction: { name: 'saveEntries', types: [Entry, Line] } });
  return { runtime, schema, descriptor: buildClientDescriptor(schema), Entry, Line };
};

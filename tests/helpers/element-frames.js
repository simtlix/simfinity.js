import { GraphQLBoolean, GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString } from 'graphql';

const embedded = { relation: { embedded: true } };
export const elementGroup = (quantifier = 'ANY', path = 'lines', conditions = [{ field: 'quantity', operator: 'LTE', valuePath: '$parent.limit' }], extra = {}) => ({ AND: [{ [quantifier]: [{ path, conditions, ...extra }] }] });
export const elementFixture = (prefix, owned = false) => {
  const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => new Date(value).toISOString(), parseValue: (value) => new Date(value), parseLiteral: (node) => new Date(node.value) });
  const Kind = new GraphQLEnumType({ name: `${prefix}Kind`, values: { ONE: { value: 'two' }, TWO: { value: 2 } } });
  const ref = { relation: { embedded: false, connectionField: 'providerKey' } };
  const Bundle = new GraphQLObjectType({ name: `${prefix}Bundle`, fields: () => ({ quantity: { type: GraphQLInt }, ...(owned ? { provider: { type: Provider, extensions: ref } } : {}) }) });
  const Metric = new GraphQLObjectType({ name: `${prefix}Metric`, fields: { quantity: { type: GraphQLInt } } });
  const Line = new GraphQLObjectType({ name: `${prefix}Line`, fields: () => ({
    id: { type: GraphQLString }, quantity: { type: GraphQLInt }, limit: { type: GraphQLInt }, sku: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) },
    at: { type: DateTime }, kind: { type: Kind }, bundles: { type: new GraphQLList(Bundle), extensions: embedded },
    metrics: { type: new GraphQLList(Metric), extensions: embedded },
    detail: { type: Bundle, extensions: embedded }, ...(owned ? { provider: { type: Provider, extensions: ref } } : {}),
  }) });
  const Shipping = new GraphQLObjectType({ name: `${prefix}Shipping`, fields: { limit: { type: GraphQLInt }, lines: { type: new GraphQLList(Line), extensions: embedded } } });
  const Provider = new GraphQLObjectType({ name: `${prefix}Provider`, fields: () => ({
    id: { type: GraphQLID }, key: { type: GraphQLString }, limit: { type: GraphQLInt }, visible: { type: GraphQLBoolean },
    lines: { type: new GraphQLList(Line), extensions: embedded },
    orders: { type: new GraphQLList(Order), extensions: { relation: { embedded: false, connectionField: 'provider' } } },
  }) });
  const Batch = new GraphQLObjectType({ name: `${prefix}Batch`, fields: () => ({
    id: { type: GraphQLID }, key: { type: GraphQLString }, orders: { type: new GraphQLList(Order), extensions: { relation: { embedded: false, connectionField: 'batch' } } },
  }) });
  const Order = new GraphQLObjectType({ name: `${prefix}Order`, fields: {
    id: { type: GraphQLID }, key: { type: GraphQLString }, suite: { type: GraphQLString }, limit: { type: GraphQLInt }, amount: { type: GraphQLInt },
    at: { type: DateTime }, kind: { type: Kind }, provider: { type: Provider, extensions: ref },
    batch: { type: Batch, extensions: { relation: { embedded: false, connectionField: 'batchKey' } } },
    shipping: { type: Shipping, extensions: embedded }, lines: { type: new GraphQLList(Line), extensions: embedded },
  } });
  return { Order, Provider, Batch, embedded: [Shipping, Line, Bundle, Metric], registrations: [Order, Provider, Batch].map((gqltype) => ({ gqltype })) };
};

export const elementInputs = () => [
  ...[
    { key: 'a', lines: [{ quantity: 3 }, { quantity: 8 }] }, { key: 'b', lines: [{ quantity: 3 }, { quantity: 12 }] },
    { key: 'c', lines: [{ quantity: 12 }] }, { key: 'd', lines: [{ quantity: null }] }, { key: 'e', lines: [] },
    { key: 'f', lines: null }, { key: 'g' }, { key: 'h', lines: [null] }, { key: 'i', lines: [{}] },
    { key: 'j', limit: null, lines: [{ quantity: 3 }] }, { key: 'k', lines: [{ quantity: 3 }, { quantity: 3 }] },
  ].map((record) => ({ suite: 'base', limit: 10, amount: 1, ...record })),
  { key: 'n1', suite: 'nested', limit: 9, shipping: { limit: 5, lines: [
    { quantity: 4, limit: 3, metrics: [{ quantity: 2 }], bundles: [{ quantity: 2 }, { quantity: 4 }] }, { quantity: 1, limit: 5, bundles: [{ quantity: 4 }] },
  ] } },
  { key: 'n2', suite: 'nested', limit: 9, shipping: { limit: 5, lines: [{ quantity: 8, limit: 3, metrics: [{ quantity: 4 }], bundles: [{ quantity: 4 }] }] } },
  { key: 'n3', suite: 'nested', limit: 9, shipping: { limit: 5, lines: [{ quantity: 1, limit: 5, bundles: [{ quantity: 4 }, { quantity: 4 }] }] } },
  { key: 'x1', suite: 'correlation', limit: 10, lines: [{ id: 'x1', sku: 'A', quantity: 12, tags: ['VIP', 'promo'] }, { id: 'second', sku: 'B', quantity: 3, tags: [] }] },
  { key: 'x2', suite: 'correlation', limit: 10, lines: [{ id: 'unrelated', sku: 'A', quantity: 3, tags: ['VIP'] }] },
  { key: 't1', suite: 'typed', at: new Date('2024-01-01T00:00:00.123Z'), kind: 'two', lines: [{ at: new Date('2024-01-01T00:00:00.123Z'), kind: 'two' }] },
  { key: 't2', suite: 'typed', at: new Date('2024-06-01T12:30:00.456Z'), kind: 'two', lines: [{ at: new Date('2024-01-01T00:00:00.123Z'), kind: 2 }] },
];

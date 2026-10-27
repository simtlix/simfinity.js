// MCP and the generated transaction field (#151, spec section 5). The field is never published as a custom
// tool, also when a rebuilt schema lost its extensions or descriptions; `transactionTools: true` publishes it
// as one multi-write tool, subject to the name and type filters, with a @oneOf input schema, destructive
// annotations, the depth and collections of each operation's own tool, result items reduced to their id and
// their own operation key, and an atomic oversized notice. Real graphql()
// execution and the in-memory adapter. Schemas rebuilt from introspection are built in a fresh process.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType,
  GraphQLSchema, GraphQLString, buildASTSchema, getIntrospectionQuery, graphql, graphqlSync, parse, printSchema, visit,
} from 'graphql';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createRuntime } from '@simtlix/simfinity-core';
import { generateMCPTools } from '../packages/mcp/src/index.js';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';

const OPTIMISTIC = { mode: 'optimistic' };
const MARKER = 'Simfinity transaction: runs the listed generated mutations in order in one database transaction.';
// The operation keys of the fixture's transaction field, in field order.
const KEYS = ['addproducto', 'deleteproducto', 'addpedido', 'deletepedido', 'updateproducto', 'updatepedido', 'close_pedido'];
// The types its operations write: their own types and, transitively, their nested collection targets.
const REACHED = ['Producto', 'Pedido', 'Item', 'Nota'];
const STORED = ['Pedido:1', 'Producto:1'];
// Simfinity's field metadata types are process-wide: every schema of the process gets them from GraphQL's
// own __Field, so a schema rebuilt in the same process must not declare them again.
const METADATA_TYPES = ['FieldExtensionsType', 'RelationType'];
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MCP_MODULE = new URL('../packages/mcp/src/index.js', import.meta.url).href;
const DESTRUCTIVE = {
  title: 'transaction', openWorldHint: false, readOnlyHint: false, destructiveHint: true, idempotentHint: false,
};

const byName = (tools, name) => tools.find((tool) => tool.name === name);
const names = (tools) => tools.map((tool) => tool.name);
const toolNames = (schema, options) => names(generateMCPTools(schema, options).tools);

// The error a call throws, as code, status and message.
const thrown = (call) => {
  try {
    call();
  } catch (error) {
    return { code: error.extensions?.code, status: error.extensions?.status, message: error.message };
  }
  throw new Error('expected the call to throw');
};

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});
const mcpWarnings = () => warn.mock.calls.map(([message]) => String(message))
  .filter((message) => message.startsWith('[simfinity-mcp]'));

// Task 6's fixture: unprotected Producto, with a required name; protected Pedido, with a state machine, an
// embedded Direccion and a collection of protected Items; each Item has a collection of unprotected Notas.
// Direccion has no endpoint. With `virtuals`, Producto also has the virtual fields `label`, of the default
// mcp mode, and `badge`, with mcp: 'select', resolved by the functions `virtuals` names.
const defineTypes = ({ virtuals } = {}) => {
  const State = new GraphQLEnumType({ name: 'TxState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Direccion = new GraphQLObjectType({ name: 'Direccion', fields: { calle: { type: GraphQLString } } });
  const Producto = new GraphQLObjectType({
    name: 'Producto',
    fields: {
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      price: { type: GraphQLInt },
      ...(virtuals ? {
        label: { type: GraphQLString, extensions: { virtual: true }, resolve: virtuals.label },
        badge: { type: GraphQLString, extensions: { virtual: { mcp: 'select' } }, resolve: virtuals.badge },
      } : {}),
    },
  });
  const Nota = new GraphQLObjectType({
    name: 'Nota',
    fields: () => ({
      id: { type: GraphQLID },
      texto: { type: GraphQLString },
      item: { type: Item, extensions: { relation: { embedded: false } } },
    }),
  });
  const Item = new GraphQLObjectType({
    name: 'Item',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      nombre: { type: GraphQLString },
      pedido: { type: Pedido, extensions: { relation: { embedded: false } } },
      notas: { type: new GraphQLList(Nota), extensions: { relation: { embedded: false, connectionField: 'item' } } },
    }),
  });
  const Pedido = new GraphQLObjectType({
    name: 'Pedido',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      numero: { type: GraphQLString },
      state: { type: State },
      direccion: { type: Direccion, extensions: { relation: { embedded: true } } },
      items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'pedido' } } },
    }),
  });
  return {
    Direccion, Producto, Nota, Item, Pedido,
  };
};

// The schema, with the transaction field over Producto, Pedido and `extras` more types, Extra0, Extra1…,
// each with its add, update and delete keys, unless `transaction` is false. Producto 1 and the open
// Pedido 1, at version 1, are stored.
const build = ({ transaction = true, extras = 0, virtuals } = {}) => {
  const adapter = createOptimisticMemoryAdapter();
  vi.spyOn(adapter, 'withTransaction');
  vi.spyOn(adapter, 'saveRecord');
  const runtime = createRuntime(adapter);
  const types = defineTypes({ virtuals });
  const extraTypes = Array.from({ length: extras }, (_, index) => new GraphQLObjectType({
    name: `Extra${index}`, fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
  }));
  runtime.addNoEndpointType(types.Direccion);
  runtime.connect(null, types.Producto, 'producto', 'productos');
  runtime.connect(null, types.Pedido, 'pedido', 'pedidos', null, null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: {
        from: { name: 'OPEN', value: 'OPEN' },
        to: { name: 'CLOSED', value: 'CLOSED' },
        description: 'Close the order',
        action: async () => {},
      },
    },
  });
  runtime.connect(null, types.Item, 'item', 'items');
  runtime.connect(null, types.Nota, 'nota', 'notas');
  extraTypes.forEach((type, index) => runtime.connect(null, type, `extra${index}`, `extras${index}`));
  const schema = runtime.createSchema(null, null, null,
    transaction ? { transaction: { types: [types.Producto, types.Pedido, ...extraTypes] } } : undefined);
  adapter.seed('Producto', { _id: '1', name: 'kept', price: 1 });
  adapter.seed('Pedido', {
    _id: '1', numero: 'P', state: 'OPEN', version: 1,
  });
  // Every call core made to the adapter's data methods, its transactions and the affinity check.
  const adapterCalls = () => ['getById', 'update', 'delete', 'find', 'saveRecord', 'withTransaction', 'assertTransactionModels']
    .reduce((total, method) => total + (adapter[method]?.mock?.calls.length ?? 0), 0);
  const storedKeys = () => [...adapter.records.keys()].sort();
  return {
    adapter, schema, types, adapterCalls, storedKeys,
  };
};

// The schema rebuilt from its SDL in this process, as a client does: without the metadata types, without
// any description when `descriptions` is false, and without the output fields `without` names by type.
const fromSDL = (schema, { descriptions = true, without = {} } = {}) => {
  const document = parse(printSchema(schema));
  const definitions = document.definitions
    .filter((definition) => !METADATA_TYPES.includes(definition.name?.value))
    .map((definition) => (Object.hasOwn(without, definition.name?.value ?? '')
      ? { ...definition, fields: definition.fields.filter((field) => field.name.value !== without[definition.name.value]) }
      : definition));
  const rebuilt = { ...document, definitions };
  return buildASTSchema(descriptions
    ? rebuilt
    : visit(rebuilt, { enter: (node) => (node.description ? { ...node, description: undefined } : undefined) }));
};

// A copy of the schema whose Mutation type has `field` too, under `name`.
const withMutationField = (schema, name, field) => {
  const config = schema.toConfig();
  const mutation = schema.getMutationType().toConfig();
  return new GraphQLSchema({
    ...config,
    mutation: new GraphQLObjectType({ ...mutation, fields: { ...mutation.fields, [name]: field } }),
    types: config.types.filter((type) => type !== schema.getMutationType()),
  });
};
const operationsArgument = (type) => ({ operations: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type))) } });

// Builds the schema a client rebuilds from the introspection result of `schema`, with or without `isOneOf`,
// and generates its tools once per entry of `runs`, the options of that run, in a fresh node process: the
// field metadata types are process-wide (see tests/schema-initialization.test.js). Each run reports the
// published names, the transaction tool and its operation, or null, and the warnings MCP printed.
const CHILD = `
import { buildClientSchema } from 'graphql';
import { generateMCPTools } from ${JSON.stringify(MCP_MODULE)};
const metadataTypes = ${JSON.stringify(METADATA_TYPES)};
process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { introspection, runs } = JSON.parse(input);
const warnings = [];
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
const schema = buildClientSchema({
  __schema: { ...introspection.__schema, types: introspection.__schema.types.filter(({ name }) => !metadataTypes.includes(name)) },
});
const results = runs.map((options) => {
  const { tools, getOperation } = generateMCPTools(schema, options);
  const tool = tools.find(({ name }) => name === 'transaction') ?? null;
  return {
    names: tools.map(({ name }) => name), tool, operation: tool && getOperation('transaction'), warnings: warnings.splice(0),
  };
});
process.stdout.write(JSON.stringify({ isOneOf: schema.getType('TransactionOperation').isOneOf, results }));
`;
// With `descriptions: false` the introspection query requests no descriptions, and `drop` names a mutation
// that the rebuilt Mutation type leaves out.
const fromIntrospection = (schema, oneOf, runs, { descriptions = true, drop } = {}) => {
  const { data, errors } = graphqlSync({ schema, source: getIntrospectionQuery({ oneOf, descriptions }) });
  expect(errors).toBeUndefined();
  const mutationName = data.__schema.mutationType.name;
  const introspection = drop === undefined ? data : {
    __schema: {
      ...data.__schema,
      types: data.__schema.types.map((type) => (type.name === mutationName
        ? { ...type, fields: type.fields.filter(({ name }) => name !== drop) }
        : type)),
    },
  };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: ROOT, input: JSON.stringify({ introspection, runs }), encoding: 'utf8', timeout: 30000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

// The selection set a mutation tool's operation gives its root field.
const selectionOf = (operation) => {
  const call = operation.split('\n')[1];
  return call.slice(call.indexOf(')') + 1);
};

describe('by default', () => {
  test('the transaction field is omitted, and every other tool is the one of the schema without it', () => {
    const fixture = build();
    expect(fixture.schema.getMutationType().getFields().transaction.description).toBe(MARKER);
    const expected = JSON.stringify(generateMCPTools(build({ transaction: false }).schema).tools);
    for (const options of [{}, { transactionTools: undefined }, { transactionTools: null }, { transactionTools: false }]) {
      expect(JSON.stringify(generateMCPTools(fixture.schema, options).tools)).toBe(expected);
    }
    // Naming it does not publish it either.
    expect(toolNames(fixture.schema, { include: ['transaction'] })).toEqual([]);
    expect(mcpWarnings()).toEqual([]);
  });

  test.each([['yes', '"yes"'], [1, '1'], ['true', '"true"'], [{}, 'object']])('transactionTools %j throws MCP_INVALID_OPTIONS', (value, shown) => {
    const { schema } = build();
    expect(thrown(() => generateMCPTools(schema, { transactionTools: value }))).toEqual({
      code: 'MCP_INVALID_OPTIONS', status: 500, message: `transactionTools must be true, false or null, got ${shown}`,
    });
  });
});

describe('transactionTools: true', () => {
  test('publishes it as one destructive, non-idempotent mutation tool named after the field', () => {
    const { schema } = build();
    const { tools, getOperation } = generateMCPTools(schema, { transactionTools: true });
    const tool = byName(tools, 'transaction');
    expect(tool).toMatchObject({ name: 'transaction', title: 'transaction', kind: 'mutation' });
    expect(tool.description.startsWith(`${MARKER} `)).toBe(true);
    expect(tool.annotations).toEqual(DESTRUCTIVE);
    expect(getOperation('transaction').split('\n').slice(0, 2)).toEqual([
      'mutation transactionOperation($operations: [TransactionOperation!]!) {',
      expect.stringMatching(/^ {2}transaction\(operations: \$operations\) \{ id addproducto \{ /),
    ]);
    expect(names(tools).filter((name) => name !== 'transaction')).toEqual(toolNames(schema));
    expect(mcpWarnings()).toEqual([]);
  });

  test('include selects it by its own name or by mutation, without listing its operation keys', () => {
    const { schema } = build();
    expect(toolNames(schema, { transactionTools: true, include: ['transaction'] })).toEqual(['transaction']);
    expect(toolNames(schema, { transactionTools: true, include: 'mutation' })).toContain('transaction');
    expect(toolNames(schema, { transactionTools: true, include: ['addproducto'] })).toEqual(['addproducto']);
    for (const include of [['transaction'], ['shop_transaction']]) {
      expect(toolNames(schema, { transactionTools: true, toolNamePrefix: 'shop_', include })).toEqual(['shop_transaction']);
    }
  });

  test.each([
    { exclude: ['deleteproducto'] },
    { exclude: 'close_pedido', include: ['transaction'] },
    { exclude: ['deleteproducto'], toolNamePrefix: 'shop_' },
    { exclude: ['shop_deleteproducto'], toolNamePrefix: 'shop_' },
    { exclude: 'mutation', include: ['transaction'] },
    { exclude: ['transaction'] },
  ])('exclude omits it when it names the field, an operation key or mutation: %j', (options) => {
    const { schema } = build();
    const published = toolNames(schema, { transactionTools: true, ...options });
    expect(published.filter((name) => name.endsWith('transaction'))).toEqual([]);
  });
});

describe('type filters', () => {
  test('excludeTypes omits it when it names a type an operation writes, nested collection targets included', () => {
    const { schema } = build();
    for (const typeName of REACHED) {
      expect(toolNames(schema, { transactionTools: true, excludeTypes: [typeName] }), typeName).not.toContain('transaction');
    }
    // The result type is no entity, and other types do not matter.
    expect(toolNames(schema, { transactionTools: true, excludeTypes: ['TransactionResult', 'Otro'] })).toContain('transaction');
  });

  test('includeTypes publishes it only when it lists every type an operation writes', () => {
    const { schema } = build();
    expect(toolNames(schema, { transactionTools: true, includeTypes: REACHED })).toContain('transaction');
    for (const missing of REACHED) {
      const includeTypes = [...REACHED.filter((typeName) => typeName !== missing), 'TransactionResult'];
      expect(toolNames(schema, { transactionTools: true, includeTypes }), missing).not.toContain('transaction');
    }
  });

  test('without extensions, a collection maps through the output field of the same name, and an unresolved one omits it', () => {
    const { schema } = build();
    const rebuilt = fromSDL(schema);
    expect(rebuilt.getMutationType().getFields().transaction.extensions).not.toHaveProperty('simfinityTransaction');
    expect(toolNames(rebuilt, { transactionTools: true, includeTypes: REACHED })).toContain('transaction');
    expect(toolNames(rebuilt, { transactionTools: true, excludeTypes: ['Nota'] })).not.toContain('transaction');
    // Item.notas, the output field of the collection that Item's inputs declare, is missing.
    const unresolved = fromSDL(schema, { without: { Item: 'notas' } });
    expect(toolNames(unresolved, { transactionTools: true, excludeTypes: ['Otro'] })).not.toContain('transaction');
    expect(toolNames(unresolved, { transactionTools: true, includeTypes: REACHED })).not.toContain('transaction');
    // Pin: without type filters, the unresolved target is never looked up, and the tool is published.
    expect(toolNames(unresolved, { transactionTools: true })).toContain('transaction');
    expect(mcpWarnings()).toEqual([]);
  });
});

describe('exclusion without extensions', () => {
  test('a schema rebuilt from SDL without descriptions never publishes it, and the opt-in warns once and omits it', () => {
    const rebuilt = fromSDL(build().schema, { descriptions: false });
    const field = rebuilt.getMutationType().getFields().transaction;
    expect(field.description).toBeUndefined();
    expect(field.extensions).not.toHaveProperty('simfinityTransaction');
    const published = toolNames(rebuilt);
    expect(published).not.toContain('transaction');
    // Without the descriptions that recognize them, the generated roots are custom tools: that fallback is
    // what the field must never reach.
    expect(byName(generateMCPTools(rebuilt).tools, 'addproducto').title).toBe('addproducto');
    expect(published).toEqual(toolNames(fromSDL(build({ transaction: false }).schema, { descriptions: false })));
    expect(mcpWarnings()).toEqual([]);

    expect(toolNames(rebuilt, { transactionTools: true })).not.toContain('transaction');
    expect(toolNames(rebuilt, { transactionTools: true })).not.toContain('transaction');
    expect(mcpWarnings()).toHaveLength(1);
    expect(mcpWarnings()[0]).toContain('"transaction"');
    expect(mcpWarnings()[0]).toContain('getIntrospectionQuery({ oneOf: true })');
  });

  test('a rebuild without descriptions that also drops a generated mutation never publishes it either, and the opt-in warns once and omits it', () => {
    const drop = { descriptions: false, without: { Mutation: 'deleteproducto' } };
    const rebuilt = fromSDL(build().schema, drop);
    expect(rebuilt.getMutationType().getFields()).not.toHaveProperty('deleteproducto');
    expect(rebuilt.getType('TransactionOperation').getFields()).toHaveProperty('deleteproducto');
    // Its operation keys no longer all match a mutation, but its shape still excludes it: it is no custom tool.
    const published = toolNames(rebuilt);
    expect(published).not.toContain('transaction');
    expect(published).toContain('addproducto');
    expect(published).toEqual(toolNames(fromSDL(build({ transaction: false }).schema, drop)));
    expect(mcpWarnings()).toEqual([]);

    expect(toolNames(rebuilt, { transactionTools: true })).not.toContain('transaction');
    expect(toolNames(rebuilt, { transactionTools: true })).not.toContain('transaction');
    expect(mcpWarnings()).toHaveLength(1);
    expect(mcpWarnings()[0]).toContain('"transaction"');
  });

  test('the structure alone excludes a mutation, without @oneOf', () => {
    const { schema } = build({ transaction: false });
    const BatchDelete = new GraphQLInputObjectType({ name: 'BatchDelete', fields: { id: { type: new GraphQLNonNull(GraphQLID) } } });
    const BatchOperation = new GraphQLInputObjectType({
      name: 'BatchOperation',
      fields: {
        addproducto: { type: schema.getType('ProductoInput') },
        deleteproducto: { type: BatchDelete },
        deletepedido: { type: schema.getType('RecordVersionRef') },
        close_pedido: { type: schema.getType('PedidoInputForUpdate') },
      },
    });
    const copy = withMutationField(schema, 'batch', { type: GraphQLString, args: operationsArgument(BatchOperation), resolve: () => 'ran' });
    expect(toolNames(copy)).not.toContain('batch');
    expect(toolNames(copy, { transactionTools: true })).not.toContain('batch');
    expect(mcpWarnings()).toHaveLength(1);
    expect(mcpWarnings()[0]).toContain('"batch"');
  });

  test.each([
    ['the extension', { description: 'Archive things.', extensions: { simfinityTransaction: { name: 'archive', types: [] } } }],
    ['the marker', { description: `${MARKER} Hand-written.` }],
  ])('%s alone excludes a mutation', (criterion, marks) => {
    const { schema } = build({ transaction: false });
    const copy = withMutationField(schema, 'archive', {
      type: GraphQLString, args: { note: { type: GraphQLString } }, resolve: () => 'ran', ...marks,
    });
    expect(toolNames(copy)).not.toContain('archive');
    expect(mcpWarnings()).toEqual([]);
    expect(toolNames(copy, { transactionTools: true })).not.toContain('archive');
    expect(mcpWarnings()).toHaveLength(1);
  });

  const addAndRefresh = (schema) => ({ addproducto: { type: schema.getType('ProductoInput') }, refresh: { type: GraphQLString } });
  test.each([
    ['an operation that is no generated mutation', addAndRefresh, {}],
    ['an operation whose input is another type', (schema) => ({ addproducto: { type: schema.getType('PedidoInput') } }), {}],
    ['a delete whose input lacks the version', (schema) => ({ deletepedido: { type: schema.getType('IdInputType') } }), {}],
    ['@oneOf operations, one of them no generated mutation, returning a scalar', addAndRefresh, { isOneOf: true }],
    ['@oneOf operations, one of them no generated mutation, returning a list without a field for it', addAndRefresh, { isOneOf: true, returns: ['addproducto'] }],
    ['operations, one of which names a generated mutation without matching it, returning a list', (schema) => ({
      ...addAndRefresh(schema), deletepedido: { type: schema.getType('IdInputType') },
    }), { returns: ['addproducto', 'refresh', 'deletepedido'] }],
  ])('pin: a custom mutation with %s stays a custom tool', (label, fields, { isOneOf = false, returns }) => {
    const { schema } = build({ transaction: false });
    const BulkOperation = new GraphQLInputObjectType({ name: 'BulkOperation', fields: fields(schema), isOneOf });
    // `returns` lists the fields, next to id, of the object type whose list the mutation returns.
    const type = returns ? new GraphQLList(new GraphQLObjectType({
      name: 'BulkResult',
      fields: Object.fromEntries([['id', { type: GraphQLID }], ...returns.map((name) => [name, { type: GraphQLString }])]),
    })) : GraphQLString;
    const copy = withMutationField(schema, 'bulk', { type, args: operationsArgument(BulkOperation), resolve: () => (returns ? [] : 'ran') });
    const tool = byName(generateMCPTools(copy).tools, 'bulk');
    expect(tool).toMatchObject({
      title: 'bulk',
      description: 'Execute the `bulk` operation.',
      annotations: { title: 'bulk', openWorldHint: false, readOnlyHint: false },
    });
    expect(toolNames(copy, { transactionTools: true })).toContain('bulk');
    expect(mcpWarnings()).toEqual([]);
  });
});

describe('a schema rebuilt from introspection, in a fresh process', () => {
  test('without descriptions or oneOf, a rebuild that also drops a generated mutation is never published either', () => {
    const { isOneOf, results: [byDefault, optedIn] } = fromIntrospection(build().schema, false, [{}, { transactionTools: true }], {
      descriptions: false, drop: 'deleteproducto',
    });
    expect(isOneOf).toBe(false);
    expect(byDefault.names).toContain('addproducto');
    expect(byDefault.names).not.toContain('deleteproducto');
    expect(byDefault.names).not.toContain('transaction');
    expect(byDefault.warnings).toEqual([]);
    expect(optedIn.names).not.toContain('transaction');
    expect(optedIn.warnings).toHaveLength(1);
    expect(optedIn.warnings[0]).toContain('"transaction"');
  });

  test('without oneOf, it is never published, and the opt-in warns and omits it', () => {
    const { schema } = build();
    const { isOneOf, results: [byDefault, optedIn] } = fromIntrospection(schema, false, [{}, { transactionTools: true }]);
    expect(isOneOf).toBe(false);
    expect(byDefault.names).not.toContain('transaction');
    expect(byDefault.names).toContain('addproducto');
    expect(byDefault.warnings).toEqual([]);
    expect(optedIn.names).not.toContain('transaction');
    expect(optedIn.warnings).toHaveLength(1);
    expect(optedIn.warnings[0]).toContain('getIntrospectionQuery({ oneOf: true })');
  });

  test('with oneOf: true, it is classified: published only with the opt-in, filtered by the types it writes, and its operation runs on the server', async () => {
    const fixture = build();
    const { isOneOf, results: [byDefault, optedIn, excluded, included] } = fromIntrospection(fixture.schema, true, [
      {},
      { transactionTools: true },
      { transactionTools: true, excludeTypes: ['Nota'] },
      { transactionTools: true, includeTypes: REACHED },
    ]);
    expect(isOneOf).toBe(true);
    expect(byDefault.names).not.toContain('transaction');
    const original = generateMCPTools(fixture.schema, { transactionTools: true });
    expect(optedIn.tool).toEqual(JSON.parse(JSON.stringify(byName(original.tools, 'transaction'))));
    expect(optedIn.operation).toBe(original.getOperation('transaction'));
    expect(excluded.names).not.toContain('transaction');
    expect(included.names).toContain('transaction');
    expect([byDefault, optedIn, excluded, included].flatMap(({ warnings }) => warnings)).toEqual([]);

    const result = await graphql({
      schema: fixture.schema,
      source: optedIn.operation,
      variableValues: { operations: [{ addproducto: { name: 'a' } }, { updateproducto: { id: '$0', name: 'b' } }] },
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect(fixture.adapter.stored('Producto', '1000')).toMatchObject({ name: 'b' });
  });
});

describe('input schema', () => {
  test('each item is an object with exactly one known operation, whose value is not null; inner nullability is kept', () => {
    const tool = byName(generateMCPTools(build().schema, { transactionTools: true }).tools, 'transaction');
    expect(tool.inputSchema.properties.operations).toEqual({ type: 'array', items: { $ref: '#/$defs/TransactionOperation' } });
    expect(tool.inputSchema.required).toEqual(['operations']);
    const operation = tool.inputSchema.$defs.TransactionOperation;
    expect(operation).toMatchObject({
      type: 'object', minProperties: 1, maxProperties: 1, additionalProperties: false,
    });
    expect(operation.required).toBeUndefined();
    expect(Object.keys(operation.properties)).toEqual(KEYS);
    expect(operation.properties.addproducto).toEqual({ $ref: '#/$defs/ProductoInput' });
    expect(operation.properties.deleteproducto).toEqual({ $ref: '#/$defs/TransactionDeleteInput' });
    expect(operation.properties.deletepedido).toEqual({ $ref: '#/$defs/RecordVersionRef' });
    expect(operation.properties.close_pedido).toEqual({ $ref: '#/$defs/PedidoInputForUpdate' });
    expect(tool.inputSchema.$defs.ProductoInput.required).toEqual(['name']);
    expect(tool.inputSchema.$defs.ProductoInput.properties.price).toEqual({ type: ['integer', 'null'] });
    expect(tool.inputSchema.$defs.TransactionDeleteInput).toMatchObject({ required: ['id'], properties: { id: { type: 'string' } } });
  });

  test('two keys in one item, a null value, an unknown key or no key are rejected by the schema, and before execution', async () => {
    const fixture = build();
    const { tools, callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
    const validate = new AjvJsonSchemaValidator().getValidator(byName(tools, 'transaction').inputSchema);
    expect(validate({ operations: [{ addproducto: { name: 'a' } }, { deletepedido: { id: '1', version: 1 } }] }).valid).toBe(true);
    for (const item of [
      { addproducto: { name: 'a' }, deleteproducto: { id: '1' } },
      { addproducto: null },
      { addcliente: { name: 'a' } },
      {},
    ]) {
      expect(validate({ operations: [{ addproducto: { name: 'b' } }, item] }).valid, JSON.stringify(item)).toBe(false);
      const result = await callTool('transaction', { operations: [{ addproducto: { name: 'b' } }, item] });
      expect(result.isError, JSON.stringify(item)).toBe(true);
    }
    expect(fixture.adapterCalls()).toBe(0);
    expect(fixture.storedKeys()).toEqual(STORED);
  });

  test('a valid list runs in one transaction and returns one result per operation, with its id and its own operation key', async () => {
    const fixture = build();
    const { callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
    const result = await callTool('transaction', {
      operations: [{ addproducto: { name: 'a', price: 2 } }, { updateproducto: { id: '$0', name: 'b' } }, { deleteproducto: { id: '1' } }],
    });
    expect(result.isError).toBe(false);
    const expected = [
      { id: '1000', addproducto: { id: '1000', name: 'a', price: 2 } },
      { id: '1000', updateproducto: { id: '1000', name: 'b', price: 2 } },
      { id: '1', deleteproducto: { id: '1', name: 'kept', price: 1 } },
    ];
    expect(result.structuredContent.transaction).toEqual(expected);
    expect(JSON.parse(result.content[0].text)).toEqual({ transaction: expected });
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
    expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Producto:1000']);
  });
});

describe('operation keys', () => {
  const REMOTE = { mode: 'remote', endpoint: 'https://api.example.test/graphql' };
  const PRODUCTO_KEYS = ['addproducto', 'deleteproducto', 'updateproducto'];
  const VALID = 'Valid operations: addproducto, deleteproducto, updateproducto. The tool was not executed.';

  // The message of a call refused before execution with MCP_UNKNOWN_ARGUMENT.
  const refused = (result) => {
    expect(result.isError).toBe(true);
    const { errors } = JSON.parse(result.content[0].text);
    expect(errors).toHaveLength(1);
    expect(errors[0].extensions).toEqual({ code: 'MCP_UNKNOWN_ARGUMENT' });
    return errors[0].message;
  };

  // The schema an MCP server builds with fewer types than the GraphQL server it forwards to: its transaction
  // field covers Producto only, so its tool advertises the Producto keys only.
  const productoOnly = () => {
    const runtime = createRuntime(createOptimisticMemoryAdapter());
    const { Producto } = defineTypes();
    runtime.connect(null, Producto, 'producto', 'productos');
    return runtime.createSchema(null, [Producto], null, { transaction: { types: [Producto] } });
  };

  // Runs `body` with fetch stubbed by an endpoint that executes every request on the fixture's schema, whose
  // transaction field covers Producto and Pedido.
  const withEndpoint = async (fixture, body) => {
    const fetch = vi.fn(async (url, init) => {
      const { query, variables } = JSON.parse(init.body);
      const result = await graphql({
        schema: fixture.schema, source: query, variableValues: variables, contextValue: {},
      });
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      return await body(fetch);
    } finally {
      vi.unstubAllGlobals();
    }
  };

  test.each([
    {}, { excludeTypes: ['Pedido'] }, { exclude: ['addpedido', 'deletepedido'] }, { includeTypes: ['Producto'] },
  ])('remotely, an operation the tool does not advertise never reaches the endpoint, whatever the filters: %j', async (filters) => {
    const fixture = build();
    await withEndpoint(fixture, async (fetch) => {
      const { tools, callTool } = generateMCPTools(productoOnly(), { transactionTools: true, execution: REMOTE, ...filters });
      expect(Object.keys(byName(tools, 'transaction').inputSchema.$defs.TransactionOperation.properties)).toEqual(PRODUCTO_KEYS);
      expect(refused(await callTool('transaction', { operations: [{ addpedido: { numero: 'X' } }] })))
        .toBe(`Unknown operation "addpedido" at operations[0] for tool "transaction". ${VALID}`);
      expect(refused(await callTool('transaction', {
        operations: [{ addproducto: { name: 'a' } }, { deletepedido: { id: '1', version: 1 } }],
      }))).toBe(`Unknown operation "deletepedido" at operations[1] for tool "transaction". ${VALID}`);
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.adapterCalls()).toBe(0);
      expect(fixture.storedKeys()).toEqual(STORED);

      // An operation it advertises still runs on the endpoint.
      const result = await callTool('transaction', { operations: [{ addproducto: { name: 'a' } }] });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.transaction).toEqual([{ id: '1000', addproducto: { id: '1000', name: 'a', price: null } }]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Producto:1', 'Producto:1000']);
    });
  });

  // Each malformed `operations` value, and the first sentence of the message that refuses it.
  const oneOperation = (index) => `operations[${index}] for tool "transaction" must name exactly one operation.`;
  const malformed = [
    ['an item with two keys', [{ addproducto: { name: 'a' }, deleteproducto: { id: '1' } }], oneOperation(0)],
    ['an item with no key', [{ addproducto: { name: 'a' } }, {}], oneOperation(1)],
    ['an item whose only key is undefined', [{ addproducto: undefined }], oneOperation(0)],
    ['an item whose only keys are undefined', [{ addproducto: { name: 'a' } }, { addproducto: undefined, deleteproducto: undefined }],
      oneOperation(1)],
    ['an item that is not an object', [{ addproducto: { name: 'a' } }, 'addproducto'], oneOperation(1)],
    ['an item that is a list', [[{ addproducto: { name: 'a' } }]], oneOperation(0)],
    ['a single item that is not in a list', { addproducto: { name: 'a' } },
      'Argument "operations" for tool "transaction" must be a list of operations.'],
  ];

  test.each(malformed)('%s is refused before execution, locally', async (_label, operations, sentence) => {
    const fixture = build();
    const { callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
    expect(refused(await callTool('transaction', { operations })))
      .toBe(`${sentence} Valid operations: ${KEYS.join(', ')}. The tool was not executed.`);
    expect(fixture.adapterCalls()).toBe(0);
    expect(fixture.storedKeys()).toEqual(STORED);
  });

  test.each(malformed)('%s is refused before the request, remotely', async (_label, operations, sentence) => {
    const fixture = build();
    await withEndpoint(fixture, async (fetch) => {
      const { callTool } = generateMCPTools(productoOnly(), { transactionTools: true, execution: REMOTE });
      expect(refused(await callTool('transaction', { operations }))).toBe(`${sentence} ${VALID}`);
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.storedKeys()).toEqual(STORED);
    });
  });

  // An own key whose value is undefined is not sent, as for the tool's top-level arguments: the item names
  // its one other key.
  const ADDED = { id: '1000', addproducto: { id: '1000', name: 'a', price: null } };

  test('locally, an item whose other keys are undefined runs its one operation', async () => {
    const fixture = build();
    const { callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
    const result = await callTool('transaction', { operations: [{ addproducto: { name: 'a' }, deleteproducto: undefined }] });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.transaction).toEqual([ADDED]);
    expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Producto:1', 'Producto:1000']);
  });

  test('remotely, an item whose other keys are undefined runs its one operation, and those keys are not sent', async () => {
    const fixture = build();
    await withEndpoint(fixture, async (fetch) => {
      const { callTool } = generateMCPTools(productoOnly(), { transactionTools: true, execution: REMOTE });
      const result = await callTool('transaction', {
        operations: [{ addproducto: { name: 'a' }, deleteproducto: undefined }, { addproducto: { name: 'b' }, addpedido: undefined }],
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.transaction).toEqual([
        ADDED, { id: '1001', addproducto: { id: '1001', name: 'b', price: null } },
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
      const { variables } = JSON.parse(fetch.mock.calls[0][1].body);
      expect(JSON.stringify(variables)).not.toMatch(/deleteproducto|addpedido/);
      expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Producto:1', 'Producto:1000', 'Producto:1001']);
    });
  });

  test('locally, every operation of the tool runs', async () => {
    const fixture = build();
    const { callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
    const result = await callTool('transaction', {
      operations: [{ addpedido: { numero: 'Q' } }, { close_pedido: { id: '1', version: 1 } }, { deleteproducto: { id: '1' } }],
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.transaction.map((item) => Object.keys(item))).toEqual([
      ['id', 'addpedido'], ['id', 'close_pedido'], ['id', 'deleteproducto'],
    ]);
    expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Pedido:1000']);
  });
});

describe('result items', () => {
  // Ten adds of a Producto, whose records take the ids 1000 to 1009, and their results.
  const tenAdds = Array.from({ length: 10 }, (_, index) => ({ addproducto: { name: `p${index}` } }));
  const tenAdded = tenAdds.map((_, index) => ({
    id: String(1000 + index), addproducto: { id: String(1000 + index), name: `p${index}`, price: null },
  }));
  const validOutput = (tool, structured) => new AjvJsonSchemaValidator().getValidator(tool.outputSchema)(structured).valid;

  test('keep only their id and their own operation key, so their size does not grow with the operation keys', async () => {
    const sizes = [];
    for (const extras of [0, 30]) {
      const fixture = build({ extras });
      const { tools, callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
      const tool = byName(tools, 'transaction');
      expect(Object.keys(tool.outputSchema.properties.transaction.items.properties)).toHaveLength(1 + KEYS.length + 3 * extras);
      const result = await callTool('transaction', { operations: tenAdds });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.transaction).toEqual(tenAdded);
      expect(validOutput(tool, result.structuredContent)).toBe(true);
      sizes.push(Buffer.byteLength(result.content[0].text, 'utf8'));
    }
    expect(sizes[1]).toBe(sizes[0]);
    // maxResultBytes measures the reduced items: a cap of exactly their size returns them whole.
    const { callTool } = generateMCPTools(build({ extras: 30 }).schema, {
      transactionTools: true, limits: { maxResultBytes: sizes[0] },
    });
    const capped = await callTool('transaction', { operations: tenAdds });
    expect(capped._meta).toBeUndefined();
    expect(capped.structuredContent.transaction).toEqual(tenAdded);
  });

  test('a delete of a missing record keeps its null id and its own key', async () => {
    const fixture = build();
    const { tools, callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
    const result = await callTool('transaction', { operations: [{ deleteproducto: { id: '7' } }, { addproducto: { name: 'a' } }] });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.transaction).toEqual([
      { id: null, deleteproducto: null },
      { id: '1000', addproducto: { id: '1000', name: 'a', price: null } },
    ]);
    expect(validOutput(byName(tools, 'transaction'), result.structuredContent)).toBe(true);
  });

  test('the partial data of a result with errors is reduced the same way', async () => {
    const fixture = build();
    // A stored Producto without its required name: its delete commits, but its record cannot be returned.
    fixture.adapter.seed('Producto', { _id: '2', price: 3 });
    const { callTool } = generateMCPTools(fixture.schema, { transactionTools: true });
    const result = await callTool('transaction', { operations: [{ addproducto: { name: 'a' } }, { deleteproducto: { id: '2' } }] });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errors).toEqual([expect.objectContaining({ path: ['transaction', 1, 'deleteproducto', 'name'] })]);
    expect(payload.data).toEqual({
      transaction: [{ id: '1000', addproducto: { id: '1000', name: 'a', price: null } }, { id: '2', deleteproducto: null }],
    });
    expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Producto:1', 'Producto:1000']);
  });

  test('remotely, items are reduced the same way, and an item whose key is ambiguous is kept whole', async () => {
    const fixture = build();
    // The endpoint runs the request on the fixture's schema, or answers `reply` when it is set.
    let reply;
    const fetch = vi.fn(async (url, init) => {
      const { query, variables } = JSON.parse(init.body);
      const body = reply ?? await graphql({
        schema: fixture.schema, source: query, variableValues: variables, contextValue: {},
      });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const { callTool } = generateMCPTools(fixture.schema, {
        transactionTools: true, execution: { mode: 'remote', endpoint: 'https://api.example.test/graphql' },
      });
      const result = await callTool('transaction', { operations: [{ addproducto: { name: 'a' } }, { deleteproducto: { id: '7' } }] });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.transaction).toEqual([
        { id: '1000', addproducto: { id: '1000', name: 'a', price: null } },
        { id: null, deleteproducto: null },
      ]);
      // Two keys set: the item has no single key of its own. With no key set, the key the operation sent
      // names it, and an item at a position where no operation was sent, so no known key either, is kept
      // whole (an operation that names no known key is refused before the request, see operation keys).
      const twoKeys = { id: '1', addproducto: { id: '1' }, deleteproducto: { id: '1' } };
      const noKey = { id: null, addproducto: null, deleteproducto: null };
      reply = { data: { transaction: [twoKeys, noKey, { ...noKey }] } };
      const kept = await callTool('transaction', {
        operations: [{ addproducto: { name: 'x' } }, { deleteproducto: { id: '9' } }],
      });
      expect(kept.structuredContent.transaction).toEqual([twoKeys, { id: null, deleteproducto: null }, noKey]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('an explicit selection override is returned as selected, aliases included', async () => {
    const fixture = build();
    const { tools, callTool } = generateMCPTools(fixture.schema, {
      transactionTools: true,
      toolOverrides: { transaction: { selection: 'id created: addproducto { id name } deleteproducto { id }' } },
    });
    expect(byName(tools, 'transaction').outputSchema).toBeUndefined();
    const result = await callTool('transaction', { operations: [{ addproducto: { name: 'a' } }, { deleteproducto: { id: '1' } }] });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.transaction).toEqual([
      { id: '1000', created: { id: '1000', name: 'a' }, deleteproducto: null },
      { id: '1', created: null, deleteproducto: { id: '1' } },
    ]);
  });
});

describe('output', () => {
  test('each operation is selected with the rules of its own tool, and the result list takes no level of selectionDepth', () => {
    const { schema } = build();
    const { tools, getOperation } = generateMCPTools(schema, {
      transactionTools: true,
      selectionDepth: 2,
      toolOverrides: { addpedido: { selectionDepth: 0 }, updatepedido: { nestedCollections: 'none' } },
    });
    const selections = KEYS.map((key) => `${key}${selectionOf(getOperation(key))}`);
    expect(getOperation('transaction').split('\n')[1]).toBe(`  transaction(operations: $operations) { id ${selections.join(' ')} }`);
    // Depth 2 reaches the notas of the items of a pedido; the override of addpedido and updatepedido apply.
    expect(selectionOf(getOperation('deletepedido'))).toContain(' notas { ');
    expect(selectionOf(getOperation('addpedido'))).toBe(' { id numero state version }');
    expect(selectionOf(getOperation('updatepedido'))).not.toContain(' items ');

    const output = byName(tools, 'transaction').outputSchema.properties.transaction;
    expect(output.type).toEqual(['array', 'null']);
    expect(output.items.properties.id).toEqual({ type: ['string', 'null'] });
    expect(Object.keys(output.items.properties)).toEqual(['id', ...KEYS]);
    for (const key of KEYS) {
      expect(output.items.properties[key], key).toEqual(byName(tools, key).outputSchema.properties[key]);
    }
  });

  test('inside the result list, an operation selects only the virtual fields with mcp: select, unlike its own tool', async () => {
    const virtuals = { label: vi.fn(() => 'L'), badge: vi.fn(() => 'B') };
    const fixture = build({ virtuals });
    const { tools, callTool, getOperation } = generateMCPTools(fixture.schema, { transactionTools: true });
    // The add tool returns one record, so it selects every virtual field.
    expect(selectionOf(getOperation('addproducto'))).toBe(' { id name price label badge }');
    expect(byName(tools, 'addproducto').outputSchema.properties.addproducto.properties).toHaveProperty('label');
    const call = getOperation('transaction').split('\n')[1];
    expect(call).toContain(' addproducto { id name price badge } ');
    expect(call).not.toContain('label');
    const tool = byName(tools, 'transaction');
    const added = tool.outputSchema.properties.transaction.items.properties.addproducto;
    expect(Object.keys(added.properties)).toEqual(['id', 'name', 'price', 'badge']);

    const result = await callTool('transaction', { operations: [{ addproducto: { name: 'a' } }, { addproducto: { name: 'b' } }] });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.transaction).toEqual([
      { id: '1000', addproducto: { id: '1000', name: 'a', price: null, badge: 'B' } },
      { id: '1001', addproducto: { id: '1001', name: 'b', price: null, badge: 'B' } },
    ]);
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema)(result.structuredContent).valid).toBe(true);
    expect(virtuals.label).not.toHaveBeenCalled();
    expect(virtuals.badge).toHaveBeenCalledTimes(2);
  });

  test('an oversized result keeps each result id and its operation id and version, null ids included, with an atomic notice', async () => {
    const fixture = build();
    const { tools, callTool } = generateMCPTools(fixture.schema, { transactionTools: true, limits: { maxResultBytes: 400 } });
    const tool = byName(tools, 'transaction');
    expect(tool.outputSchema.properties.truncated.description).toContain('one database transaction');
    const operations = [{ addpedido: { numero: 'N' } }, { deleteproducto: { id: '7' } }, { updateproducto: { id: '1', name: 'renamed' } }];
    const result = await callTool('transaction', { operations });
    expect(result.isError).toBe(false);
    expect(result._meta).toEqual({ truncated: true });
    expect(result.structuredContent.transaction).toEqual([
      { id: '1000', addpedido: { id: '1000', version: 1 } },
      { id: null, deleteproducto: null },
      { id: '1', updateproducto: { id: '1' } },
    ]);
    const { truncated } = result.structuredContent;
    expect(truncated).toMatchObject({ applied: true, maxResultBytes: 400 });
    expect(truncated.message).toBe('transaction was applied: its operations were committed together in one database '
      + `transaction. Its full result (${truncated.resultBytes} bytes) exceeds maxResultBytes (400) and was omitted; `
      + 'only the ids and versions are returned. Calling transaction again could repeat the changes; do not call '
      + 'transaction again for these changes; use a query tool to read the records if you need their other fields.');
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema)(result.structuredContent).valid).toBe(true);
    expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Pedido:1000', 'Producto:1']);
    // The size it reports is that of the reduced result, as the same call returns it without the cap.
    const full = await generateMCPTools(build().schema, { transactionTools: true }).callTool('transaction', { operations });
    expect(JSON.parse(full.content[0].text).transaction.map((item) => Object.keys(item)))
      .toEqual([['id', 'addpedido'], ['id', 'deleteproducto'], ['id', 'updateproducto']]);
    expect(truncated.resultBytes).toBe(Buffer.byteLength(full.content[0].text, 'utf8'));
  });

  test('an oversized error says the operations were applied all together or not at all, never in part', async () => {
    const fixture = build();
    const { callTool } = generateMCPTools(fixture.schema, { transactionTools: true, limits: { maxResultBytes: 20 } });
    const result = await callTool('transaction', {
      operations: [{ addproducto: { name: 'a' } }, { updatepedido: { id: '1', version: 5, numero: 'x' } }],
    });
    expect(result.isError).toBe(true);
    const [error] = JSON.parse(result.content[0].text).errors;
    expect(error.extensions).toEqual({ code: 'MCP_RESULT_TOO_LARGE', applied: 'unknown', firstError: expect.any(String) });
    expect(error.message).toMatch(/^transaction returned errors; the error result \(\d+ bytes\) exceeds maxResultBytes \(20\) and was omitted \(extensions\.firstError holds the start of the first error\)\. /);
    expect(error.message).toContain('Its operations run in one database transaction, so they were applied all together or not at all, never in part: '
      + 'none was applied, unless the error came from the commit or is TRANSACTION_RETRY_EXCEEDED, which leaves it uncertain whether all were. '
      + 'If they were applied, calling transaction again could repeat the changes. Check the current state with a query tool before calling it again.');
    expect(fixture.storedKeys()).toEqual(STORED);
  });

  test('remotely, a failed request to the endpoint also leaves it uncertain, and the call is not retried', async () => {
    const { schema } = build();
    const fetch = vi.fn(async () => {
      throw new TypeError('socket hang up');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const { callTool } = generateMCPTools(schema, {
        transactionTools: true,
        limits: { maxResultBytes: 20 },
        execution: { mode: 'remote', endpoint: 'https://api.example.test/graphql', retry: { attempts: 3, backoffMs: 0 } },
      });
      const result = await callTool('transaction', { operations: [{ addproducto: { name: 'a' } }] });
      expect(result.isError).toBe(true);
      const [error] = JSON.parse(result.content[0].text).errors;
      expect(error.extensions).toEqual({
        code: 'MCP_RESULT_TOO_LARGE', applied: 'unknown', firstError: 'GraphQL endpoint request failed: socket hang up',
      });
      expect(error.message).toContain('none was applied, unless the error came from the commit or from the request to the '
        + 'GraphQL endpoint, or is TRANSACTION_RETRY_EXCEEDED, which leaves it uncertain whether all were.');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'simfinity-packages-'));
const run = (command, args, cwd) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
};
const pack = (path) => {
  const output = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], path));
  for (const required of ['types/index.d.ts', 'README.md', 'LICENSE']) {
    assert(output[0].files.some((file) => file.path === required), `${output[0].name} is missing ${required}`);
  }
  assert(!output[0].files.some((file) => (
    file.path.includes('.superpowers') || file.path.startsWith('node_modules/')
  )));
  return join(temporary, output[0].filename);
};

const adapterSource = `const adapter = {
  bind() {},
  prepare() {},
  createModel(type) { return { name: type.name }; },
  castId(value) { return value; },
  async withTransaction(session, callback) { return callback(session || {}); },
  newRecord(model, data) { return { ...data, _id: '1' }; },
  async saveRecord(model, record) { return record; },
  toObject(record) { return record; },
  async getById() { return null; },
  prepareUpdate(set) { return set; },
  async update() { return null; },
  async delete() { return null; },
  async find() { return []; },
  async count() { return 0; },
  async aggregate() { return []; },
  async findChildren() { return []; },
};`;

const coreSource = `import assert from 'node:assert/strict';
  import {
    InternalServerError,
    QLOperator,
    QLSort,
    QLValue,
    SimfinityError,
    buildErrorFormatter,
    auth,
    createRuntime,
    createValidatedScalar,
    describeModels,
    plugins,
    scalars,
    validators,
  } from '@simtlix/simfinity-core';
  import {
    GraphQLID,
    GraphQLInt,
    GraphQLObjectType,
    GraphQLString,
    graphqlSync,
  } from 'graphql';
  ${adapterSource}
  const type = new GraphQLObjectType({
    name: 'CoreBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const runtime = createRuntime(adapter);
  runtime.connect(null, type, 'coreBook', 'coreBooks');
  const schema = runtime.createSchema();
  const introspection = graphqlSync({
    schema,
    source: '{ __type(name: "__Field") { fields { name } } }',
  });
  assert.equal(introspection.errors, undefined);
  assert(introspection.data.__type.fields.some((field) => field.name === 'extensions'));
  assert.equal(describeModels([]).entities.length, 0);
  assert.equal(createValidatedScalar('Count', '', GraphQLInt, () => {}).parseValue(3), 3);
  assert.equal(QLOperator.name, 'QLOperator');
  assert.equal(QLSort.name, 'QLSort');
  assert.equal(QLValue.name, 'QLValue');
  const known = new SimfinityError('known', 'KNOWN', 400);
  assert.equal(buildErrorFormatter()(known), known);
  const unknown = buildErrorFormatter()(new Error('unknown'));
  assert(unknown instanceof InternalServerError);
  assert.equal(unknown.getCause().message, 'unknown');
  assert.equal(typeof auth.createAuthPlugin, 'function');
  assert.equal(typeof validators.email, 'function');
  assert.equal(scalars.EmailScalar.name, 'Email_String');
  assert.equal(typeof plugins.envelopCountPlugin, 'function');`;

const sqlSource = `import assert from 'node:assert/strict';
  import { createRequire } from 'node:module';
  import { createSQL, planRelationalSchema } from '@simtlix/simfinity-sql';
  import { describeModels } from '@simtlix/simfinity-core';
  import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
  const require = createRequire(import.meta.url);
  for (const dependency of ['pg', 'mongoose', 'mongodb', '@simtlix/simfinity-postgres', '@simtlix/simfinity-mcp', '@modelcontextprotocol/sdk']) {
    assert.throws(() => require.resolve(dependency), { code: 'MODULE_NOT_FOUND' });
  }
  const book = new GraphQLObjectType({ name: 'SQLBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
  const plan = planRelationalSchema(describeModels([{ gqltype: book }]), { schema: 'recording' });
  assert.deepEqual(plan.requirements, ['transactions']);
  const calls = [];
  const plugin = {
    apiVersion: 1, name: 'recording', displayName: 'Recording', defaultSchema: 'recording', options: {}, capabilities: ['transactions'],
    naming: { validateIdentifier() {}, generatedName: (...parts) => parts.join('__') },
    describeSchema: (logical) => logical,
    compileSchema: () => [],
    async initialize() { return { mode: 'validate', created: [] }; },
    compileQuery(models, description, query) { return { text: query.mode, values: [] }; },
    compileRecord(description, operation) { return { text: operation.kind, values: [] }; },
    values: { createId: () => 'recording-id', castId: String, encodeScalar: (field, value) => value, decodeScalar: (field, value) => value, encodeEmbedded: JSON.stringify },
    driver: {
      assertConfiguration() {}, acquire: async () => ({}), begin() {}, commit() {}, rollback() {}, release() {},
      isRetryable: () => false, normalizeError: (error) => error,
      async query(configuration, statement) { calls.push(statement.text); return { rows: [] }; },
    },
  };
  const api = createSQL({ plugin });
  api.connect(null, book, 'sqlBook', 'sqlBooks');
  const schema = api.createSchema();
  await api.initializeDatabase();
  const result = await graphql({ schema, source: '{ sqlBooks { id title } }' });
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data.sqlBooks, []);
  assert.deepEqual(calls, ['find']);`;

const postgresSource = `import assert from 'node:assert/strict';
  import {
    InternalServerError,
    SimfinityError,
    auth,
    buildErrorFormatter,
    compileDatabaseSchema,
    configure,
    connect,
    createPostgres,
    createSchema,
    describeDatabase,
    initializeDatabase,
    postgresPlugin,
    plugins,
    scalars,
    validators,
  } from '@simtlix/simfinity-postgres';
  import { createRuntime } from '@simtlix/simfinity-core';
  import { createSQL } from '@simtlix/simfinity-sql';
  import {
    GraphQLID,
    GraphQLObjectType,
    GraphQLString,
    graphql,
    graphqlSync,
  } from 'graphql';
  const result = () => ({ rows: [], rowCount: 0 });
  const pool = {
    async query() { return result(); },
    async connect() {
      return { async query() { return result(); }, release() {} };
    },
  };
  const bookType = new GraphQLObjectType({
    name: 'PostgresBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const api = createPostgres({ pool, schema: 'app' });
  assert.equal(api.auth, auth);
  assert.equal(api.plugins, plugins);
  assert.equal(api.scalars, scalars);
  assert.equal(api.validators, validators);
  api.connect(null, bookType, 'postgresBook', 'postgresBooks');
  const schema = api.createSchema();
  const beforeReady = await graphql({ schema, source: '{ postgresBooks { id } }' });
  assert.equal(beforeReady.errors[0].extensions.code, 'DATABASE_NOT_INITIALIZED');
  const description = api.describeDatabase();
  const sql = createSQL({ plugin: postgresPlugin({ pool, schema: 'app' }) });
  sql.connect(null, bookType, 'sqlBook', 'sqlBooks');
  sql.createSchema();
  assert.deepEqual(sql.describeDatabase(), description);
  assert(compileDatabaseSchema(description).some((sql) => sql.startsWith('CREATE TABLE')));
  assert.equal(describeDatabase([{ gqltype: bookType }]).tables.length, 1);
  assert.equal(typeof initializeDatabase, 'function');

  const unprepared = createPostgres({ pool, schema: 'unprepared' });
  await assert.rejects(
    () => unprepared.initializeDatabase(),
    (error) => error.extensions.code === 'SCHEMA_NOT_CREATED',
  );

  const defaultType = new GraphQLObjectType({
    name: 'DefaultPostgresBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  configure({ pool, schema: 'default_app' });
  connect(null, defaultType, 'defaultPostgresBook', 'defaultPostgresBooks');
  const defaultSchema = createSchema();
  const defaultBeforeReady = await graphql({
    schema: defaultSchema,
    source: '{ defaultPostgresBooks { id } }',
  });
  assert.equal(defaultBeforeReady.errors[0].extensions.code, 'DATABASE_NOT_INITIALIZED');

  ${adapterSource}
  const coreType = new GraphQLObjectType({
    name: 'TogetherCoreBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const coreRuntime = createRuntime(adapter);
  coreRuntime.connect(null, coreType, 'togetherCoreBook', 'togetherCoreBooks');
  const coreSchema = coreRuntime.createSchema();
  for (const candidate of [schema, defaultSchema, coreSchema]) {
    const introspection = graphqlSync({
      schema: candidate,
      source: '{ __type(name: "__Field") { fields { name } } }',
    });
    assert.equal(introspection.errors, undefined);
    assert(introspection.data.__type.fields.some((field) => field.name === 'extensions'));
  }
  const formatted = buildErrorFormatter()(new Error('postgres'));
  assert(formatted instanceof InternalServerError);
  assert(formatted instanceof SimfinityError);`;

const mongoSource = `import assert from 'node:assert/strict';
  import * as legacyEntry from '@simtlix/simfinity-js/src/index.js';
  import legacyAuth from '@simtlix/simfinity-js/src/auth/index.js';
  import { isOwner as legacyIsOwner } from '@simtlix/simfinity-js/src/auth/rules.js';
  import LegacyError from '@simtlix/simfinity-js/src/errors/simfinity.error.js';
  import legacyMcp from '@simtlix/simfinity-js/src/mcp.js';
  import * as simfinity from '@simtlix/simfinity-js';
  import {
    SimfinityError,
    auth,
    plugins,
    scalars,
    validators,
  } from '@simtlix/simfinity-core';
  import { GraphQLID, GraphQLObjectType, GraphQLString, graphqlSync } from 'graphql';
  ${adapterSource}
  assert.equal(legacyEntry.connect, simfinity.connect);
  assert.equal(legacyAuth, auth);
  assert.equal(legacyIsOwner, auth.isOwner);
  assert.equal(LegacyError, SimfinityError);
  assert.equal(legacyMcp.generateMCPTools, simfinity.generateMCPTools);
  if (simfinity.SimfinityError !== SimfinityError) throw new Error('shared error export failed');
  if (typeof simfinity.connect !== 'function') throw new Error('Mongo exports failed');
  if (typeof simfinity.createMongoAdapter !== 'function') throw new Error('Mongo adapter export failed');
  assert.equal(simfinity.auth, auth);
  assert.equal(simfinity.plugins, plugins);
  assert.equal(simfinity.scalars, scalars);
  assert.equal(simfinity.validators, validators);
  assert.equal(typeof simfinity.generateMCPTools, 'function');
  assert.equal(simfinity.mcp.generateMCPTools, simfinity.generateMCPTools);
  const runtime = simfinity.createRuntime(adapter);
  const type = new GraphQLObjectType({
    name: 'RootRuntimeBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  runtime.connect(null, type, 'rootRuntimeBook', 'rootRuntimeBooks');
  const schema = runtime.createSchema();
  const introspection = graphqlSync({
    schema,
    source: '{ __type(name: "__Field") { fields { name } } }',
  });
  assert.equal(introspection.errors, undefined);
  assert(introspection.data.__type.fields.some((field) => field.name === 'extensions'));
  assert(simfinity.buildErrorFormatter()(new Error('root')) instanceof simfinity.InternalServerError);`;

const mcpSource = `import assert from 'node:assert/strict';
  import {
    createMCPServer,
    generateMCPTools,
  } from '@simtlix/simfinity-mcp';
  import {
    GraphQLObjectType,
    GraphQLSchema,
    GraphQLString,
  } from 'graphql';
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { greeting: { type: GraphQLString, resolve: () => 'hello' } },
    }),
  });
  const generated = generateMCPTools(schema);
  assert.deepEqual(generated.tools.map((tool) => tool.name), ['greeting']);
  const result = await generated.callTool('greeting');
  assert.equal(result.structuredContent.greeting, 'hello');
  assert.deepEqual(Object.keys(result.structuredContent), ['greeting']);
  await assert.rejects(
    () => createMCPServer(schema),
    (error) => error.getCode() === 'MCP_SDK_NOT_INSTALLED',
  );`;

const mcpSdkSource = `import assert from 'node:assert/strict';
  import { createMCPServer } from '@simtlix/simfinity-mcp';
  import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { greeting: { type: GraphQLString, resolve: () => 'hello' } },
    }),
  });
  const server = await createMCPServer(schema);
  assert.equal(typeof server.connect, 'function');
  await server.close();`;

const coreTypes = `import {
  InternalServerError,
  QLOperator,
  QLSort,
  QLValue,
  SimfinityError,
  auth,
  buildErrorFormatter,
  createRuntime,
  plugins,
  scalars,
  validators,
  type AuthRuleFunction,
  type DatabaseAdapter,
  type FieldValidations,
} from '@simtlix/simfinity-core';
import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
type Model = { name: string };
type Session = { active: boolean };
const adapter: DatabaseAdapter<Model, Session> = {
  createModel(type) { return { name: type.name }; },
  castId(value) { return value; },
  async withTransaction(session, callback) { return callback(session ?? { active: true }); },
  newRecord(model, data) { return data; },
  saveRecord(model, record) { return record; },
  toObject(record) { return record; },
  getById() { return null; },
  prepareUpdate(set) { return set; },
  update() { return null; },
  delete() { return null; },
  find() { return []; },
  count() { return 0; },
  aggregate() { return []; },
  findChildren() { return []; },
};
const runtime = createRuntime(adapter);
const type = new GraphQLObjectType({ name: 'TypedCoreBook', fields: { title: { type: GraphQLString } } });
runtime.connect(null, type, 'typedCoreBook', 'typedCoreBooks');
const model: Model | null | undefined = runtime.getModel(type);
const formatted: Error = buildErrorFormatter()(new Error('typed'));
const known: SimfinityError = new InternalServerError('known');
const operator: GraphQLEnumType = QLOperator;
const sort: GraphQLInputObjectType = QLSort;
const valueName: string = QLValue.name;
const rule: AuthRuleFunction = auth.requireAuth();
const validations: FieldValidations = validators.email();
const scalarName: string = scalars.EmailScalar.name;
const countPlugin = plugins.envelopCountPlugin();
void [model, formatted, known, operator, sort, valueName, rule, validations, scalarName, countPlugin];`;

const sqlTypes = `import {
  createSQL,
  planRelationalSchema,
  type SQLCapability,
  type SQLCompiledQuery,
  type SQLDatabaseDescription,
  type SQLFieldDescription,
  type SQLModelDescription,
  type SQLPlugin,
  type SQLRecordOperation,
  type SQLStatement,
} from '@simtlix/simfinity-sql';
import { describeModels } from '@simtlix/simfinity-core';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
type Configuration = { schema: string; token: string };
type Client = { active: boolean };
type Description = SQLDatabaseDescription & { dialect: 'recording' };
const book = new GraphQLObjectType({ name: 'TypedSQLBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
const plan = planRelationalSchema(describeModels([{ gqltype: book }]));
const capability: SQLCapability = plan.requirements[0];
const scalar: string = plan.tables[0].columns[0].scalar;
const logical = plan.tables[0];
// @ts-expect-error Physical column types do not belong to the relational plan.
logical.columns[0].type;
const plugin: SQLPlugin<Configuration, Client, Description> = {
  apiVersion: 1, name: 'recording', displayName: 'Recording', defaultSchema: 'recording',
  options: { schema: 'recording', token: 'test' }, capabilities: ['transactions'],
  naming: { validateIdentifier(value) { if (!value) throw new Error('empty'); }, generatedName: (...parts) => parts.join('__') },
  describeSchema(logicalPlan) {
    return { schema: logicalPlan.schema, dialect: 'recording', tables: logicalPlan.tables.map((table) => ({ ...table, columns: table.columns.map((column) => ({ name: column.name, presenceColumn: column.presenceColumn })) })) };
  },
  compileSchema(description) { return [description.dialect]; },
  async initialize(configuration, description, options) { return { mode: options?.mode ?? 'validate', created: [configuration.schema, description.dialect] }; },
  compileQuery(models, description, query, extra) {
    const metadata: SQLModelDescription = models;
    const field: SQLFieldDescription = metadata.entities[0].fields[0];
    const stateNames: string[] | undefined = field.stateNames?.map((state) => state.value + ':' + state.name);
    // @ts-expect-error State storage values have already been converted to strings.
    const numericState: number | undefined = field.stateNames?.[0].value;
    void numericState;
    const nestedStateNames: string[] | undefined = field.fields?.[0].stateNames?.map((state) => state.name);
    return { text: query.mode, values: [stateNames, nestedStateNames, description.dialect, extra?.id], aggregateFields: [field] };
  },
  compileRecord(description, operation): SQLStatement {
    const tableName: string = operation.table.name;
    switch (operation.kind) {
      case 'selectById': return { text: tableName, values: [operation.id, operation.lock] };
      case 'selectOwned': return { text: tableName, values: [operation.ids, operation.ordered] };
      case 'insert': return { text: tableName, values: Object.values(operation.data) };
      case 'update': return { text: tableName, values: [operation.id, ...Object.values(operation.data)] };
      case 'deleteById': return { text: tableName, values: [operation.id] };
      case 'deleteOwned': return { text: tableName, values: [operation.ownerId] };
      default: { const exhaustive: never = operation; return exhaustive; }
    }
  },
  values: {
    createId: () => 'opaque-id', castId: String,
    encodeScalar(field, value) { return field.stateNames?.find((state) => state.name === value)?.value ?? value; },
    decodeScalar(field, value, gqlField) { return field.stateNames?.find((state) => state.value === value)?.name ?? (gqlField?.name ? value : field.scalar); },
    encodeEmbedded: JSON.stringify,
  },
  driver: {
    assertConfiguration(configuration) { if (!configuration?.token) throw new Error('token'); },
    async acquire(configuration) { return { active: Boolean(configuration.token) }; },
    begin(client) { client.active = true; }, commit(client) { client.active = false; }, rollback(client) { client.active = false; }, release() {},
    isRetryable(error) { return error instanceof Error && error.message === 'aborted'; }, normalizeError: (error) => error,
    async query(configuration, statement, client) { return { rows: [{ token: configuration.token, text: statement.text, active: client?.active }] }; },
  },
};
declare const compiled: SQLCompiledQuery;
const aggregateStateNames: string[] | undefined = compiled.aggregateFields?.[0].stateNames?.map((state) => state.name);
void aggregateStateNames;
const api = createSQL({ plugin });
const description: Description = api.describeDatabase();
api.configure({ schema: 'recording', token: 'later' });
// @ts-expect-error Runtime configuration preserves the plugin's required fields.
api.configure({ schema: 'missing-token' });
void api.withTransaction(null, async (session) => {
  const active: boolean = session.client.active;
  const result = await session.query('query', [active]);
  const value: unknown = result.rows[0].token;
  return value;
});
const model = api.getModel(book);
void model?.find({ title: { value: 'book' } });
// @ts-expect-error Record operations receive physical table metadata, not a name.
const badOperation: SQLRecordOperation = { kind: 'deleteById', table: 'book', id: 'id' };
// @ts-expect-error Only version 1 is currently supported.
const badPlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, apiVersion: 2 };
void [capability, scalar, description, badOperation, badPlugin];`;

const postgresTypes = `import { Pool, type PoolClient } from 'pg';
import { createSQL } from '@simtlix/simfinity-sql';
import {
  auth,
  configure,
  connect,
  createPostgres,
  createSchema,
  initializeDatabase,
  postgresPlugin,
  plugins,
  scalars,
  validators,
  type AuthRuleFunction,
  type DatabaseDescription,
  type InitializationResult,
  type PostgresModel,
  type PostgresRuntime,
  type PostgresSession,
  type DatabaseQueryable,
} from '@simtlix/simfinity-postgres';
import { GraphQLObjectType, GraphQLString } from 'graphql';
declare const pool: Pool;
const type = new GraphQLObjectType({ name: 'TypedPostgresBook', fields: { title: { type: GraphQLString } } });
const api: PostgresRuntime = createPostgres({ pool, schema: 'app' });
const sqlApi: PostgresRuntime = createSQL({ plugin: postgresPlugin({ pool, schema: 'app' }) });
const deferred = createSQL({ plugin: postgresPlugin() });
deferred.configure({ pool });
declare const nativeClient: PoolClient;
const queryable: DatabaseQueryable = nativeClient;
const session: PostgresSession = { client: nativeClient, query: nativeClient.query.bind(nativeClient), inTransaction: () => true };
void sqlApi.withTransaction(session, async (transaction) => {
  await transaction.client.query('SELECT $1', [1]);
  return transaction.inTransaction();
});
void sqlApi.getModel(type)?.find({ title: { operator: 'EQ', value: 'typed' }, sort: { terms: [{ field: 'title', order: 'ASC' }] } }, { session });
void api.getModel(type)?.findById('opaque-id', { session });
void queryable;
const rule: AuthRuleFunction = auth.requireAuth();
const email = validators.email();
const scalarName: string = scalars.EmailScalar.name;
const countPlugin = plugins.envelopCountPlugin();
api.connect(null, type, 'typedPostgresBook', 'typedPostgresBooks');
const schema = api.createSchema();
const model: PostgresModel | null | undefined = api.getModel(type);
const ready: Promise<InitializationResult> = api.initializeDatabase({ mode: 'validate' });
const description: DatabaseDescription = api.describeDatabase();
const lowLevel: Promise<InitializationResult> = initializeDatabase(pool, description, { mode: 'validate' });
configure({ pool });
connect(null, type, 'defaultTypedPostgresBook', 'defaultTypedPostgresBooks');
const defaultSchema = createSchema();
const defaultReady: Promise<InitializationResult> = initializeDatabase({ mode: 'validate' });
void [schema, model, ready, lowLevel, defaultSchema, defaultReady, rule, email, scalarName, countPlugin];`;

const mongoTypes = `import {
  InternalServerError,
  buildErrorFormatter,
  createMongoAdapter,
  createRuntime,
  generateMCPTools,
  getInputType,
  getRegistrations,
  auth,
  plugins,
  scalars,
  validators,
  type AuthRuleFunction,
  type GeneratedMCPTools,
} from '@simtlix/simfinity-js';
import { GraphQLObjectType, GraphQLString } from 'graphql';
const runtime = createRuntime(createMongoAdapter());
const protectedAdapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
const protection: 'off' | 'transactional' = protectedAdapter.referentialIntegrity;
const ready: Promise<void> = protectedAdapter.initialize();
// @ts-expect-error startup mode is readonly
protectedAdapter.referentialIntegrity = 'off';
// @ts-expect-error misspelled mode must not compile
createMongoAdapter({ referentialIntegrity: 'strict' });
const type = new GraphQLObjectType({ name: 'TypedMongoBook', fields: { title: { type: GraphQLString } } });
runtime.connect(null, type, 'typedMongoBook', 'typedMongoBooks');
const registrations = getRegistrations();
const inputType = getInputType(type);
const formatted: Error = buildErrorFormatter()(new Error('typed'));
const internal: InternalServerError = new InternalServerError('typed');
const rule: AuthRuleFunction = auth.requireAuth();
const email = validators.email();
const scalarName: string = scalars.EmailScalar.name;
const countPlugin = plugins.envelopCountPlugin();
const generated: GeneratedMCPTools = generateMCPTools(runtime.createSchema());
void [registrations, inputType, formatted, internal, rule, email, scalarName, countPlugin, generated, protection, ready];`;

const mcpTypes = `import mcp, {
  createMCPServer,
  generateMCPTools,
  type GeneratedMCPTools,
  type MCPServer,
} from '@simtlix/simfinity-mcp';
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: { greeting: { type: GraphQLString } },
  }),
});
const generated: GeneratedMCPTools = generateMCPTools(schema);
const server: Promise<MCPServer> = createMCPServer(schema);
const sameGenerator: typeof generateMCPTools = mcp.generateMCPTools;
void [generated, server, sameGenerator];`;

const cases = [
  {
    name: 'core',
    archives: ({ core }) => [core],
    source: coreSource,
    types: coreTypes,
    forbiddenPackages: ['pg', 'mongoose', 'mongodb', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'sql',
    archives: ({ core, sql }) => [core, sql],
    source: sqlSource,
    types: sqlTypes,
    forbiddenPackages: ['pg', 'mongoose', 'mongodb', '@simtlix/simfinity-postgres', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'postgres',
    archives: ({ core, sql, postgres }) => [core, sql, postgres],
    source: postgresSource,
    types: postgresTypes,
    typeDependencies: ['@types/pg@8'],
    forbiddenPackages: ['mongoose', 'mongodb', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'mcp',
    archives: ({ core, mcp }) => [core, mcp],
    source: mcpSource,
    types: mcpTypes,
    forbiddenPackages: ['mongoose', 'mongodb', '@modelcontextprotocol/sdk'],
  },
  {
    name: 'mcp-sdk',
    archives: ({ core, mcp }) => [core, mcp],
    source: mcpSdkSource,
    types: mcpTypes,
    dependencies: ['@modelcontextprotocol/sdk@1'],
    forbiddenPackages: ['mongoose', 'mongodb'],
  },
  {
    name: 'mongo',
    archives: ({ core, mcp, mongo }) => [core, mcp, mongo],
    source: mongoSource,
    types: mongoTypes,
  },
];

try {
  const core = pack(resolve(root, 'packages/core'));
  const sql = pack(resolve(root, 'packages/sql'));
  const mcp = pack(resolve(root, 'packages/mcp'));
  const postgres = pack(resolve(root, 'packages/postgres'));
  const mongo = pack(resolve(root, 'packages/mongodb'));
  for (const testCase of cases) {
    const cwd = join(temporary, testCase.name);
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: `check-${testCase.name}`,
      private: true,
      type: 'module',
    }));
    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...testCase.archives({ core, sql, mcp, postgres, mongo }),
      'graphql@16',
      'typescript@5',
      ...(testCase.dependencies || []),
      ...(testCase.typeDependencies || []),
    ], cwd);
    if (testCase.forbiddenPackages) {
      const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
      for (const packageName of testCase.forbiddenPackages) {
        assert(!Object.keys(lock.packages).some((path) => (
          path.endsWith(`node_modules/${packageName}`)
        )), `${testCase.name} pulled forbidden dependency ${packageName}`);
      }
    }
    run(process.execPath, ['--input-type=module', '--eval', testCase.source], cwd);
    writeFileSync(join(cwd, 'check.ts'), testCase.types);
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['check.ts'],
    }));
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], cwd);
    console.log(`${testCase.name}: packed runtime and TypeScript consumption verified`);
  }
} catch (error) {
  if (error.stderr) console.error(error.stderr.toString());
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

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
  assert(output[0].files.some((file) => file.path === 'types/index.d.ts'));
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
    plugins,
    scalars,
    validators,
  } from '@simtlix/simfinity-postgres';
  import { createRuntime } from '@simtlix/simfinity-core';
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

const postgresTypes = `import { Pool } from 'pg';
import {
  auth,
  configure,
  connect,
  createPostgres,
  createSchema,
  initializeDatabase,
  plugins,
  scalars,
  validators,
  type AuthRuleFunction,
  type DatabaseDescription,
  type InitializationResult,
  type PostgresModel,
  type PostgresRuntime,
} from '@simtlix/simfinity-postgres';
import { GraphQLObjectType, GraphQLString } from 'graphql';
declare const pool: Pool;
const type = new GraphQLObjectType({ name: 'TypedPostgresBook', fields: { title: { type: GraphQLString } } });
const api: PostgresRuntime = createPostgres({ pool, schema: 'app' });
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
void [registrations, inputType, formatted, internal, rule, email, scalarName, countPlugin, generated];`;

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
    archives: (core) => [core],
    source: coreSource,
    types: coreTypes,
    forbiddenPackages: ['mongoose', 'mongodb', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'postgres',
    archives: (core, mcp, postgres) => [core, postgres],
    source: postgresSource,
    types: postgresTypes,
    typeDependencies: ['@types/pg@8'],
    forbiddenPackages: ['mongoose', 'mongodb', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'mcp',
    archives: (core, mcp) => [core, mcp],
    source: mcpSource,
    types: mcpTypes,
    forbiddenPackages: ['mongoose', 'mongodb', '@modelcontextprotocol/sdk'],
  },
  {
    name: 'mcp-sdk',
    archives: (core, mcp) => [core, mcp],
    source: mcpSdkSource,
    types: mcpTypes,
    dependencies: ['@modelcontextprotocol/sdk@1'],
    forbiddenPackages: ['mongoose', 'mongodb'],
  },
  {
    name: 'mongo',
    archives: (core, mcp, postgres, mongo) => [core, mcp, mongo],
    source: mongoSource,
    types: mongoTypes,
  },
];

try {
  const core = pack(resolve(root, 'packages/core'));
  const mcp = pack(resolve(root, 'packages/mcp'));
  const postgres = pack(resolve(root, 'packages/postgres'));
  const mongo = pack(root);
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
      ...testCase.archives(core, mcp, postgres, mongo),
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

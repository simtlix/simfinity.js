import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildASTSchema, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString, parse, printSchema,
} from 'graphql';
import * as core from '../packages/core/src/index.js';
import { generateMCPTools, createMCPServer } from '../packages/mcp/src/index.js';

const DESCRIPTION = 'Revision of a record with optimistic concurrency. Send it back unchanged in updates and deletes; Simfinity advances it.';
const VERSION_SCHEMA = { type: 'integer', minimum: 1, maximum: 9007199254740991 };
// The SDL fallback fixture also runs on the pre-feature baseline: no missing export can prevent
// the individual MCP assertions from showing which contracts are missing.
const versionScalar = () => core.RecordVersion || new GraphQLScalarType({
  name: 'RecordVersion', description: DESCRIPTION, serialize: (value) => value,
});
const byName = (tools, name) => tools.find((tool) => tool.name === name);
// Simfinity's process-global introspection metadata types cannot be cloned in the same process.
// Rebuild this fixture's application SDL only; GraphQL attaches introspection itself.
const rebuild = (schema) => {
  const document = parse(printSchema(schema));
  return buildASTSchema({
    ...document,
    definitions: document.definitions.filter(({ name }) => name.value.startsWith('McpVersion')
      || ['Query', 'Mutation', 'RecordVersion'].includes(name.value)),
  });
};
const makeSchema = (version = versionScalar()) => {
  const Row = new GraphQLObjectType({ name: 'McpVersionRow', fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    version: { type: new GraphQLNonNull(version) },
    note: { type: GraphQLString },
  } });
  const Added = new GraphQLInputObjectType({ name: 'McpVersionAdded', fields: { note: { type: GraphQLString } } });
  const Ref = new GraphQLInputObjectType({ name: 'McpVersionRef', fields: {
    id: { type: new GraphQLNonNull(GraphQLID) }, version: { type: new GraphQLNonNull(version) },
  } });
  const Collection = new GraphQLInputObjectType({ name: 'McpVersionCollection', fields: {
    added: { type: new GraphQLList(Added) }, deleted: { type: new GraphQLList(Ref) },
  } });
  const Input = new GraphQLInputObjectType({ name: 'McpVersionInput', fields: {
    id: { type: new GraphQLNonNull(GraphQLID) }, version: { type: new GraphQLNonNull(version) },
    children: { type: Collection },
  } });
  const PlainInput = new GraphQLInputObjectType({ name: 'McpVersionPlainInput', fields: {
    id: { type: GraphQLID }, children: { type: Collection },
  } });
  const row = { id: 'r1', version: 8, note: 'x'.repeat(4000) };
  const update = { type: Row, args: { input: { type: new GraphQLNonNull(Input) } }, resolve: () => row };
  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: { row: { type: Row, resolve: () => row } } }),
    mutation: new GraphQLObjectType({ name: 'Mutation', fields: {
      updateRow: { ...update, description: 'update', extensions: { simfinityMutation: { operation: 'update' } } },
      deleteRow: { type: Row, description: 'delete', args: Ref.getFields(), resolve: () => row,
        extensions: { simfinityMutation: { operation: 'delete' } } },
      closeRow: { ...update, description: 'Close this row after review.',
        extensions: { simfinityMutation: { operation: 'state_changed', action: 'close', from: 'OPEN', to: 'CLOSED' } } },
      revise: { ...update, description: 'Apply the reviewed revision.' },
      reviseMany: { ...update, type: new GraphQLList(Row), resolve: () => [row, { ...row, id: 'r2' }] },
      updateParent: { ...update, description: 'update', args: { input: { type: PlainInput } },
        extensions: { simfinityMutation: { operation: 'update' } } },
    } }),
  });
};
const validatorFor = async (schema) => {
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv');
  return new AjvJsonSchemaValidator().getValidator(schema);
};

describe('MCP optimistic concurrency contracts', () => {
  it('maps the core scalar instance in input and output schemas', () => {
    expect(core.RecordVersion).toBeInstanceOf(GraphQLScalarType);
    const { tools } = generateMCPTools(makeSchema(core.RecordVersion));
    const tool = byName(tools, 'deleteRow');
    expect(tool.inputSchema.properties.version).toMatchObject(VERSION_SCHEMA);
    expect(tool.outputSchema.properties.deleteRow.properties.version).toMatchObject(VERSION_SCHEMA);
  });

  it.each(['original', 'rebuilt'])('requires numeric bounded versions for update, delete, transition and nested deletes (%s)', async (kind) => {
    const original = makeSchema();
    const schema = kind === 'rebuilt' ? rebuild(original) : original;
    const { tools } = generateMCPTools(schema);
    for (const name of ['updateRow', 'deleteRow', 'closeRow']) {
      const tool = byName(tools, name);
      const validate = await validatorFor(tool.inputSchema);
      const args = (version) => (name === 'deleteRow' ? { id: 'r1', version } : { input: { id: 'r1', version } });
      for (const version of [1, 7, 9007199254740991]) expect(validate(args(version)).valid, `${name}: ${version}`).toBe(true);
      for (const version of [undefined, null, '7', 0, -1, 1.5, 9007199254740992]) {
        expect(validate(args(version)).valid, `${name}: ${String(version)}`).toBe(false);
      }
      expect(tool.outputSchema.properties[name].properties.version).toMatchObject(VERSION_SCHEMA);
    }
    const validate = await validatorFor(byName(tools, 'updateRow').inputSchema);
    for (const version of [undefined, null, '7', 0, 9007199254740992]) {
      expect(validate({ input: { id: 'r1', version: 7, children: { deleted: [{ id: 'c1', version }] } } }).valid).toBe(false);
    }
    expect(validate({ input: { id: 'r1', version: 7, children: { deleted: [{ id: 'c1', version: 2 }] } } }).valid).toBe(true);
  });

  it.each(['original', 'rebuilt'])('appends recovery guidance to CRUD, custom and state descriptions (%s)', (kind) => {
    const original = makeSchema();
    const schema = kind === 'rebuilt' ? rebuild(original) : original;
    const { tools } = generateMCPTools(schema, { toolOverrides: { revise: { description: 'Application guidance.' } } });
    for (const name of ['updateRow', 'deleteRow', 'closeRow', 'revise']) {
      const { description } = byName(tools, name);
      expect(description).toContain('version');
      expect(description).toContain('VERSION_CONFLICT');
      expect(description).toContain('TRANSACTION_RETRY_EXCEEDED');
      expect(description).toMatch(/re-read and retry/i);
    }
    expect(byName(tools, 'closeRow').description).toContain('Close this row after review.');
    expect(byName(tools, 'revise').description).toContain('Application guidance.');
    expect(byName(tools, 'updateParent').description).not.toContain('VERSION_CONFLICT');
  });

  it('makes only protected updates idempotent when added items are accepted', () => {
    const { tools } = generateMCPTools(makeSchema());
    expect(byName(tools, 'updateRow').annotations.idempotentHint).toBe(true);
    expect(byName(tools, 'updateParent').annotations.idempotentHint).toBe(false);
    expect(byName(tools, 'deleteRow').annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    for (const name of ['closeRow', 'revise']) {
      expect(byName(tools, name).annotations).toMatchObject({ readOnlyHint: false });
      expect(byName(tools, name).annotations).not.toHaveProperty('idempotentHint');
    }
  });

  it('pin: does not recognize an application scalar by its RecordVersion name alone', async () => {
    const foreign = new GraphQLScalarType({ name: 'RecordVersion', description: `${DESCRIPTION} Application value.`, serialize: (value) => value });
    const { tools, callTool } = generateMCPTools(makeSchema(foreign), { limits: { maxResultBytes: 512 } });
    const tool = byName(tools, 'updateRow');
    expect(tool.annotations.idempotentHint).toBe(false);
    expect(tool.description).not.toContain('VERSION_CONFLICT');
    expect(tool.inputSchema.properties.input).not.toHaveProperty('minimum');
    expect((await validatorFor(byName(tools, 'deleteRow').inputSchema))({ id: 'r1', version: '7' }).valid).toBe(true);
    expect((await callTool('updateRow', { input: { id: 'r1', version: 7 } })).structuredContent.updateRow).toEqual({ id: 'r1' });
  });

  it.each(['updateRow', 'reviseMany'])('retains ids and versions in oversized %s results and describes them accurately', async (name) => {
    const { tools, callTool } = generateMCPTools(makeSchema(), { limits: { maxResultBytes: 512 } });
    const result = await callTool(name, { input: { id: 'r1', version: 7 } });
    expect(result.isError).toBe(false);
    expect(result._meta).toEqual({ truncated: true });
    expect(result.structuredContent[name]).toEqual(name === 'reviseMany'
      ? [{ id: 'r1', version: 8 }, { id: 'r2', version: 8 }] : { id: 'r1', version: 8 });
    expect(result.structuredContent.truncated.message).toMatch(/id.*version/i);
    expect(byName(tools, name).outputSchema.properties.truncated.description).toMatch(/id.*version/i);
    expect((await validatorFor(byName(tools, name).outputSchema))(result.structuredContent).valid).toBe(true);
  });

  it('reports when the id and version together cannot fit the result cap', async () => {
    // The id alone fits; the protected result must not discard the version to keep just the id.
    const { callTool } = generateMCPTools(makeSchema(), { limits: { maxResultBytes: 20 } });
    const result = await callTool('updateRow', { input: { id: 'r1', version: 7 } });
    expect(result.structuredContent).not.toHaveProperty('updateRow');
    expect(result.structuredContent.truncated.message).toMatch(/id.*version.*exceed.*omitted/i);
  });
});

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!mongoUri || !postgresUri)('MCP optimistic concurrency through the SDK on MongoDB and PostgreSQL', () => {
  const namespace = `mcpoc_${randomUUID().replaceAll('-', '')}`;
  let mongoose;
  let pool;
  const resources = [];
  const backends = [];
  beforeAll(async () => {
    mongoose = (await import('mongoose')).default;
    const { default: pg } = await import('pg');
    const { createMongoAdapter } = await import('../packages/mongodb/src/mongo/adapter.js');
    const { createSQLAdapter } = await import('../packages/sql/src/adapter.js');
    const { postgresPlugin } = await import('../packages/postgres/src/index.js');
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri, max: 2 });
    for (const [name, adapter] of [
      ['mongo', createMongoAdapter()],
      ['postgres', createSQLAdapter(postgresPlugin({ pool, schema: namespace }))],
    ]) {
      const api = core.createRuntime(adapter);
      if (name === 'mongo') api.preventCreatingCollection(true);
      const Row = new GraphQLObjectType({ name: 'McpOcRecord', extensions: { concurrency: { mode: 'optimistic' } }, fields: {
        id: { type: GraphQLID }, note: { type: GraphQLString },
      } });
      api.connect(null, Row, 'mcpocrecord', 'mcpocrecords');
      const schema = api.createSchema();
      if (name === 'mongo') {
        for (const { model } of api.getRegistrations()) if (model) { await model.createCollection(); await model.init(); }
      } else await adapter.initialize();
      backends.push({ name, schema });
    }
  }, 60000);
  afterAll(async () => {
    for (const close of resources) await close();
    if (mongoose?.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
    mongoose?.deleteModel(/^McpOc/);
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it.each(['mongo', 'postgres'])('reads, updates, recovers from a stale version and deletes using %s', async (backendName) => {
    const { schema } = backends.find(({ name }) => name === backendName);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = await createMCPServer(schema, { context: {}, limits: { maxResultBytes: 512 } });
    const client = new Client({ name: 'mcp-oc-client', version: '1' });
    resources.push(async () => { await client.close(); await server.close(); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(byName(tools, 'deletemcpocrecord').inputSchema.properties.version).toMatchObject(VERSION_SCHEMA);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const created = await call('addmcpocrecord', { input: { note: 'start' } });
    expect(created.isError).toBe(false);
    const { id } = created.structuredContent.addmcpocrecord;
    expect(created.structuredContent.addmcpocrecord.version).toBe(1);
    const read = await call('mcpocrecord', { id });
    expect(read.structuredContent.mcpocrecord).toEqual({ id, note: 'start', version: 1 });
    const updated = await call('updatemcpocrecord', { input: { id, version: 1, note: 'x'.repeat(4000) } });
    expect(updated.isError).toBe(false);
    expect(updated.structuredContent.updatemcpocrecord).toEqual({ id, version: 2 });
    expect(updated.structuredContent.truncated.message).toMatch(/id.*version/i);
    const stale = await call('updatemcpocrecord', { input: { id, version: 1, note: 'stale' } });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content[0].text).errors[0].extensions.code).toBe('VERSION_CONFLICT');
    const current = await generateMCPTools(schema, { context: {} }).callTool('mcpocrecord', { id });
    expect(current.structuredContent.mcpocrecord.version).toBe(2);
    const deleted = await call('deletemcpocrecord', { id, version: 2 });
    expect(deleted.isError).toBe(false);
    expect(deleted.structuredContent.deletemcpocrecord).toEqual({ id, version: 2 });
    expect((await call('mcpocrecord', { id })).structuredContent.mcpocrecord).toBeNull();
  });
});

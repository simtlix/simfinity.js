import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildASTSchema, GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLString, graphql, parse, printSchema } from 'graphql';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createRuntime, QLOperator } from '../packages/core/src/index.js';
import { buildClientDescriptor } from '../packages/descriptor/src/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';

const fixture = (valuePath = true) => {
  const calls = [];
  const adapter = {
    queryFeatures: { operators: QLOperator.getValues().map(({ name }) => name), referenceEmptiness: true, quantifiers: true, valuePath },
    createModel: (type) => ({ name: type.name }), castId: String,
    find: async (model, gqltype, args) => { calls.push({ method: 'find', args: structuredClone(args) }); return [{ id: 'p1', stock: 1, threshold: 2, name: 'a', suffix: 'a' }]; },
    count: async (model, gqltype, args) => { calls.push({ method: 'count', args: structuredClone(args) }); return 1; },
    aggregate: async (model, gqltype, args) => { calls.push({ method: 'aggregate', args: structuredClone(args) }); return [{ groupId: 'a', facts: { n: 1 } }]; },
    getById: async () => null, findChildren: async () => [],
  };
  const api = createRuntime(adapter);
  const Shop = new GraphQLObjectType({ name: 'McpFcShop', fields: { id: { type: GraphQLID }, minimum: { type: GraphQLInt }, maximum: { type: GraphQLInt } } });
  const Product = new GraphQLObjectType({ name: 'McpFcProduct', fields: {
    id: { type: GraphQLID }, stock: { type: GraphQLInt }, threshold: { type: GraphQLInt }, name: { type: GraphQLString }, suffix: { type: GraphQLString },
    shop: { type: Shop, extensions: { relation: { embedded: false } } },
  } });
  api.addNoEndpointType(Shop);
  api.connect(null, Product, 'mcpFcProduct', 'mcpFcProducts');
  return { calls, schema: api.createSchema() };
};
const byName = (tools, name) => tools.find((tool) => tool.name === name);
const errorCode = (result) => JSON.parse(result.content[0].text).errors?.[0]?.extensions?.code;
const rebuilt = (schema) => {
  const document = parse(printSchema(schema));
  return buildASTSchema({ ...document, definitions: document.definitions.filter((definition) => !['FieldExtensionsType', 'RelationType'].includes(definition.name?.value)) });
};

describe('field comparisons in public clients', () => {
  const local = fixture();
  let server;
  let remote;
  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { query, variables } = JSON.parse(body);
      const result = await graphql({ schema: local.schema, source: query, variableValues: variables, contextValue: {} });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    remote = generateMCPTools(rebuilt(local.schema), { execution: { mode: 'remote', endpoint: `http://127.0.0.1:${server.address().port}/graphql` } });
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it.each(['local', 'SDL'])('accepts optional nullable valuePath on all three inputs without making them oneOf (%s)', (mode) => {
    const { tools } = mode === 'local' ? generateMCPTools(local.schema) : remote;
    for (const name of ['mcpFcProducts', 'mcpFcProducts_aggregate']) {
      const tool = byName(tools, name);
      for (const type of ['QLFilter', 'QLTypeFilter', 'QLFilterCondition']) {
        const input = tool.inputSchema.$defs[type];
        expect(input.properties.valuePath).toMatchObject({ type: ['string', 'null'] });
        expect(input.required ?? []).not.toContain('valuePath');
        expect(input.maxProperties).toBeUndefined();
      }
      const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      const extra = name.endsWith('_aggregate') ? { aggregation: { groupId: 'name', facts: [] } } : {};
      for (const valuePath of ['threshold', null]) expect(validate({ ...extra, stock: { operator: 'LT', valuePath } }).valid).toBe(true);
      expect(validate({ ...extra, stock: { operator: 'EQ', value: null, valuePath: 'threshold' } }).valid).toBe(true);
      expect(validate({ ...extra, stock: { valuePath: 3 } }).valid).toBe(false);
    }
  });
  it('describes supported field operands, origins and mutual exclusion in generated tools', () => {
    const { tools } = generateMCPTools(local.schema);
    const tool = byName(tools, 'mcpFcProducts');
    expect(tool.description).toContain('valuePath');
    expect(tool.description).toContain('queryFeatures.valuePath');
    expect(tool.description).toContain('queryFeatures.elementFrames: true');
    expect(tool.description).toContain('$parent.');
    expect(tool.description).toContain('$root remains unsupported');
    for (const type of ['QLFilter', 'QLTypeFilter', 'QLFilterCondition']) {
      expect(tool.inputSchema.$defs[type].description).toContain('valuePath');
      expect(tool.inputSchema.$defs[type].description).toContain('mutually exclusive');
    }
    expect(tool.inputSchema.$defs.QLTypeFilter.description).toContain('relative to the related object');
    expect(tool.inputSchema.$defs.QLFilterCondition.description).toContain('containing frame');
  });
  it.each(['local', 'SDL'])('preserves field, relation and group comparisons through list/count/aggregate execution (%s)', async (mode) => {
    local.calls.length = 0;
    const { callTool } = mode === 'local' ? generateMCPTools(local.schema, { context: {} }) : remote;
    const args = { stock: { operator: 'LT', valuePath: 'threshold' }, shop: { terms: [{ path: 'minimum', operator: 'LTE', valuePath: 'maximum' }] },
      AND: [{ conditions: [{ field: 'name', operator: 'ENDS_WITH', valuePath: 'suffix' }] }] };
    const list = await callTool('mcpFcProducts', { ...args, pagination: { page: 1, size: 10, count: true } });
    expect(list.isError, JSON.stringify(list)).toBe(false);
    expect(local.calls.filter((call) => call.method === 'find' || call.method === 'count')).toHaveLength(2);
    for (const call of local.calls) expect(call.args).toMatchObject(args);
    local.calls.length = 0;
    const aggregate = await callTool('mcpFcProducts_aggregate', { ...args, aggregation: { groupId: 'name', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } });
    expect(aggregate.isError).toBe(false);
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0]).toMatchObject({ method: 'aggregate', args });
  });
  it.each(['local', 'SDL'])('reports the shared runtime error when both operands are supplied (%s)', async (mode) => {
    const { callTool } = mode === 'local' ? generateMCPTools(local.schema, { context: {} }) : remote;
    const result = await callTool('mcpFcProducts', { stock: { operator: 'EQ', value: null, valuePath: 'threshold' } });
    expect(errorCode(result)).toBe('INVALID_FILTER_VALUE');
  });
  it('gates comparisons at execution on an undeclared adapter while keeping the schema additive', async () => {
    const { schema, calls } = fixture(false);
    const { callTool } = generateMCPTools(schema, { context: {} });
    expect(errorCode(await callTool('mcpFcProducts', { stock: { valuePath: 'threshold' } }))).toBe('UNSUPPORTED_QUERY');
    expect(calls).toEqual([]);
  });
  it('describes the actual three nullable input fields without changing the descriptor format', () => {
    const descriptor = buildClientDescriptor(local.schema);
    expect(descriptor.formatVersion).toBe(1);
    for (const name of ['QLFilter', 'QLTypeFilter', 'QLFilterCondition']) {
      expect(descriptor.types[name].fields.find((field) => field.name === 'valuePath')).toMatchObject({ name: 'valuePath', type: 'String' });
      expect(local.schema.getType(name).isOneOf).not.toBe(true);
    }
  });
});

// The literal text operators (#108, part 1) in generated MCP tools: input schemas and descriptions name every
// QLOperator value, and list, count and aggregate calls pass text conditions to an adapter that declares them in
// queryFeatures. An adapter without the declaration rejects them before it runs, as GraphQL requests do. The
// descriptions also state the value and path rules of the emptiness operators (#108, part 2a), and that their tests of
// references and collections depend on the database adapter (part 2b).
import { describe, expect, it } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createRuntime, QLOperator } from '../packages/core/src/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';

const TEXT = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
const OPERATORS = QLOperator.getValues().map((value) => value.name);
// The descriptions name every QLOperator value and, whatever the enum holds, the text operators.
const DESCRIBED = [...new Set([...OPERATORS, ...TEXT])];
const LIST = 'mcpTextShops';
const AGGREGATE = `${LIST}_aggregate`;

// A runtime over an in-memory adapter that records the arguments of each call and returns fixed rows.
const createTools = (queryFeatures) => {
  const calls = [];
  const rows = [
    { _id: 's1', id: 's1', name: 'Palermo Soho', tags: ['Red', 'blue'] },
    { _id: 's2', id: 's2', name: 'palermo Hollywood', tags: ['RED'] },
  ];
  const record = (method, args) => { calls.push({ method, args: structuredClone(args) }); };
  const adapter = {
    ...(queryFeatures === undefined ? {} : { queryFeatures }),
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById() { return null; },
    async find(model, gqltype, args) { record('find', args); return rows; },
    async count(model, gqltype, args) { record('count', args); return rows.length; },
    async aggregate(model, gqltype, args) { record('aggregate', args); return [{ groupId: 'Palermo Soho', facts: { shops: 2 } }]; },
    async findChildren() { return []; },
  };
  const runtime = createRuntime(adapter);
  const Owner = new GraphQLObjectType({ name: 'McpTextOwner', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Shop = new GraphQLObjectType({
    name: 'McpTextShop',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tags: { type: new GraphQLList(GraphQLString) },
      owner: { type: Owner, extensions: { relation: { embedded: false, connectionField: 'owner' } } },
    },
  });
  runtime.addNoEndpointType(Owner);
  runtime.connect(null, Shop, 'mcpTextShop', LIST);
  return { calls, ...generateMCPTools(runtime.createSchema(), { context: {} }) };
};
const tool = (tools, name) => tools.find((item) => item.name === name);
const firstError = (result) => JSON.parse(result.content[0].text).errors[0];
// `\bEQ\b` does not match inside IEQ, nor `\bLIKE\b` inside ILIKE.
const names = (text, operator) => new RegExp(`\\b${operator}\\b`).test(text);

describe('MCP tool schemas and descriptions with the text operators', () => {
  const { tools } = createTools({ operators: OPERATORS });

  it('lists every QLOperator value, the text operators included, in the operator enum of list and aggregate tools', () => {
    expect(OPERATORS).toEqual(expect.arrayContaining(TEXT));
    for (const name of [LIST, AGGREGATE]) {
      const operator = tool(tools, name).inputSchema.$defs.QLOperator;
      expect(operator.type, name).toBe('string');
      expect(operator.enum, name).toEqual(OPERATORS);
    }
  });

  it('reaches the operator enum from field filters, relation terms and group conditions', () => {
    const { $defs } = tool(tools, LIST).inputSchema;
    for (const type of ['QLFilter', 'QLTypeFilter', 'QLFilterCondition']) {
      expect($defs[type].properties.operator, type).toEqual({ anyOf: [{ $ref: '#/$defs/QLOperator' }, { type: 'null' }] });
    }
  });

  it('names every operator in the QLOperator description, with the literal and case rules of the text operators', () => {
    const { description } = tool(tools, LIST).inputSchema.$defs.QLOperator;
    for (const operator of DESCRIBED) expect(names(description, operator), operator).toBe(true);
    expect(description).toContain('literally');
    expect(description).toContain('% and _ are ordinary characters');
    expect(description).toContain('LIKE, STARTS_WITH and ENDS_WITH respect case');
  });

  // Only the operator list counts: the emptiness rules that follow it name IS_EMPTY and IS_NOT_EMPTY as well.
  it('names every operator in the operator list of the list and aggregate tool descriptions', () => {
    for (const name of [LIST, AGGREGATE]) {
      const list = tool(tools, name).description.match(/operators: ([^;)]*)/)?.[1];
      expect(list, name).toBeTypeOf('string');
      for (const operator of DESCRIBED) expect(names(list, operator), `${name} ${operator}`).toBe(true);
    }
  });

  it('accepts the text operators and rejects unknown ones in hosts that validate tool input', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(tool(tools, LIST).inputSchema);
    for (const operator of TEXT) {
      expect(validate({ name: { operator, value: 'pal' } }).valid, operator).toBe(true);
      expect(validate({ AND: [{ conditions: [{ field: 'tags', operator, value: 'red' }] }] }).valid, operator).toBe(true);
      expect(validate({ owner: { terms: [{ path: 'name', operator, value: 'ana' }] } }).valid, operator).toBe(true);
    }
    expect(validate({ name: { operator: 'CONTAINS', value: 'pal' } }).valid).toBe(false);
    expect(validate({ name: { operator: 'ilike', value: 'pal' } }).valid).toBe(false);
  });

  // The texts are the same whatever the adapter declares: generateMCPTools reads only the schema, so they say that
  // references and collections depend on the database adapter (#108, part 2b).
  it('says that IS_EMPTY and IS_NOT_EMPTY take no value, test the field itself without a path, and test references and collections where the adapter supports it', () => {
    const NO_VALUE = 'IS_EMPTY and IS_NOT_EMPTY take no value';
    const ADAPTER = 'where the database adapter supports it';
    const { $defs, properties } = tool(tools, LIST).inputSchema;
    expect($defs.QLOperator.description).toContain(`${NO_VALUE} (omit it or pass null), and every record matches exactly one of them`);
    expect($defs.QLOperator.description).toContain('a list when missing, null or [] ([null] is not)');
    expect($defs.QLOperator.description).toContain('so EQ null also matches [null] and never []');
    // A path that goes on past a collection keeps the permanent INVALID_FILTER_PATH on every adapter.
    expect($defs.QLOperator.description).toContain('For IS_EMPTY and IS_NOT_EMPTY, a path that continues inside an embedded list or a collection '
      + 'fails with INVALID_FILTER_PATH. Where the database adapter supports it, they also test references and collections, and read a record '
      + 'the caller may not see as a missing one: a reference is empty when it points to no record the caller may see, a collection when it '
      + 'has no child the caller may see, and a field reached through references when it is empty by its own rule or a reference on the way '
      + 'is empty; other adapters reject these conditions with UNSUPPORTED_QUERY.');
    expect($defs.QLOperator.description).not.toContain('for now');
    expect($defs.QLFilter.properties.value.description).toBe('Filter value. Accepts a scalar, or an array for the IN, NIN and BTW operators. Omit it, or pass null, for IS_EMPTY and IS_NOT_EMPTY.');
    expect($defs.QLTypeFilter.description).toContain('With IS_EMPTY or IS_NOT_EMPTY, omit the path to test the embedded object or embedded list itself. '
      + 'Where the database adapter supports it, a reference or collection can be tested itself the same way.');
    expect($defs.QLTypeFilterExpression.description).toContain('A term with IS_EMPTY or IS_NOT_EMPTY and no path tests an embedded object or embedded list itself. '
      + 'Where the database adapter supports it, such a term also tests a reference or collection itself.');
    expect($defs.QLFilterCondition.description).toContain('test an embedded object or embedded list field itself when the path is omitted, '
      + `and a reference or collection field itself ${ADAPTER}.`);
    expect(properties.name.description).toBe(`Filter on \`name\` using { operator, value }; ${NO_VALUE}.`);
    expect(properties.owner.description).toBe('Filter on the related entity or embedded value `owner` using { terms: [{ path, operator, value }] }; '
      + `a term { operator: IS_EMPTY } or { operator: IS_NOT_EMPTY } without path tests the field itself, on a reference or collection only ${ADAPTER}.`);
    for (const name of [LIST, AGGREGATE]) {
      expect(tool(tools, name).description, name).toContain(`; ${NO_VALUE}, and a term or group condition without path applies them to the field `
        + `itself: an embedded object or list, or a reference or collection ${ADAPTER}),`);
    }
  });
});

describe('MCP tool calls with the text operators', () => {
  it('passes the text conditions of a counted list call to an adapter that declares them', async () => {
    const { calls, callTool } = createTools({ operators: OPERATORS });
    const args = {
      name: { operator: 'ILIKE', value: 'palermo' },
      tags: { operator: 'IEQ', value: 'red' },
      owner: { terms: [{ path: 'name', operator: 'ISTARTS_WITH', value: 'ana' }] },
      AND: [{ conditions: [{ field: 'name', operator: 'ISTARTS_WITH', value: 'PAL' }] }],
      OR: [{ conditions: [{ field: 'name', operator: 'ENDS_WITH', value: 'Soho' }] }, { conditions: [{ field: 'name', operator: 'IENDS_WITH', value: 'wood' }] }],
      pagination: { page: 1, size: 10, count: true },
    };
    const result = await callTool(LIST, args);
    expect(result.isError).toBe(false);
    expect(result.structuredContent[LIST].map((row) => row.id)).toEqual(['s1', 's2']);
    expect(result.structuredContent.totalCount).toBe(2);
    expect(calls.map((call) => call.method).sort()).toEqual(['count', 'find']);
    for (const call of calls) {
      expect(call.args.name, call.method).toEqual(args.name);
      expect(call.args.tags, call.method).toEqual(args.tags);
      expect(call.args.owner, call.method).toEqual(args.owner);
      expect(call.args.AND, call.method).toEqual(args.AND);
      expect(call.args.OR, call.method).toEqual(args.OR);
    }
  });

  it('passes STARTS_WITH to the adapter in an aggregate call', async () => {
    const { calls, callTool } = createTools({ operators: OPERATORS });
    const result = await callTool(AGGREGATE, {
      name: { operator: 'STARTS_WITH', value: 'Palermo' },
      aggregation: { groupId: 'name', facts: [{ operation: 'COUNT', factName: 'shops', path: 'id' }] },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent[AGGREGATE]).toEqual([{ groupId: 'Palermo Soho', facts: { shops: 2 } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'aggregate', args: { name: { operator: 'STARTS_WITH', value: 'Palermo' } } });
  });

  it('returns UNSUPPORTED_QUERY without calling an adapter that declares no queryFeatures, and still runs LIKE', async () => {
    const { calls, callTool } = createTools(undefined);
    for (const operator of TEXT) {
      for (const [name, extra] of [[LIST, {}], [AGGREGATE, { aggregation: { groupId: 'name', facts: [{ operation: 'COUNT', factName: 'shops', path: 'id' }] } }]]) {
        const result = await callTool(name, { name: { operator, value: 'pal' }, ...extra });
        expect(result.isError, `${name} ${operator}`).toBe(true);
        const error = firstError(result);
        expect(error.extensions.code, `${name} ${operator}`).toBe('UNSUPPORTED_QUERY');
        expect(error.message).toBe(`The database adapter does not support the ${operator} filter operator, used on McpTextShop.name`);
      }
    }
    const term = await callTool(LIST, { owner: { terms: [{ path: 'name', operator: 'IEQ', value: 'ana' }] } });
    expect(firstError(term).message).toBe('The database adapter does not support the IEQ filter operator, used on McpTextShop.owner.name');
    expect(calls).toEqual([]);
    const like = await callTool(LIST, { name: { operator: 'LIKE', value: 'Palermo' } });
    expect(like.isError).toBe(false);
    expect(calls).toEqual([{ method: 'find', args: { name: { operator: 'LIKE', value: 'Palermo' } } }]);
  });
});

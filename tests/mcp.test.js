import {
  describe, it, expect, beforeAll,
} from 'vitest';
import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLNonNull,
} from 'graphql';
import * as simfinity from '../src/index.js';

describe('MCP generation', () => {
  let schema;

  const AuthorType = new GraphQLObjectType({
    name: 'McpAuthor',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const BookType = new GraphQLObjectType({
    name: 'McpBook',
    description: 'A book in the catalog.',
    fields: () => ({
      id: { type: GraphQLString },
      title: { type: new GraphQLNonNull(GraphQLString), description: 'The book title.' },
      rating: { type: GraphQLFloat },
      pages: { type: GraphQLInt },
      state: { type: GraphQLString },
      author: {
        type: AuthorType,
        extensions: {
          relation: {
            embedded: false,
            connectionField: 'author_id',
          },
        },
      },
    }),
  });

  const NotifyInput = new GraphQLInputObjectType({
    name: 'McpNotifyInput',
    fields: () => ({
      bookId: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });

  const NotifyResult = new GraphQLObjectType({
    name: 'McpNotifyResult',
    fields: () => ({
      ok: { type: GraphQLString },
    }),
  });

  const bookStateMachine = {
    initialState: { name: 'DRAFT', value: 'DRAFT' },
    actions: {
      publish: {
        from: { name: 'DRAFT', value: 'DRAFT' },
        to: { name: 'PUBLISHED', value: 'PUBLISHED' },
        description: 'Publish the book',
      },
    },
  };

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);

    simfinity.addNoEndpointType(AuthorType);
    simfinity.connect(
      null,
      BookType,
      'mcpbook',
      'mcpbooks',
      null,
      null,
      bookStateMachine,
    );
    simfinity.registerMutation(
      'notifyMcpBook',
      'Send a notification about a book',
      NotifyInput,
      NotifyResult,
      async () => ({ ok: 'sent' }),
    );

    schema = simfinity.createSchema();
  });

  describe('exports', () => {
    it('exposes the MCP public API', () => {
      expect(typeof simfinity.generateMCPTools).toBe('function');
      expect(typeof simfinity.graphqlArgsToJSONSchema).toBe('function');
      expect(typeof simfinity.createMCPServer).toBe('function');
      expect(typeof simfinity.startStdioMCPServer).toBe('function');
      expect(typeof simfinity.createHTTPMCPHandler).toBe('function');
      expect(simfinity.mcp).toBeDefined();
      expect(typeof simfinity.mcp.generateMCPTools).toBe('function');
    });
  });

  describe('generateMCPTools', () => {
    it('generates one tool per generated GraphQL operation', () => {
      const { tools } = simfinity.generateMCPTools(schema);
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('mcpbook');
      expect(names).toContain('mcpbooks');
      expect(names).toContain('mcpbooks_aggregate');
      expect(names).toContain('addmcpbook');
      expect(names).toContain('updatemcpbook');
      expect(names).toContain('deletemcpbook');
      expect(names).toContain('publish_mcpbook');
      expect(names).toContain('notifyMcpBook');
    });

    it('tags tools with their GraphQL operation kind', () => {
      const { tools } = simfinity.generateMCPTools(schema);
      const single = tools.find((tool) => tool.name === 'mcpbook');
      const add = tools.find((tool) => tool.name === 'addmcpbook');

      expect(single.kind).toBe('query');
      expect(add.kind).toBe('mutation');
    });

    it('throws for an invalid schema', () => {
      expect(() => simfinity.generateMCPTools(null)).toThrow();
      expect(() => simfinity.generateMCPTools({})).toThrow();
    });

    it('throws when remote execution lacks an endpoint', () => {
      expect(() => simfinity.generateMCPTools(schema, { execution: { mode: 'remote' } }))
        .toThrow();
    });

    it('respects include/exclude filters', () => {
      const { tools: onlyAdd } = simfinity.generateMCPTools(schema, { include: ['addmcpbook'] });
      expect(onlyAdd.map((tool) => tool.name)).toEqual(['addmcpbook']);

      const { tools: noMutations } = simfinity.generateMCPTools(schema, { exclude: ['mutation'] });
      expect(noMutations.every((tool) => tool.kind === 'query')).toBe(true);
    });
  });

  describe('inputSchema generation', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('marks NonNull mutation input as required and references its input type', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      expect(add.inputSchema.type).toBe('object');
      expect(add.inputSchema.required).toContain('input');
      expect(add.inputSchema.properties.input).toEqual({ $ref: '#/$defs/McpBookInput' });
      expect(add.inputSchema.$defs.McpBookInput).toBeDefined();
    });

    it('maps GraphQL scalars to JSON Schema primitives', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      const bookInput = add.inputSchema.$defs.McpBookInput;
      expect(bookInput.properties.title).toMatchObject({ type: 'string' });
      expect(bookInput.properties.rating).toEqual({ type: 'number' });
      expect(bookInput.properties.pages).toEqual({ type: 'integer' });
      expect(bookInput.required).toContain('title');
    });

    it('exposes full-fidelity filter/pagination/sort arguments on list queries', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.inputSchema.properties.pagination.$ref).toBe('#/$defs/QLPagination');
      expect(list.inputSchema.properties.sort.$ref).toBe('#/$defs/QLSortExpression');
      expect(list.inputSchema.properties.AND).toMatchObject({
        type: 'array',
        items: { $ref: '#/$defs/QLFilterGroup' },
      });
      expect(list.inputSchema.properties.OR).toMatchObject({
        type: 'array',
        items: { $ref: '#/$defs/QLFilterGroup' },
      });
    });

    it('handles recursive input types via $defs/$ref', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      const group = list.inputSchema.$defs.QLFilterGroup;
      expect(group).toBeDefined();
      expect(group.properties.AND).toEqual({
        type: 'array',
        items: { $ref: '#/$defs/QLFilterGroup' },
      });
    });

    it('represents enums as string enumerations', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      const operator = list.inputSchema.$defs.QLOperator;
      expect(operator.type).toBe('string');
      expect(operator.enum).toContain('EQ');
      expect(operator.enum).toContain('LIKE');
    });

    it('requires the aggregation argument on aggregate queries', () => {
      const aggregate = tools.find((tool) => tool.name === 'mcpbooks_aggregate');
      expect(aggregate.inputSchema.required).toContain('aggregation');
    });

    it('propagates GraphQL type and field descriptions into input $defs', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      const bookInput = add.inputSchema.$defs.McpBookInput;
      expect(bookInput.description).toBe('A book in the catalog.');
      expect(bookInput.properties.title.description).toBe('The book title.');
    });

    it('supplies curated descriptions for synthetic filter types and args', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.inputSchema.$defs.QLOperator.description).toContain('EQ');
      expect(list.inputSchema.$defs.QLPagination.description).toBeTruthy();
      expect(list.inputSchema.properties.pagination.description).toBeTruthy();
      expect(list.inputSchema.properties.AND.description).toBeTruthy();
      const aggregate = tools.find((tool) => tool.name === 'mcpbooks_aggregate');
      expect(aggregate.inputSchema.properties.aggregation.description).toBeTruthy();
    });
  });

  describe('tool descriptions', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('generates an actionable description for list queries', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.description).toContain('McpBook');
      expect(list.description).toContain('LIKE');
      expect(list.description).toContain('pagination');
      expect(list.description).toContain('A book in the catalog.');
    });

    it('generates an actionable description for aggregate queries', () => {
      const aggregate = tools.find((tool) => tool.name === 'mcpbooks_aggregate');
      expect(aggregate.description).toContain('McpBook');
      expect(aggregate.description).toContain('SUM');
      expect(aggregate.description).toContain('aggregation');
    });

    it('describes CRUD mutations referencing the entity', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      const del = tools.find((tool) => tool.name === 'deletemcpbook');
      expect(add.description).toContain('Create');
      expect(add.description).toContain('McpBook');
      expect(del.description).toContain('Delete');
    });

    it('prefers the GraphQL field description when present', () => {
      const custom = tools.find((tool) => tool.name === 'notifyMcpBook');
      expect(custom.description).toBe('Send a notification about a book');
    });
  });

  describe('output schema', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('wraps the return type under the field name', () => {
      const single = tools.find((tool) => tool.name === 'mcpbook');
      expect(single.outputSchema.type).toBe('object');
      expect(single.outputSchema.properties.mcpbook).toBeDefined();
      // Nullable GraphQL positions accept null in the output schema.
      expect(single.outputSchema.properties.mcpbook.type).toEqual(['object', 'null']);
      expect(single.outputSchema.properties.mcpbook.description).toBe('A book in the catalog.');
      expect(single.outputSchema.properties.mcpbook.properties.title.description).toBe('The book title.');
    });

    it('describes list queries as arrays of the entity', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.outputSchema.properties.mcpbooks.type).toEqual(['array', 'null']);
      expect(list.outputSchema.properties.mcpbooks.items.type).toEqual(['object', 'null']);
    });
  });

  describe('title and annotations', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('marks queries as read-only', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.title).toBe('List McpBook');
      expect(list.annotations.readOnlyHint).toBe(true);
      expect(list.annotations.openWorldHint).toBe(false);
    });

    it('marks delete as destructive and update as idempotent', () => {
      const del = tools.find((tool) => tool.name === 'deletemcpbook');
      const update = tools.find((tool) => tool.name === 'updatemcpbook');
      expect(del.annotations.destructiveHint).toBe(true);
      expect(del.annotations.idempotentHint).toBe(true);
      expect(update.annotations.idempotentHint).toBe(true);
      expect(del.annotations.readOnlyHint).toBe(false);
    });

    it('gives mutations a human-readable title', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      expect(add.title).toBe('Create McpBook');
    });
  });
});

describe('MCP callTool execution', () => {
  const InputType = new GraphQLInputObjectType({
    name: 'McpStubInput',
    fields: () => ({
      name: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });

  const ItemType = new GraphQLObjectType({
    name: 'McpStubItem',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const stubSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        item: {
          type: ItemType,
          args: { id: { type: new GraphQLNonNull(GraphQLString) } },
          resolve: (parent, args, context) => ({ id: args.id, name: context?.who || 'anon' }),
        },
      },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: {
        addItem: {
          type: ItemType,
          args: { input: { type: new GraphQLNonNull(InputType) } },
          resolve: (parent, args) => ({ id: '1', name: args.input.name }),
        },
      },
    }),
  });

  it('executes a query in-process, passing variables and selecting output fields', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('item', { id: 'abc' });
    const payload = JSON.parse(response.content[0].text);

    expect(response.isError).toBe(false);
    expect(payload.item).toEqual({ id: 'abc', name: 'anon' });
  });

  it('returns structuredContent matching the GraphQL data', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('item', { id: 'abc' });

    expect(response.structuredContent).toEqual({ item: { id: 'abc', name: 'anon' } });
  });

  it('passes a static context through to resolvers', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, { context: { who: 'tester' } });
    const response = await callTool('item', { id: 'abc' });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.item.name).toBe('tester');
  });

  it('supports a context factory receiving the call extra', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, {
      context: (extra) => ({ who: extra?.who || 'factory' }),
    });
    const response = await callTool('item', { id: 'abc' }, { who: 'fromExtra' });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.item.name).toBe('fromExtra');
  });

  it('executes mutations in-process', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('addItem', { input: { name: 'New' } });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.addItem.name).toBe('New');
  });

  it('flags GraphQL errors via isError', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('item', {});

    expect(response.isError).toBe(true);
  });

  it('throws for an unknown tool', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    await expect(callTool('doesNotExist', {})).rejects.toThrow();
  });
});

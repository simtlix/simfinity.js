import {
  describe, it, expect, beforeAll, vi,
} from 'vitest';
import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLSchema,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLString,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLNonNull,
} from 'graphql';
import * as simfinity from '../src/index.js';

// ---------------------------------------------------------------------------
// Simfinity-connected schema (unique McpOpt* type names so the per-file global
// registries never collide with other test files).
// ---------------------------------------------------------------------------

const AUTHOR_FAMILY = [
  'mcpoptauthor',
  'mcpoptauthors',
  'mcpoptauthors_aggregate',
  'addmcpoptauthor',
  'updatemcpoptauthor',
  'deletemcpoptauthor',
];

const BOOK_FAMILY = [
  'mcpoptbook',
  'mcpoptbooks',
  'mcpoptbooks_aggregate',
  'addmcpoptbook',
  'updatemcpoptbook',
  'deletemcpoptbook',
];

describe('MCP tool-definition options (simfinity schema)', () => {
  let schema;

  const AuthorType = new GraphQLObjectType({
    name: 'McpOptAuthor',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const BookType = new GraphQLObjectType({
    name: 'McpOptBook',
    fields: () => ({
      id: { type: GraphQLString },
      title: { type: new GraphQLNonNull(GraphQLString) },
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

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
    simfinity.connect(null, AuthorType, 'mcpoptauthor', 'mcpoptauthors');
    simfinity.connect(null, BookType, 'mcpoptbook', 'mcpoptbooks');
    schema = simfinity.createSchema();
  });

  describe('include / exclude matrix', () => {
    it('includes only a category when include is the string "query"', () => {
      const { tools } = simfinity.generateMCPTools(schema, { include: 'query' });
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((tool) => tool.kind === 'query')).toBe(true);
      expect(tools.map((tool) => tool.name)).toContain('mcpoptbooks');
    });

    it('includes only a category when include is the array ["mutation"]', () => {
      const { tools } = simfinity.generateMCPTools(schema, { include: ['mutation'] });
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((tool) => tool.kind === 'mutation')).toBe(true);
    });

    it('excludes tools by raw GraphQL field name', () => {
      const { tools } = simfinity.generateMCPTools(schema, { exclude: ['mcpoptbooks'] });
      const names = tools.map((tool) => tool.name);
      expect(names).not.toContain('mcpoptbooks');
      expect(names).toContain('mcpoptbook');
      expect(names).toContain('mcpoptbooks_aggregate');
    });

    it('lets exclude win over include', () => {
      const { tools } = simfinity.generateMCPTools(schema, {
        include: ['mcpoptbooks'],
        exclude: ['mcpoptbooks'],
      });
      expect(tools).toEqual([]);
    });

    it('accepts a single string instead of an array for include', () => {
      const { tools } = simfinity.generateMCPTools(schema, { include: 'mcpoptbook' });
      expect(tools.map((tool) => tool.name)).toEqual(['mcpoptbook']);
    });

    it('accepts a single string instead of an array for exclude', () => {
      const { tools } = simfinity.generateMCPTools(schema, { exclude: 'mutation' });
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((tool) => tool.kind === 'query')).toBe(true);
    });
  });

  describe('includeTypes / excludeTypes', () => {
    it('excludeTypes drops the whole tool family of an entity, including the aggregate (sibling resolution)', () => {
      const { tools } = simfinity.generateMCPTools(schema, { excludeTypes: 'McpOptBook' });
      const names = tools.map((tool) => tool.name);
      for (const name of BOOK_FAMILY) {
        expect(names).not.toContain(name);
      }
      // The author family is untouched.
      for (const name of AUTHOR_FAMILY) {
        expect(names).toContain(name);
      }
    });

    it('includeTypes keeps only tools whose entity (return) type matches', () => {
      const { tools } = simfinity.generateMCPTools(schema, { includeTypes: ['McpOptAuthor'] });
      expect(tools.map((tool) => tool.name).sort()).toEqual([...AUTHOR_FAMILY].sort());
    });

    it('includeTypes resolves aggregate entities via the sibling list field', () => {
      const { tools } = simfinity.generateMCPTools(schema, { includeTypes: ['McpOptBook'] });
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('mcpoptbooks_aggregate');
      expect(names).not.toContain('mcpoptauthors_aggregate');
    });
  });
});

// ---------------------------------------------------------------------------
// Hand-built stub schemas for the remaining option behaviors.
// ---------------------------------------------------------------------------

describe('MCP tool-definition options (stub schemas)', () => {
  // --- selectionDepth / includeId ------------------------------------------
  const GrandType = new GraphQLObjectType({
    name: 'McpOptGrand',
    fields: () => ({
      id: { type: GraphQLString },
      gname: { type: GraphQLString },
    }),
  });

  const ChildType = new GraphQLObjectType({
    name: 'McpOptChild',
    fields: () => ({
      id: { type: GraphQLString },
      grand: { type: GrandType },
    }),
  });

  const ParentType = new GraphQLObjectType({
    name: 'McpOptParent',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
      child: { type: ChildType },
    }),
  });

  // A type whose only field requires an argument: the single shape where the
  // includeId fallback is observable in the generated document.
  const GatedType = new GraphQLObjectType({
    name: 'McpOptGated',
    fields: () => ({
      id: {
        type: GraphQLString,
        args: { key: { type: new GraphQLNonNull(GraphQLString) } },
      },
    }),
  });

  const nestedSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        parent: { type: ParentType, resolve: () => null },
        // Same return type as `parent`: CAN reach `grand` at selectionDepth 2,
        // so it observes whether a per-tool override leaks to sibling tools.
        sibling: { type: ParentType, resolve: () => null },
        gated: { type: GatedType, resolve: () => null },
      },
    }),
  });

  describe('selectionDepth and includeId', () => {
    it('stops object expansion after one level by default', () => {
      const { getOperation } = simfinity.generateMCPTools(nestedSchema);
      const doc = getOperation('parent');
      expect(doc).toContain('child { id }');
      expect(doc).not.toContain('grand');
    });

    it('selectionDepth 2 with includeId false expands two nesting levels in the document', () => {
      const { getOperation } = simfinity.generateMCPTools(nestedSchema, {
        selectionDepth: 2,
        includeId: false,
      });
      const doc = getOperation('parent');
      expect(doc).toContain('child { id grand { id gname } }');
    });

    it('mirrors the selectionDepth in the output schema', () => {
      const { tools } = simfinity.generateMCPTools(nestedSchema, { selectionDepth: 2 });
      const parent = tools.find((tool) => tool.name === 'parent');
      const childSchema = parent.outputSchema.properties.parent.properties.child;
      expect(childSchema.properties.grand).toBeDefined();
      expect(childSchema.properties.grand.properties.gname).toBeDefined();
    });

    it('includeId false falls back to __typename when nothing is selectable', () => {
      const { getOperation } = simfinity.generateMCPTools(nestedSchema, { includeId: false });
      expect(getOperation('gated')).toContain('gated { __typename }');
    });

    it('includeId true must not select an id field whose required args cannot be satisfied', () => {
      const { getOperation } = simfinity.generateMCPTools(nestedSchema);
      expect(getOperation('gated')).toContain('gated { __typename }');
    });
  });

  // --- toolNamePrefix --------------------------------------------------------
  const StubItemType = new GraphQLObjectType({
    name: 'McpOptStubItem',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const StubInputType = new GraphQLInputObjectType({
    name: 'McpOptStubInput',
    fields: () => ({
      name: { type: new GraphQLNonNull(GraphQLString) },
      nickname: { type: GraphQLString },
    }),
  });

  const stubSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        item: {
          type: StubItemType,
          args: { id: { type: new GraphQLNonNull(GraphQLString) } },
          resolve: (parent, args) => ({ id: args.id, name: 'Stub' }),
        },
      },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: {
        addItem: {
          type: StubItemType,
          args: { input: { type: new GraphQLNonNull(StubInputType) } },
          resolve: (parent, args) => ({ id: '1', name: args.input.name }),
        },
      },
    }),
  });

  describe('toolNamePrefix', () => {
    it('prefixes every published tool name', () => {
      const { tools } = simfinity.generateMCPTools(stubSchema, { toolNamePrefix: 'cat_' });
      expect(tools.map((tool) => tool.name).sort()).toEqual(['cat_addItem', 'cat_item']);
    });

    it('serves getOperation and callTool under the prefixed name while the document keeps the raw field name', async () => {
      const { callTool, getOperation } = simfinity.generateMCPTools(stubSchema, { toolNamePrefix: 'cat_' });

      const doc = getOperation('cat_item');
      expect(doc).toContain('query itemOperation');
      expect(doc).toContain('item(id: $id)');
      expect(doc).not.toContain('cat_item');

      const response = await callTool('cat_item', { id: '7' });
      expect(response.isError).toBe(false);
      expect(response.structuredContent).toEqual({ item: { id: '7', name: 'Stub' } });

      // The unprefixed name is not published.
      expect(() => getOperation('item')).toThrow();
      await expect(callTool('item', { id: '7' })).rejects.toThrow();
    });

    it('rejects an invalid prefix with MCP_INVALID_TOOL_NAME', () => {
      let error;
      try {
        simfinity.generateMCPTools(stubSchema, { toolNamePrefix: 'bad prefix!' });
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.extensions.code).toBe('MCP_INVALID_TOOL_NAME');
    });
  });

  // --- toolOverrides ---------------------------------------------------------
  describe('toolOverrides', () => {
    it('overrides description and title, and merges annotations over the generated ones', () => {
      const { tools } = simfinity.generateMCPTools(stubSchema, {
        toolOverrides: {
          item: {
            description: 'Custom item description',
            title: 'Custom Item Title',
            annotations: { idempotentHint: true },
          },
        },
      });
      const item = tools.find((tool) => tool.name === 'item');
      expect(item.description).toBe('Custom item description');
      expect(item.title).toBe('Custom Item Title');
      // Generated annotations survive; the override is merged on top.
      expect(item.annotations).toMatchObject({
        title: 'Custom Item Title',
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      });
    });

    it('a selection override omits the outputSchema and shows up in the document', () => {
      const { tools, getOperation } = simfinity.generateMCPTools(stubSchema, {
        toolOverrides: { item: { selection: 'id name' } },
      });
      const item = tools.find((tool) => tool.name === 'item');
      expect(item.outputSchema).toBeUndefined();
      expect(getOperation('item')).toContain('item(id: $id) { id name }');
    });

    it('accepts a braced selection override', () => {
      const { getOperation } = simfinity.generateMCPTools(stubSchema, {
        toolOverrides: { item: { selection: '{ name }' } },
      });
      expect(getOperation('item')).toContain('item(id: $id) { name }');
    });

    it('applies a per-tool selectionDepth without affecting other tools', () => {
      const { getOperation } = simfinity.generateMCPTools(nestedSchema, {
        toolOverrides: { parent: { selectionDepth: 2 } },
      });
      expect(getOperation('parent')).toContain('grand { id gname }');
      // sibling returns the SAME type and could reach grand at depth 2, so it
      // proves the override stayed scoped to parent (depth stayed 1).
      const siblingDoc = getOperation('sibling');
      expect(siblingDoc).toContain('child { id }');
      expect(siblingDoc).not.toContain('grand');
    });

    it('matches overrides by the unprefixed field name when a prefix is set', () => {
      const { tools } = simfinity.generateMCPTools(stubSchema, {
        toolNamePrefix: 'cat_',
        toolOverrides: { item: { title: 'Prefixed Override' } },
      });
      const item = tools.find((tool) => tool.name === 'cat_item');
      expect(item.title).toBe('Prefixed Override');
    });
  });

  // --- duplicate tool names ---------------------------------------------------
  describe('duplicate tool names', () => {
    it('keeps the first tool and skips the duplicate with a console.warn', () => {
      const DupType = new GraphQLObjectType({
        name: 'McpOptDup',
        fields: () => ({ id: { type: GraphQLString } }),
      });
      const dupSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: { thing: { type: DupType, resolve: () => null } },
        }),
        mutation: new GraphQLObjectType({
          name: 'Mutation',
          fields: { thing: { type: DupType, resolve: () => null } },
        }),
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { tools } = simfinity.generateMCPTools(dupSchema);
        const matches = tools.filter((tool) => tool.name === 'thing');
        expect(matches).toHaveLength(1);
        expect(matches[0].kind).toBe('query');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('Duplicate tool name "thing"');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // --- classification by placeholder description -------------------------------
  describe('mutation classification', () => {
    const OrderType = new GraphQLObjectType({
      name: 'McpOptOrder',
      fields: () => ({
        id: { type: GraphQLString },
        status: { type: GraphQLString },
      }),
    });

    const classificationSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { order: { type: OrderType, resolve: () => null } },
      }),
      mutation: new GraphQLObjectType({
        name: 'Mutation',
        fields: {
          // Generated CRUD mutations carry BOTH the placeholder description
          // and the name prefix (see buildMutation in src/index.js).
          addOrder: { type: OrderType, description: 'add', resolve: () => null },
          updateOrder: { type: OrderType, description: 'update', resolve: () => null },
          deleteOrder: { type: OrderType, description: 'delete', resolve: () => null },
          // Placeholder description WITHOUT the matching prefix: a custom
          // mutation that happens to be described 'update' must stay custom.
          modifyOrder: { type: OrderType, description: 'update', resolve: () => null },
          // Custom mutation whose name starts with "update" but has a real
          // description: must be classified as custom, NOT as an update.
          updateReport: {
            type: OrderType,
            description: 'Regenerate the report for an order.',
            resolve: () => null,
          },
          // No description at all: the name-prefix fallback applies.
          updateFallback: { type: OrderType, resolve: () => null },
        },
      }),
    });

    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(classificationSchema));
    });

    it('classifies placeholder description + matching prefix as a create operation', () => {
      const create = tools.find((tool) => tool.name === 'addOrder');
      expect(create.title).toBe('Create McpOptOrder');
      expect(create.description).toContain('Create a new McpOptOrder');
      expect(create.annotations.readOnlyHint).toBe(false);
      expect(create.annotations.idempotentHint).toBeUndefined();
      expect(create.annotations.destructiveHint).toBeUndefined();
    });

    it('classifies placeholder description + matching prefix as an idempotent update', () => {
      const update = tools.find((tool) => tool.name === 'updateOrder');
      expect(update.title).toBe('Update McpOptOrder');
      expect(update.annotations.idempotentHint).toBe(true);
      expect(update.annotations.readOnlyHint).toBe(false);
    });

    it('classifies placeholder description + matching prefix as destructive', () => {
      const del = tools.find((tool) => tool.name === 'deleteOrder');
      expect(del.title).toBe('Delete McpOptOrder');
      expect(del.annotations.destructiveHint).toBe(true);
      expect(del.annotations.idempotentHint).toBe(true);
    });

    it('keeps a placeholder description WITHOUT the matching prefix custom', () => {
      const custom = tools.find((tool) => tool.name === 'modifyOrder');
      expect(custom.title).toBe('modifyOrder');
      expect(custom.annotations.idempotentHint).toBeUndefined();
      expect(custom.annotations.readOnlyHint).toBe(false);
    });

    it('treats a described mutation named updateReport as custom', () => {
      const custom = tools.find((tool) => tool.name === 'updateReport');
      expect(custom.description).toBe('Regenerate the report for an order.');
      expect(custom.title).toBe('updateReport');
      expect(custom.annotations.readOnlyHint).toBe(false);
      expect(custom.annotations.idempotentHint).toBeUndefined();
      expect(custom.annotations.destructiveHint).toBeUndefined();
    });

    it('applies the name-prefix fallback only when there is no description', () => {
      const fallback = tools.find((tool) => tool.name === 'updateFallback');
      expect(fallback.annotations.idempotentHint).toBe(true);
      expect(fallback.title).toBe('Update McpOptOrder');
    });
  });

  // --- nullable output schemas --------------------------------------------------
  describe('nullable output schemas', () => {
    const MoodEnum = new GraphQLEnumType({
      name: 'McpOptMood',
      values: { HAPPY: {}, SAD: {} },
    });
    const DateScalar = new GraphQLScalarType({ name: 'Date', serialize: (v) => v });
    const DateTimeScalar = new GraphQLScalarType({ name: 'DateTime', serialize: (v) => v });
    const ValidatedTimeScalar = new GraphQLScalarType({ name: 'McpOptValidatedTime', serialize: (v) => v });
    // createValidatedScalar-style scalar: the base scalar drives the JSON type.
    ValidatedTimeScalar.baseScalarType = { name: 'Time' };

    const EventType = new GraphQLObjectType({
      name: 'McpOptEvent',
      fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLString) },
        mood: { type: MoodEnum },
        moodRequired: { type: new GraphQLNonNull(MoodEnum) },
        day: { type: DateScalar },
        at: { type: DateTimeScalar },
        slot: { type: ValidatedTimeScalar },
      }),
    });

    const eventSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          event: {
            type: EventType,
            args: { on: { type: DateScalar } },
            resolve: () => null,
          },
        },
      }),
    });

    let eventProps;
    let eventTool;

    beforeAll(() => {
      const { tools } = simfinity.generateMCPTools(eventSchema);
      eventTool = tools.find((tool) => tool.name === 'event');
      eventProps = eventTool.outputSchema.properties.event.properties;
    });

    it('keeps NonNull positions single-typed', () => {
      expect(eventProps.id).toEqual({ type: 'string' });
      expect(eventProps.moodRequired).toEqual({ type: 'string', enum: ['HAPPY', 'SAD'] });
    });

    it('widens nullable positions to accept null, including enum values', () => {
      expect(eventTool.outputSchema.properties.event.type).toEqual(['object', 'null']);
      expect(eventProps.mood.type).toEqual(['string', 'null']);
      expect(eventProps.mood.enum).toEqual(['HAPPY', 'SAD', null]);
    });

    it('maps Date-like scalars to string formats (incl. baseScalarType)', () => {
      expect(eventProps.day).toMatchObject({ format: 'date' });
      expect(eventProps.day.type).toEqual(['string', 'null']);
      expect(eventProps.at).toMatchObject({ format: 'date-time' });
      expect(eventProps.slot).toMatchObject({ format: 'time' });
    });

    it('does not null-widen input schemas', () => {
      expect(eventTool.inputSchema.properties.on).toEqual({ type: 'string', format: 'date' });

      const { tools } = simfinity.generateMCPTools(stubSchema);
      const add = tools.find((tool) => tool.name === 'addItem');
      // Nullable input field stays single-typed.
      expect(add.inputSchema.$defs.McpOptStubInput.properties.nickname).toEqual({ type: 'string' });
    });
  });

  // --- defaultValue arguments -----------------------------------------------------
  describe('arguments with GraphQL default values', () => {
    // Enum whose member NAMES differ from their internal values: the JSON
    // Schema default must be the external name, not the internal value.
    const StateEnum = new GraphQLEnumType({
      name: 'McpOptState',
      values: {
        OPEN: { value: 1 },
        CLOSED: { value: 2 },
      },
    });

    const PrefsInput = new GraphQLInputObjectType({
      name: 'McpOptPrefs',
      fields: () => ({
        compact: { type: GraphQLBoolean, defaultValue: true },
        theme: { type: new GraphQLNonNull(GraphQLString) },
        state: { type: StateEnum, defaultValue: 2 },
      }),
    });

    const DecorType = new GraphQLObjectType({
      name: 'McpOptDecor',
      fields: () => ({
        id: { type: GraphQLString },
        label: {
          type: GraphQLString,
          args: { upper: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false } },
        },
      }),
    });

    const defaultsSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          search: {
            type: GraphQLString,
            args: {
              limit: { type: GraphQLInt, defaultValue: 10 },
              mode: { type: new GraphQLNonNull(GraphQLString), defaultValue: 'fast' },
              // Internal default value 1 corresponds to the member name OPEN.
              state: { type: StateEnum, defaultValue: 1 },
              prefs: { type: PrefsInput },
            },
            resolve: () => 'ok',
          },
          decor: { type: DecorType, resolve: () => null },
        },
      }),
    });

    let tools;
    let getOperation;

    beforeAll(() => {
      ({ tools, getOperation } = simfinity.generateMCPTools(defaultsSchema));
    });

    it('emits JSON Schema defaults and never marks defaulted args as required', () => {
      const search = tools.find((tool) => tool.name === 'search');
      expect(search.inputSchema.properties.limit).toMatchObject({ type: 'integer', default: 10 });
      // NonNull arg with a default is still optional for the caller.
      expect(search.inputSchema.properties.mode).toMatchObject({ type: 'string', default: 'fast' });
      expect(search.inputSchema.required).toBeUndefined();
    });

    it('applies the same rule to input object fields', () => {
      const search = tools.find((tool) => tool.name === 'search');
      const prefs = search.inputSchema.$defs.McpOptPrefs;
      expect(prefs.properties.compact).toMatchObject({ type: 'boolean', default: true });
      expect(prefs.required).toEqual(['theme']);
    });

    it('emits enum defaults as the member NAME (external value), not the internal value', () => {
      const search = tools.find((tool) => tool.name === 'search');
      // Argument-level enum default: internal 1 -> external name 'OPEN'.
      expect(search.inputSchema.properties.state).toMatchObject({
        $ref: '#/$defs/McpOptState',
        default: 'OPEN',
      });
      // Input-object-field enum default: internal 2 -> external name 'CLOSED'.
      expect(search.inputSchema.$defs.McpOptPrefs.properties.state).toMatchObject({
        $ref: '#/$defs/McpOptState',
        default: 'CLOSED',
      });
      // The enum $def itself publishes the member names a client must send.
      expect(search.inputSchema.$defs.McpOptState).toMatchObject({
        type: 'string',
        enum: ['OPEN', 'CLOSED'],
      });
    });

    it('does not exclude fields from the selection set when their NonNull args have defaults', () => {
      // label(upper: Boolean! = false) is freely selectable without arguments.
      expect(getOperation('decor')).toContain('label');
    });
  });

  // --- getOperation -----------------------------------------------------------------
  describe('getOperation', () => {
    it('throws MCP_TOOL_NOT_FOUND for an unknown tool name', () => {
      const { getOperation } = simfinity.generateMCPTools(stubSchema);
      let error;
      try {
        getOperation('definitely-not-a-tool');
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.extensions.code).toBe('MCP_TOOL_NOT_FOUND');
    });
  });
});

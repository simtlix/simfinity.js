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
  GraphQLFloat,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
} from 'graphql';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import * as simfinity from '../packages/mongodb/src/index.js';
import { createRuntime } from '../packages/core/src/index.js';

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

  // A type whose only field requires an argument: no leaf is selectable, so
  // the generated document falls back to __typename.
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

    it('selectionDepth 2 expands two nesting levels in the document', () => {
      const { getOperation } = simfinity.generateMCPTools(nestedSchema, { selectionDepth: 2 });
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

    it('falls back to __typename when no leaf is selectable (an id with required args) (guard)', () => {
      const { getOperation, tools } = simfinity.generateMCPTools(nestedSchema);
      expect(getOperation('gated')).toContain('gated { __typename }');
      expect(tools.find((tool) => tool.name === 'gated').outputSchema.properties.gated.properties)
        .toEqual({ __typename: { type: 'string' } });
    });

    it('accepts the deprecated includeId without changing selections or output schemas (guard)', () => {
      const ColorEnum = new GraphQLEnumType({ name: 'McpOptIdColor', values: { RED: {} } });
      const Opaque = new GraphQLScalarType({ name: 'McpOptOpaqueId', serialize: (value) => value });
      const idOf = (name, type, args) => new GraphQLObjectType({ name, fields: { id: { type, args } } });
      const idSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            enumId: { type: idOf('McpOptEnumId', ColorEnum) },
            listId: { type: idOf('McpOptListId', new GraphQLList(GraphQLString)) },
            opaqueId: { type: idOf('McpOptOpaqueIdHolder', Opaque) },
            defaultedArgId: {
              type: idOf('McpOptDefaultedArgId', GraphQLString, { upper: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false } }),
            },
            parent: { type: ParentType },
            gated: { type: GatedType },
          },
        }),
      });
      const snapshot = (options) => {
        const { tools, getOperation } = simfinity.generateMCPTools(idSchema, options);
        return tools.map((tool) => [getOperation(tool.name), tool.outputSchema]);
      };
      const base = snapshot({});
      expect(snapshot({ includeId: true })).toEqual(base);
      expect(snapshot({ includeId: false })).toEqual(base);
      expect(snapshot({
        toolOverrides: Object.fromEntries(['enumId', 'listId', 'opaqueId', 'defaultedArgId', 'parent', 'gated']
          .map((name) => [name, { includeId: false }])),
      })).toEqual(base);
      const documents = base.map(([operation]) => operation).join('\n');
      expect(documents).toContain('enumId { id }');
      expect(documents).toContain('listId { id }');
      expect(documents).toContain('opaqueId { id }');
      expect(documents).toContain('defaultedArgId { id }');
      expect(documents).toContain('gated { __typename }');
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
          // No description at all: a name prefix alone never makes a CRUD tool.
          addFallback: { type: OrderType, resolve: () => null },
          updateFallback: { type: OrderType, resolve: () => null },
          deleteFallback: {
            type: OrderType,
            args: { input: { type: GraphQLString } },
            resolve: () => null,
          },
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

    it.each(['addFallback', 'updateFallback', 'deleteFallback'])('treats the description-less %s as custom', (name) => {
      const custom = tools.find((tool) => tool.name === name);
      expect(custom.title).toBe(name);
      expect(custom.description).toBe(`Execute the \`${name}\` operation.`);
      expect(custom.annotations).toEqual({ title: name, openWorldHint: false, readOnlyHint: false });
    });
  });

  // --- custom root queries -------------------------------------------------------
  describe('custom root queries', () => {
    const UserType = new GraphQLObjectType({
      name: 'McpOptUser',
      description: 'A user.',
      fields: () => ({
        id: { type: GraphQLString },
        name: { type: GraphQLString },
      }),
    });
    const UserPagination = new GraphQLInputObjectType({
      name: 'McpOptUserPagination',
      fields: () => ({ page: { type: GraphQLInt }, size: { type: GraphQLInt } }),
    });
    const users = [{ id: 'u1', name: 'Me' }, { id: 'u2', name: 'Other' }];
    const querySchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          currentUser: { type: UserType, resolve: () => users[0] },
          recentUsers: { type: new GraphQLList(UserType), resolve: () => users },
          userCount: { type: GraphQLInt, resolve: () => users.length },
          user: {
            type: UserType,
            args: { id: { type: GraphQLString } },
            resolve: (parent, args) => users.find((candidate) => candidate.id === args.id) || null,
          },
          pagedUsers: {
            type: new GraphQLList(UserType),
            args: { pagination: { type: UserPagination } },
            resolve: () => users,
          },
        },
      }),
    });
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(querySchema));
    });

    it('publishes a query without id or pagination as a read-only tool titled by its field', () => {
      const current = tools.find((tool) => tool.name === 'currentUser');
      expect(current.title).toBe('currentUser');
      expect(current.description).toBe('Run the read-only `currentUser` query. Returns McpOptUser data. A user.');
      expect(current.annotations).toEqual({ title: 'currentUser', openWorldHint: false, readOnlyHint: true });

      const recent = tools.find((tool) => tool.name === 'recentUsers');
      expect(recent.title).toBe('recentUsers');
      expect(recent.description).toBe('Run the read-only `recentUsers` query. Returns McpOptUser data. A user.');
      expect(recent.description).not.toContain('pagination');
      expect(recent.annotations.readOnlyHint).toBe(true);
      expect(recent.outputSchema.properties).not.toHaveProperty('totalCount');

      const count = tools.find((tool) => tool.name === 'userCount');
      expect(count.title).toBe('userCount');
      expect(count.description).toBe('Run the read-only `userCount` query.');
    });

    it('keeps get-by-id and paginated list tools for queries with those arguments (guard)', () => {
      const single = tools.find((tool) => tool.name === 'user');
      expect(single.title).toBe('Get McpOptUser');
      expect(single.description).toContain('Fetch a single McpOptUser by id');

      const paged = tools.find((tool) => tool.name === 'pagedUsers');
      expect(paged.title).toBe('List McpOptUser');
      expect(paged.description).toContain('pagination (page/size)');
      expect(paged.outputSchema.properties).toHaveProperty('totalCount');
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

    const dateTimeNote = (name) => `Date/time value; its JSON form is defined by the server's ${name} scalar (commonly an ISO 8601 string).`;

    it('publishes Date-like output scalars without a type or format, with a curated description (incl. baseScalarType)', () => {
      // Their serialize decides the JSON form (ISO instant, epoch millis,
      // 'YYYY-MM-DD'...), so a format would make SDK clients reject results.
      expect(eventProps.day).toEqual({ description: dateTimeNote('Date') });
      expect(eventProps.at).toEqual({ description: dateTimeNote('DateTime') });
      expect(eventProps.slot).toEqual({ description: dateTimeNote('McpOptValidatedTime') });
    });

    it('publishes a primitive output type only for scalars that serialize through a spec scalar', async () => {
      // A storage hint does not make serialize return the hinted type.
      const Decimal = new GraphQLScalarType({
        name: 'McpOptDecimal',
        description: 'Fixed-point amount.',
        serialize: (value) => Number(value).toFixed(2),
        parseValue: (value) => value,
      });
      Decimal.baseScalarType = GraphQLFloat;
      const noCheck = () => {};
      const Price = simfinity.createValidatedScalar('McpOptPrice', 'A price.', Decimal, noCheck);
      const Count = simfinity.createValidatedScalar('McpOptCount', 'A count.', GraphQLInt, noCheck);
      const Due = simfinity.createValidatedScalar('McpOptDue', undefined, eventSchema.getType('Date'), noCheck);
      const Amount = new GraphQLScalarType({ name: 'McpOptAmount', serialize: (value) => value });
      // Copying a validated scalar's base by hand does not make it one.
      Amount.baseScalarType = Count;
      const Line = new GraphQLObjectType({
        name: 'McpOptLine',
        fields: {
          amount: { type: new GraphQLNonNull(Decimal) },
          price: { type: Price },
          count: { type: new GraphQLNonNull(Count) },
          due: { type: Due },
          dues: { type: new GraphQLList(Due) },
          hinted: { type: Amount },
        },
      });
      const lineSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            line: {
              type: Line,
              args: { amount: { type: Decimal }, price: { type: Price } },
              resolve: () => ({
                amount: 12.3, price: 4, count: 2, due: '2026-09-28', dues: [], hinted: 'x',
              }),
            },
          },
        }),
      });
      const { tools, callTool } = simfinity.generateMCPTools(lineSchema);
      const line = tools.find((tool) => tool.name === 'line');
      const props = line.outputSchema.properties.line.properties;
      expect(props.amount).toEqual({ description: 'Fixed-point amount.' });
      expect(props.price).toEqual({ description: 'A price.' });
      expect(props.count).toEqual({ type: 'integer', description: 'A count.' });
      expect(props.due).toEqual({ description: dateTimeNote('McpOptDue_Date') });
      expect(props.dues).toEqual({ type: ['array', 'null'], items: { description: dateTimeNote('McpOptDue_Date') } });
      expect(props.hinted).toEqual({});
      // Input schemas keep following the storage hint.
      expect(line.inputSchema.properties.amount).toEqual({ type: ['number', 'null'], description: 'Fixed-point amount.' });
      expect(line.inputSchema.properties.price).toEqual({ type: ['number', 'null'], description: 'A price.' });

      const result = await callTool('line', {});
      expect(result.structuredContent.line).toMatchObject({ amount: '12.30', price: '4.00' });
      const validate = new AjvJsonSchemaValidator().getValidator(line.outputSchema);
      expect(validate(result.structuredContent)).toMatchObject({ valid: true });
    });

    it('accepts null at nullable input positions', () => {
      expect(eventTool.inputSchema.properties.on).toEqual({ type: ['string', 'null'], format: 'date' });

      const { tools } = simfinity.generateMCPTools(stubSchema);
      const add = tools.find((tool) => tool.name === 'addItem');
      expect(add.inputSchema.$defs.McpOptStubInput.properties.nickname).toEqual({ type: ['string', 'null'] });
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
      expect(search.inputSchema.properties.limit).toMatchObject({ type: ['integer', 'null'], default: 10 });
      // NonNull arg with a default is still optional for the caller.
      expect(search.inputSchema.properties.mode).toMatchObject({ type: 'string', default: 'fast' });
      expect(search.inputSchema.required).toBeUndefined();
    });

    it('applies the same rule to input object fields', () => {
      const search = tools.find((tool) => tool.name === 'search');
      const prefs = search.inputSchema.$defs.McpOptPrefs;
      expect(prefs.properties.compact).toMatchObject({ type: ['boolean', 'null'], default: true });
      expect(prefs.required).toEqual(['theme']);
    });

    it('emits enum defaults as the member NAME (external value), not the internal value', () => {
      const search = tools.find((tool) => tool.name === 'search');
      // Argument-level enum default: internal 1 -> external name 'OPEN'.
      expect(search.inputSchema.properties.state).toMatchObject({
        anyOf: [{ $ref: '#/$defs/McpOptState' }, { type: 'null' }],
        default: 'OPEN',
      });
      // Input-object-field enum default: internal 2 -> external name 'CLOSED'.
      expect(search.inputSchema.$defs.McpOptPrefs.properties.state).toMatchObject({
        anyOf: [{ $ref: '#/$defs/McpOptState' }, { type: 'null' }],
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

// ---------------------------------------------------------------------------
// Schemas generated by core runtimes over an in-memory adapter.
// ---------------------------------------------------------------------------

describe('MCP operation classification of core-generated schemas', () => {
  const createMemoryAdapter = () => {
    const records = new Map();
    let nextId = 1;
    return {
      bind() {},
      prepare() {},
      createModel: (gqltype) => ({ name: gqltype.name }),
      castId: (value) => String(value),
      withTransaction: async (session, body) => body(session || { adapter: 'memory' }),
      newRecord: (Model, data) => ({ ...data, _id: String(nextId++), model: Model.name }),
      async saveRecord(Model, record) {
        records.set(record._id, record);
        return record;
      },
      toObject: (record) => ({ ...record }),
      async getById(Model, id) { return records.get(String(id)) || null; },
      prepareUpdate: (set, unset) => ({ set, unset }),
      async update(Model, id, update) {
        const current = records.get(String(id));
        for (const key of Object.keys(update.unset)) delete current[key];
        Object.assign(current, update.set);
        return current;
      },
      async delete(Model, id) {
        const record = records.get(String(id)) || null;
        records.delete(String(id));
        return record;
      },
      async find() { return [...records.values()]; },
      async count() { return records.size; },
      async aggregate() { return []; },
      async findChildren() { return []; },
      rows: (modelName) => [...records.values()].filter((record) => record.model === modelName),
    };
  };

  const DRAFT = { name: 'DRAFT', value: 'DRAFT' };
  const PUBLISHED = { name: 'PUBLISHED', value: 'PUBLISHED' };
  const DISCARDED = { name: 'DISCARDED', value: 'DISCARDED' };
  const ARCHIVED = { name: 'ARCHIVED', value: 'ARCHIVED' };

  // A state machine whose description-less actions start with add/update/
  // delete, plus custom mutations named like CRUD (the shapes the removed
  // scripts/repro-mcp.mjs printed).
  const buildDocs = () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const DocType = new GraphQLObjectType({
      name: 'McpOptDoc',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        state: { type: GraphQLString },
      }),
    });
    const CreditsInput = new GraphQLInputObjectType({
      name: 'McpOptCreditsInput',
      fields: () => ({ amount: { type: GraphQLInt } }),
    });
    runtime.connect(null, DocType, 'mcpoptdoc', 'mcpoptdocs', null, null, {
      initialState: DRAFT,
      actions: {
        deleteDraft: { from: DRAFT, to: DISCARDED },
        updateStatus: { from: DRAFT, to: PUBLISHED },
        addToArchive: { from: PUBLISHED, to: ARCHIVED },
        publish: { from: DRAFT, to: PUBLISHED, description: 'Publish the doc' },
      },
    });
    runtime.registerMutation('deleteExpiredDocs', undefined, null, DocType, async () => null);
    runtime.registerMutation('updateStats', 'update', null, DocType, async () => null);
    runtime.registerMutation('addCredits', 'add', CreditsInput, DocType, async () => null);
    return { adapter, schema: runtime.createSchema() };
  };

  const byName = (tools, name) => tools.find((tool) => tool.name === name);

  it('tags generated mutation fields with extensions.simfinityMutation', () => {
    const { schema } = buildDocs();
    const mutations = schema.getMutationType().getFields();
    const marker = (name) => mutations[name].extensions.simfinityMutation;

    expect(marker('addmcpoptdoc')).toEqual({ typeName: 'McpOptDoc', operation: 'save' });
    expect(marker('updatemcpoptdoc')).toEqual({ typeName: 'McpOptDoc', operation: 'update' });
    expect(marker('deletemcpoptdoc')).toEqual({ typeName: 'McpOptDoc', operation: 'delete' });
    expect(marker('deleteDraft_mcpoptdoc')).toEqual({
      typeName: 'McpOptDoc', operation: 'state_changed', action: 'deleteDraft', from: 'DRAFT', to: 'DISCARDED',
    });
    expect(marker('deleteExpiredDocs')).toEqual({ operation: 'custom_mutation' });
    expect(marker('addCredits')).toEqual({ operation: 'custom_mutation' });
    // The get-by-id query stays unmarked: core auth reads simfinityQuery.
    expect(schema.getQueryType().getFields().mcpoptdoc.extensions.simfinityQuery).toBeUndefined();
  });

  it('publishes state-machine actions as transitions, not CRUD', async () => {
    const { adapter, schema } = buildDocs();
    const { tools, callTool } = simfinity.generateMCPTools(schema);

    const discard = byName(tools, 'deleteDraft_mcpoptdoc');
    expect(discard.title).toBe('deleteDraft_mcpoptdoc');
    expect(discard.title).not.toBe(byName(tools, 'deletemcpoptdoc').title);
    expect(discard.description).toBe('Apply the `deleteDraft` state transition to an existing McpOptDoc. '
      + 'It is allowed only while the McpOptDoc is in state DRAFT and moves it to DISCARDED. '
      + 'Provide `input` with the record\'s `id`; other fields in `input` are updated too. Returns the updated McpOptDoc.');
    expect(discard.annotations).toEqual({ title: 'deleteDraft_mcpoptdoc', openWorldHint: false, readOnlyHint: false });

    const status = byName(tools, 'updateStatus_mcpoptdoc');
    expect(status.title).toBe('updateStatus_mcpoptdoc');
    expect(status.annotations).not.toHaveProperty('idempotentHint');
    expect(status.description).toContain('Apply the `updateStatus` state transition');

    const archive = byName(tools, 'addToArchive_mcpoptdoc');
    expect(archive.description).not.toContain('Create a new');
    expect(archive.description).toContain('in state PUBLISHED and moves it to ARCHIVED');

    const publish = byName(tools, 'publish_mcpoptdoc');
    expect(publish.title).toBe('publish_mcpoptdoc');
    expect(publish.description).toBe('Publish the doc');

    // The description holds: the action checks the state and updates the
    // other input fields too.
    const created = await callTool('addmcpoptdoc', { input: { title: 'Draft' } });
    const { id } = created.structuredContent.addmcpoptdoc;
    const first = await callTool('deleteDraft_mcpoptdoc', { input: { id, title: 'Gone' } });
    expect(first.isError).toBe(false);
    expect(first.structuredContent.deleteDraft_mcpoptdoc).toMatchObject({ id, title: 'Gone', state: 'DISCARDED' });
    expect(adapter.rows('McpOptDoc')).toHaveLength(1);
    const again = await callTool('deleteDraft_mcpoptdoc', { input: { id } });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain('Action is not allowed from state DISCARDED');
  });

  it('classifies registered custom mutations as custom whatever their name and description', () => {
    const { tools } = simfinity.generateMCPTools(buildDocs().schema);

    for (const name of ['deleteExpiredDocs', 'updateStats', 'addCredits']) {
      const custom = byName(tools, name);
      expect(custom.title).toBe(name);
      expect(custom.description).toBe(`Execute the \`${name}\` operation.`);
      expect(custom.annotations).toEqual({ title: name, openWorldHint: false, readOnlyHint: false });
    }
  });

  it('keeps CRUD tools and makes description-less actions custom without the simfinityMutation marker', () => {
    // Schemas rebuilt from SDL or introspection, or built by an older core,
    // carry no extensions.
    const { schema } = buildDocs();
    for (const field of Object.values(schema.getMutationType().getFields())) {
      const { simfinityMutation, ...rest } = field.extensions;
      expect(simfinityMutation).toBeDefined();
      field.extensions = rest;
    }
    const { tools } = simfinity.generateMCPTools(schema);

    expect(byName(tools, 'addmcpoptdoc').title).toBe('Create McpOptDoc');
    expect(byName(tools, 'addmcpoptdoc').description).toContain('Create a new McpOptDoc');
    expect(byName(tools, 'updatemcpoptdoc').title).toBe('Update McpOptDoc');
    expect(byName(tools, 'updatemcpoptdoc').annotations.idempotentHint).toBe(true);
    expect(byName(tools, 'deletemcpoptdoc').annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });

    for (const name of ['deleteDraft_mcpoptdoc', 'updateStatus_mcpoptdoc', 'addToArchive_mcpoptdoc', 'deleteExpiredDocs']) {
      const custom = byName(tools, name);
      expect(custom.title).toBe(name);
      expect(custom.description).toBe(`Execute the \`${name}\` operation.`);
      expect(custom.annotations).toEqual({ title: name, openWorldHint: false, readOnlyHint: false });
    }
    expect(byName(tools, 'publish_mcpoptdoc').description).toBe('Publish the doc');
    // Residual edge: without the marker, a custom mutation described with the
    // placeholder and named with the matching prefix still reads as CRUD.
    expect(byName(tools, 'addCredits').title).toBe('Create McpOptDoc');
    expect(byName(tools, 'updateStats').title).toBe('Update McpOptDoc');
  });

  describe('update idempotency', () => {
    const buildShipments = () => {
      const adapter = createMemoryAdapter();
      const runtime = createRuntime(adapter);
      const LineType = new GraphQLObjectType({
        name: 'McpOptShipLine',
        fields: () => ({
          id: { type: GraphQLID },
          sku: { type: GraphQLString },
          shipment: { type: ShipmentType, extensions: { relation: { embedded: false, connectionField: 'shipment' } } },
        }),
      });
      const ShipmentType = new GraphQLObjectType({
        name: 'McpOptShipment',
        fields: () => ({
          id: { type: GraphQLID },
          carrier: { type: GraphQLString },
          lines: { type: new GraphQLList(LineType), extensions: { relation: { embedded: false, connectionField: 'shipment' } } },
        }),
      });
      runtime.connect(null, LineType, 'mcpoptshipline', 'mcpoptshiplines');
      runtime.connect(null, ShipmentType, 'mcpoptshipment', 'mcpoptshipments');
      return { adapter, schema: runtime.createSchema() };
    };

    it('does not advertise a generated update as idempotent when its input can add collection items', async () => {
      const { adapter, schema } = buildShipments();
      const { tools, callTool } = simfinity.generateMCPTools(schema);
      const update = byName(tools, 'updatemcpoptshipment');

      const collection = Object.entries(update.inputSchema.$defs).find(([key]) => key.startsWith('OneToMany'));
      expect(collection[1].properties).toHaveProperty('added');
      expect(update.annotations).toEqual({
        title: 'Update McpOptShipment', openWorldHint: false, readOnlyHint: false, idempotentHint: false,
      });

      // Why: an identical repeat inserts the `added` items again.
      const created = await callTool('addmcpoptshipment', { input: { carrier: 'C' } });
      const { id } = created.structuredContent.addmcpoptshipment;
      const args = { input: { id, lines: { added: [{ sku: 'SKU-1' }] } } };
      expect((await callTool('updatemcpoptshipment', args)).isError).toBe(false);
      expect((await callTool('updatemcpoptshipment', args)).isError).toBe(false);
      expect(adapter.rows('McpOptShipLine').filter((row) => row.sku === 'SKU-1')).toHaveLength(2);
    });

    it('keeps updates without collection inputs and deletes idempotent (guard)', () => {
      const { tools } = simfinity.generateMCPTools(buildShipments().schema);
      // The line's parent reference is an id input, which adds nothing.
      expect(byName(tools, 'updatemcpoptshipline').annotations.idempotentHint).toBe(true);
      expect(byName(tools, 'deletemcpoptshipment').annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
      expect(byName(tools, 'addmcpoptshipment').annotations).toEqual({
        title: 'Create McpOptShipment', openWorldHint: false, readOnlyHint: false,
      });
    });

    it('finds nested added lists and stops at recursive input types', () => {
      const ItemType = new GraphQLObjectType({ name: 'McpOptNestItem', fields: () => ({ id: { type: GraphQLString } }) });
      const NoteInput = new GraphQLInputObjectType({ name: 'McpOptNestNote', fields: () => ({ text: { type: GraphQLString } }) });
      const NotesInput = new GraphQLInputObjectType({
        name: 'McpOptNestNotes',
        fields: () => ({ added: { type: new GraphQLList(NoteInput) }, deleted: { type: new GraphQLList(GraphQLID) } }),
      });
      const DeepInput = new GraphQLInputObjectType({
        name: 'McpOptNestDeep',
        fields: () => ({ id: { type: GraphQLID }, meta: { type: new GraphQLNonNull(MetaInput) } }),
      });
      const MetaInput = new GraphQLInputObjectType({
        name: 'McpOptNestMeta',
        fields: () => ({ parent: { type: DeepInput }, notes: { type: new GraphQLList(NotesInput) } }),
      });
      const TreeInput = new GraphQLInputObjectType({
        name: 'McpOptNestTree',
        fields: () => ({ id: { type: GraphQLID }, children: { type: new GraphQLList(TreeInput) }, added: { type: GraphQLString } }),
      });
      const nestSchema = new GraphQLSchema({
        query: new GraphQLObjectType({ name: 'Query', fields: { ping: { type: GraphQLString } } }),
        mutation: new GraphQLObjectType({
          name: 'Mutation',
          fields: {
            updateDeep: { type: ItemType, description: 'update', args: { input: { type: new GraphQLNonNull(DeepInput) } } },
            // Recursive, and its `added` is a scalar, not a list of items.
            updateTree: { type: ItemType, description: 'update', args: { input: { type: TreeInput } } },
          },
        }),
      });
      const { tools } = simfinity.generateMCPTools(nestSchema);
      expect(byName(tools, 'updateDeep').annotations.idempotentHint).toBe(false);
      expect(byName(tools, 'updateTree').annotations.idempotentHint).toBe(true);
    });
  });

  describe('collection inputs that form a cycle across types', () => {
    const buildDepartments = () => {
      const runtime = createRuntime(createMemoryAdapter());
      const relation = (connectionField) => ({ relation: { embedded: false, connectionField } });
      const Department = new GraphQLObjectType({
        name: 'McpOptCycDepartment',
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          manager: { type: Employee, extensions: relation('manager') },
          employees: { type: new GraphQLList(new GraphQLNonNull(Employee)), extensions: relation('department') },
        }),
      });
      const Employee = new GraphQLObjectType({
        name: 'McpOptCycEmployee',
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          department: { type: Department, extensions: relation('department') },
          managedDepartments: { type: new GraphQLList(Department), extensions: relation('manager') },
        }),
      });
      runtime.connect(null, Department, 'mcpoptcycdepartment', 'mcpoptcycdepartments');
      runtime.connect(null, Employee, 'mcpoptcycemployee', 'mcpoptcycemployees');
      return runtime.createSchema();
    };

    it('describes nested inputs through the cycle and nullable deleted IDs', () => {
      const { tools } = simfinity.generateMCPTools(buildDepartments());
      const add = byName(tools, 'addmcpoptcycdepartment');
      const defs = add.inputSchema.$defs;
      expect(Object.keys(defs)).toEqual(expect.arrayContaining([
        'OneToManyMcpOptCycDepartmentAemployees',
        'McpOptCycDepartmentAMcpOptCycEmployeeInputForDepartment',
        'OneToManyMcpOptCycEmployeeAmanagedDepartments',
        'McpOptCycEmployeeAMcpOptCycDepartmentInputForManager',
      ]));
      expect(defs.McpOptCycEmployeeAMcpOptCycDepartmentInputForManager.properties.employees).toEqual({
        anyOf: [{ $ref: '#/$defs/OneToManyMcpOptCycDepartmentAemployees' }, { type: 'null' }],
      });
      // `[McpOptCycEmployee!]` items, yet null IDs in `deleted` are accepted and skipped.
      expect(defs.OneToManyMcpOptCycDepartmentAemployees.properties.deleted)
        .toEqual({ type: ['array', 'null'], items: { type: ['string', 'null'] } });

      const validate = new AjvJsonSchemaValidator().getValidator(add.inputSchema);
      expect(validate({
        input: {
          name: 'D1',
          employees: {
            added: [{ name: 'E1', managedDepartments: { added: [{ name: 'D2', employees: { added: [{ name: 'E2' }] } }] } }],
            deleted: ['1', null],
          },
        },
      })).toMatchObject({ valid: true });
      expect(byName(tools, 'updatemcpoptcycemployee').annotations.idempotentHint).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Nested collections and shared $defs (core runtimes over a counting
// in-memory adapter; each call is a database round trip on a real backend).
// ---------------------------------------------------------------------------

describe('MCP nested collections and $defs of core-generated schemas', () => {
  const countingAdapter = (data, counts) => ({
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: (value) => String(value),
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) {
      counts.getById += 1;
      return (data[Model.name] || []).find((row) => row._id === String(id)) || null;
    },
    async getByIds(Model, ids) {
      counts.getByIds += 1;
      return (data[Model.name] || []).filter((row) => ids.map(String).includes(row._id));
    },
    async find(Model, gqltype, args) {
      counts.find += 1;
      const rows = data[Model.name] || [];
      const page = args.pagination;
      return page ? rows.slice((page.page - 1) * page.size, page.page * page.size) : rows;
    },
    async count(Model) { return (data[Model.name] || []).length; },
    async aggregate() { return []; },
    async findChildren(Model, gqltype, connectionField, parentId) {
      counts.findChildren += 1;
      return (data[Model.name] || []).filter((row) => row[connectionField] === String(parentId));
    },
  });

  // A shop with a to-one owner and three referenced collections.
  const buildShops = ({ shops = 4, perCollection = 3 } = {}) => {
    const counts = {
      find: 0, findChildren: 0, getById: 0, getByIds: 0,
    };
    const data = {
      McpOptNcOwner: [], McpOptNcShop: [], McpOptNcService: [], McpOptNcReview: [], McpOptNcBooking: [],
    };
    for (let o = 0; o < 2; o += 1) data.McpOptNcOwner.push({ _id: `o${o}`, id: `o${o}`, name: `Owner ${o}` });
    for (let s = 0; s < shops; s += 1) {
      data.McpOptNcShop.push({
        _id: `s${s}`, id: `s${s}`, name: `Shop ${s}`, city: 'Montevideo', owner: `o${s % 2}`,
      });
      for (let c = 0; c < perCollection; c += 1) {
        data.McpOptNcService.push({
          _id: `sv${s}-${c}`, id: `sv${s}-${c}`, name: `Cut ${c}`, price: 10 + c, shop: `s${s}`,
        });
        data.McpOptNcReview.push({
          _id: `rv${s}-${c}`, id: `rv${s}-${c}`, text: `Review ${c}`, stars: 5, shop: `s${s}`,
        });
        data.McpOptNcBooking.push({
          _id: `bk${s}-${c}`, id: `bk${s}-${c}`, day: `2026-10-${10 + c}`, shop: `s${s}`,
        });
      }
    }
    const runtime = createRuntime(countingAdapter(data, counts));
    const relation = (connectionField) => ({ relation: { embedded: false, connectionField } });
    const Owner = new GraphQLObjectType({
      name: 'McpOptNcOwner',
      fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString } }),
    });
    const Service = new GraphQLObjectType({
      name: 'McpOptNcService',
      fields: () => ({
        id: { type: GraphQLID }, name: { type: GraphQLString }, price: { type: GraphQLInt }, shop: { type: Shop, extensions: relation('shop') },
      }),
    });
    const Review = new GraphQLObjectType({
      name: 'McpOptNcReview',
      fields: () => ({
        id: { type: GraphQLID }, text: { type: GraphQLString }, stars: { type: GraphQLInt }, shop: { type: Shop, extensions: relation('shop') },
      }),
    });
    const Booking = new GraphQLObjectType({
      name: 'McpOptNcBooking',
      fields: () => ({ id: { type: GraphQLID }, day: { type: GraphQLString }, shop: { type: Shop, extensions: relation('shop') } }),
    });
    const Shop = new GraphQLObjectType({
      name: 'McpOptNcShop',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        city: { type: GraphQLString },
        owner: { type: Owner, extensions: relation('owner') },
        services: { type: new GraphQLList(Service), extensions: relation('shop') },
        reviews: { type: new GraphQLList(Review), extensions: relation('shop') },
        bookings: { type: new GraphQLList(Booking), extensions: relation('shop') },
      }),
    });
    for (const [type, name] of [[Owner, 'mcpoptncowner'], [Service, 'mcpoptncservice'], [Review, 'mcpoptncreview'], [Booking, 'mcpoptncbooking'], [Shop, 'mcpoptncshop']]) {
      runtime.connect(null, type, name, `${name}s`);
    }
    return { schema: runtime.createSchema(), counts };
  };

  // Entities whose collection inputs form a chain: E0.children -> E1 -> ...
  const buildChain = (n) => {
    const runtime = createRuntime(countingAdapter({}, {}));
    const relation = (connectionField) => ({ relation: { embedded: false, connectionField } });
    const Status = new GraphQLEnumType({ name: 'McpOptChainStatus', values: { ON: { value: 'ON' }, OFF: { value: 'OFF' } } });
    const types = [];
    for (let i = 0; i < n; i += 1) {
      const index = i;
      types.push(new GraphQLObjectType({
        name: `McpOptChain${index}`,
        fields: () => {
          const fields = {
            id: { type: GraphQLID },
            name: { type: new GraphQLNonNull(GraphQLString), description: `Name of entity ${index}` },
            status: { type: Status },
          };
          if (index > 0) fields.parent = { type: types[index - 1], extensions: relation('parent') };
          if (index < n - 1) fields.children = { type: new GraphQLList(types[index + 1]), extensions: relation('parent') };
          return fields;
        },
      }));
    }
    for (const type of types) runtime.connect(null, type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
    return runtime.createSchema();
  };

  const COLLECTIONS = ['services', 'reviews', 'bookings'];
  const byName = (tools, name) => tools.find((tool) => tool.name === name);
  const rootFields = (schema) => ({ ...schema.getQueryType().getFields(), ...schema.getMutationType()?.getFields() });
  const withoutCollections = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !COLLECTIONS.includes(key)));

  describe('nestedCollections', () => {
    it('omits nested collections from the selection and the outputSchema with nestedCollections: \'none\'', async () => {
      const all = buildShops();
      const none = buildShops();
      const allTools = simfinity.generateMCPTools(all.schema);
      const noneTools = simfinity.generateMCPTools(none.schema, { nestedCollections: 'none' });

      const allResult = await allTools.callTool('mcpoptncshops', {});
      const noneResult = await noneTools.callTool('mcpoptncshops', {});

      expect(all.counts).toEqual({
        find: 1, getByIds: 1, getById: 0, findChildren: 12,
      });
      expect(none.counts).toEqual({
        find: 1, getByIds: 1, getById: 0, findChildren: 0,
      });
      expect(noneResult.isError).toBe(false);
      expect(noneResult.structuredContent.mcpoptncshops).toEqual(allResult.structuredContent.mcpoptncshops.map(withoutCollections));
      expect(noneResult.structuredContent.mcpoptncshops[0]).toEqual({
        id: 's0', name: 'Shop 0', city: 'Montevideo', owner: { id: 'o0', name: 'Owner 0' },
      });
      // Only the selection changes: the collection filter arguments stay.
      expect(noneTools.getOperation('mcpoptncshops')).toBe(allTools.getOperation('mcpoptncshops')
        .replace(' services { id name price } reviews { id text stars } bookings { id day }', ''));
      expect(noneTools.getOperation('mcpoptncshops')).toContain('{ id name city owner { id name } }\n}');

      const items = byName(noneTools.tools, 'mcpoptncshops').outputSchema.properties.mcpoptncshops.items;
      expect(Object.keys(items.properties)).toEqual(['id', 'name', 'city', 'owner']);
      const validate = new AjvJsonSchemaValidator().getValidator(byName(noneTools.tools, 'mcpoptncshops').outputSchema);
      expect(validate(noneResult.structuredContent).valid).toBe(true);
      // The child's back reference is a to-one relation, which stays selected.
      expect(noneTools.getOperation('mcpoptncservices')).toContain('shop { id name city }');
    });

    it('lets toolOverrides.nestedCollections win over the global option, both ways', async () => {
      const { schema, counts } = buildShops();
      const { getOperation, tools, callTool } = simfinity.generateMCPTools(schema, {
        nestedCollections: 'none',
        toolOverrides: { mcpoptncshops: { nestedCollections: 'all' } },
      });
      expect(getOperation('mcpoptncshops')).toContain('services { id name price }');
      expect(getOperation('mcpoptncshop')).not.toContain('services {');
      expect(byName(tools, 'mcpoptncshops').outputSchema.properties.mcpoptncshops.items.properties).toHaveProperty('services');
      expect(byName(tools, 'mcpoptncshop').outputSchema.properties.mcpoptncshop.properties).not.toHaveProperty('services');
      await callTool('mcpoptncshop', { id: 's1' });
      expect(counts.findChildren).toBe(0);

      const reversed = simfinity.generateMCPTools(buildShops().schema, {
        toolOverrides: { mcpoptncshop: { nestedCollections: 'none' } },
      });
      expect(reversed.getOperation('mcpoptncshops')).toContain('services { id name price }');
      expect(reversed.getOperation('mcpoptncshop')).not.toContain('services {');
      // null leaves the tool on the global value.
      const inherited = simfinity.generateMCPTools(buildShops().schema, {
        nestedCollections: 'none',
        toolOverrides: { mcpoptncshop: { nestedCollections: null } },
      });
      expect(inherited.getOperation('mcpoptncshop')).not.toContain('services {');
    });

    it('ignores nestedCollections when a tool has an explicit selection', () => {
      const { getOperation, tools } = simfinity.generateMCPTools(buildShops().schema, {
        nestedCollections: 'none',
        toolOverrides: { mcpoptncshops: { selection: 'id services { id }', nestedCollections: 'none' } },
      });
      expect(getOperation('mcpoptncshops')).toContain('{ id services { id } }');
      expect(byName(tools, 'mcpoptncshops').outputSchema).toBeUndefined();
    });

    it('drops only object lists that take a pagination argument', () => {
      const Page = new GraphQLInputObjectType({ name: 'McpOptNcPage', fields: { page: { type: GraphQLInt }, size: { type: GraphQLInt } } });
      const Leaf = new GraphQLObjectType({ name: 'McpOptNcLeaf', fields: { id: { type: GraphQLString } } });
      const Parent = new GraphQLObjectType({
        name: 'McpOptNcParent',
        fields: {
          id: { type: GraphQLString },
          paged: { type: new GraphQLNonNull(new GraphQLList(Leaf)), args: { pagination: { type: Page } } },
          filtered: { type: new GraphQLList(Leaf), args: { first: { type: GraphQLInt } } },
          embedded: { type: new GraphQLList(Leaf) },
          single: { type: Leaf, args: { pagination: { type: Page } } },
        },
      });
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({ name: 'Query', fields: { parent: { type: Parent } } }),
      });
      const { getOperation, tools } = simfinity.generateMCPTools(schema, { nestedCollections: 'none' });
      expect(getOperation('parent')).toContain('parent { id filtered { id } embedded { id } single { id } }');
      expect(Object.keys(tools[0].outputSchema.properties.parent.properties)).toEqual(['id', 'filtered', 'embedded', 'single']);
    });

    it('keeps the 3.5.9 selection and outputSchema when unset or \'all\' (guard)', () => {
      for (const schema of [buildShops().schema, buildChain(4)]) {
        for (const selectionDepth of [0, 1, 2]) {
          const unset = simfinity.generateMCPTools(schema, { selectionDepth });
          const all = simfinity.generateMCPTools(schema, { selectionDepth, nestedCollections: 'all' });
          const overridden = simfinity.generateMCPTools(schema, {
            selectionDepth,
            nestedCollections: null,
            toolOverrides: Object.fromEntries(unset.tools.map((tool) => [tool.name, { nestedCollections: 'all' }])),
          });
          for (const tool of unset.tools) {
            for (const other of [all, overridden]) {
              expect(other.getOperation(tool.name)).toBe(unset.getOperation(tool.name));
              expect(JSON.stringify(byName(other.tools, tool.name).outputSchema)).toBe(JSON.stringify(tool.outputSchema));
            }
          }
        }
      }
      expect(simfinity.generateMCPTools(buildShops().schema).getOperation('mcpoptncshops').replace(/\s+/g, ' '))
        .toBe('query mcpoptncshopsOperation($id: QLFilter, $name: QLFilter, $city: QLFilter, $owner: QLTypeFilterExpression, '
          + '$services: QLTypeFilterExpression, $reviews: QLTypeFilterExpression, $bookings: QLTypeFilterExpression, '
          + '$pagination: QLPagination, $sort: QLSortExpression, $AND: [QLFilterGroup], $OR: [QLFilterGroup]) { '
          + 'mcpoptncshops(id: $id, name: $name, city: $city, owner: $owner, services: $services, reviews: $reviews, bookings: $bookings, '
          + 'pagination: $pagination, sort: $sort, AND: $AND, OR: $OR) { id name city owner { id name } '
          + 'services { id name price } reviews { id text stars } bookings { id day } } }');
    });

    it.each([
      ['an unknown mode', { nestedCollections: 'some' }, 'nestedCollections must be \'all\' or \'none\', got "some"'],
      ['a bounded page', { nestedCollections: { pageSize: 5 } }, 'nestedCollections must be \'all\' or \'none\', got object'],
      ['a boolean', { nestedCollections: false }, 'nestedCollections must be \'all\' or \'none\', got false'],
      ['an empty string', { nestedCollections: '' }, 'nestedCollections must be \'all\' or \'none\', got ""'],
      ['a published tool override', { toolOverrides: { mcpoptncshops: { nestedCollections: 'None' } } }, 'toolOverrides.mcpoptncshops.nestedCollections must be \'all\' or \'none\', got "None"'],
      ['an excluded tool override', { exclude: ['mcpoptncshop'], toolOverrides: { mcpoptncshop: { nestedCollections: 'bounded' } } }, 'toolOverrides.mcpoptncshop.nestedCollections must be \'all\' or \'none\', got "bounded"'],
      ['a misspelled tool key', { toolOverrides: { mcpoptncshopz: { nestedCollections: 1 } } }, 'toolOverrides.mcpoptncshopz.nestedCollections must be \'all\' or \'none\', got 1'],
      ['an override with a selection', { toolOverrides: { mcpoptncshops: { selection: 'id', nestedCollections: 'nope' } } }, 'toolOverrides.mcpoptncshops.nestedCollections must be \'all\' or \'none\', got "nope"'],
    ])('rejects %s with MCP_INVALID_OPTIONS before any schema plugin runs', (label, options, message) => {
      const { schema } = buildShops();
      const spy = { onSchemaChange: vi.fn() };
      let error;
      try {
        simfinity.generateMCPTools(schema, { ...options, schemaPlugins: [spy] });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(error.extensions).toMatchObject({ code: 'MCP_INVALID_OPTIONS' });
      expect(error.message).toBe(message);
      expect(spy.onSchemaChange).not.toHaveBeenCalled();
    });
  });

  describe('shared $defs', () => {
    const defsOf = (tools) => tools.flatMap((tool) => Object.entries(tool.inputSchema.$defs || {}));

    it('publishes quantified descriptions consistently in shared and standalone definitions', () => {
      const schema = buildShops().schema;
      const fields = schema.getQueryType().getFields();
      const { tools } = simfinity.generateMCPTools(schema);
      for (const name of ['mcpoptncshops', 'mcpoptncshops_aggregate']) {
        const shared = byName(tools, name);
        const standalone = simfinity.graphqlArgsToJSONSchema(fields[name]);
        expect(shared.description).toContain('nested AND/OR and ANY/ALL/NONE filter groups');
        expect(shared.description).toContain('queryFeatures.quantifiers');
        for (const defs of [shared.inputSchema.$defs, standalone.$defs]) {
          expect(defs.QLQuantifier.description).toContain('ALL and NONE hold when there are no visible elements');
          expect(defs.QLQuantifiedGroup.description).toContain('same element');
          expect(defs.QLQuantifiedGroup.properties.path.description).toContain('relative to the containing element');
          expect(defs.QLFilterGroup.description).toContain('ANY/ALL/NONE');
        }
      }
    });

    it('builds each input or enum def once per tool set', () => {
      for (const schema of [buildShops().schema, buildChain(5)]) {
        const defs = defsOf(simfinity.generateMCPTools(schema).tools);
        const names = new Set(defs.map(([name]) => name));
        expect(defs.length).toBeGreaterThan(names.size);
        expect(new Set(defs.map(([, def]) => def)).size).toBe(names.size);
      }
    });

    it('publishes the inputSchema graphqlArgsToJSONSchema builds for each tool, key order included (guard)', () => {
      const Mood = new GraphQLEnumType({ name: 'McpOptDefsMood', values: { UP: { value: 1 }, DOWN: { value: 2 } } });
      const Tree = new GraphQLInputObjectType({
        name: 'McpOptDefsTree',
        fields: () => ({
          label: { type: GraphQLString, defaultValue: 'root' },
          mood: { type: Mood, defaultValue: 2 },
          children: { type: new GraphQLList(new GraphQLNonNull(Tree)) },
          sibling: { type: Pair },
        }),
      });
      const Pair = new GraphQLInputObjectType({
        name: 'McpOptDefsPair',
        fields: () => ({ left: { type: Tree }, right: { type: new GraphQLNonNull(Mood) } }),
      });
      const stub = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            one: { type: GraphQLString, args: { mood: { type: Mood }, tree: { type: Tree } } },
            two: { type: GraphQLString, args: { pair: { type: new GraphQLNonNull(Pair) }, tree: { type: Tree } } },
            three: { type: GraphQLString, args: { moods: { type: new GraphQLList(Mood), defaultValue: [1] } } },
          },
        }),
      });
      for (const schema of [buildShops().schema, buildChain(5), stub]) {
        const fields = rootFields(schema);
        const { tools } = simfinity.generateMCPTools(schema);
        expect(tools.length).toBeGreaterThan(2);
        for (const tool of tools) {
          expect(JSON.stringify(tool.inputSchema)).toBe(JSON.stringify(simfinity.graphqlArgsToJSONSchema(fields[tool.name])));
        }
      }

      // graphqlArgsToJSONSchema shares collect with the tools, so pin what
      // 3.5.9 published too (one $defs map per tool, filled by ensureInputDef).
      const defKeys = (tools, names) => names.map((name) => Object.keys(byName(tools, name).inputSchema.$defs));
      const stubTools = simfinity.generateMCPTools(stub).tools;
      expect(defKeys(stubTools, ['one', 'two', 'three'])).toEqual([
        ['McpOptDefsMood', 'McpOptDefsTree', 'McpOptDefsPair'],
        ['McpOptDefsPair', 'McpOptDefsTree', 'McpOptDefsMood'],
        ['McpOptDefsMood'],
      ]);
      expect(JSON.stringify(byName(stubTools, 'two').inputSchema)).toBe(
        '{"type":"object","properties":{"pair":{"$ref":"#/$defs/McpOptDefsPair"},"tree":{"anyOf":[{"$ref":"#/$defs/McpOptDefsTree"},{"type":"null"}]}},'
        + '"additionalProperties":false,"required":["pair"],"$defs":{'
        + '"McpOptDefsPair":{"type":"object","properties":{"left":{"anyOf":[{"$ref":"#/$defs/McpOptDefsTree"},{"type":"null"}]},"right":{"$ref":"#/$defs/McpOptDefsMood"}},"required":["right"]},'
        + '"McpOptDefsTree":{"type":"object","properties":{"label":{"type":["string","null"],"default":"root"},'
        + '"mood":{"anyOf":[{"$ref":"#/$defs/McpOptDefsMood"},{"type":"null"}],"default":"DOWN"},'
        + '"children":{"type":["array","null"],"items":{"$ref":"#/$defs/McpOptDefsTree"}},'
        + '"sibling":{"anyOf":[{"$ref":"#/$defs/McpOptDefsPair"},{"type":"null"}]}}},'
        + '"McpOptDefsMood":{"type":"string","enum":["UP","DOWN"]}}}',
      );
      expect(defKeys(simfinity.generateMCPTools(buildChain(5)).tools, ['mcpoptchain0s', 'addmcpoptchain3'])).toEqual([
        ['QLFilter', 'QLOperator', 'QLTypeFilterExpression', 'QLTypeFilter', 'QLQuantifier', 'QLPagination', 'QLSortExpression', 'QLSort',
          'QLSortOrder', 'QLFilterGroup', 'QLQuantifiedGroup', 'QLFilterCondition'],
        ['McpOptChain3Input', 'McpOptChainStatus', 'IdInputType', 'OneToManyMcpOptChain3Achildren',
          'McpOptChain3AMcpOptChain4InputForParent', 'McpOptChain4InputForUpdate'],
      ]);
    });

    it('keeps graphqlArgsToJSONSchema returning independent objects (guard)', () => {
      const field = buildShops().schema.getQueryType().getFields().mcpoptncshops;
      const first = simfinity.graphqlArgsToJSONSchema(field);
      const second = simfinity.graphqlArgsToJSONSchema(field);
      expect(first).toEqual(second);
      for (const name of Object.keys(first.$defs)) {
        expect(first.$defs[name]).not.toBe(second.$defs[name]);
      }
    });
  });
});

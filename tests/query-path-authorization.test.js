import {
  describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLError, GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';

import {
  createRuntime, createQueryPlan, describeModels, SimfinityError,
} from '../packages/core/src/index.js';
import * as auth from '../packages/core/src/auth/index.js';
import { createMembershipScopeFixture, createQueryPathFixture } from './fixtures/query-path-authorization.js';

const rows = {
  Team: [{ _id: 't1', name: 'Public', tenant: 'B' }],
  User: [{ _id: 'u1', name: 'ann', tenant: 'A' }],
  Post: [{ _id: 'p1', title: 'Hello' }],
  RwOwner: [{ _id: 'o1', name: 'o' }],
};
const rowsFor = (Model) => rows[Object.keys(rows).find((key) => Model.name.endsWith(key))] || [];

const createAdapter = (calls) => ({
  bind() {},
  prepare() {},
  createModel: (gqltype) => ({ name: gqltype.name }),
  castId: String,
  withTransaction: async (session, body) => body(session || {}),
  async getById(Model, id) {
    return rowsFor(Model).find((row) => row._id === id) || null;
  },
  async find(Model, gqltype, args) {
    calls.push({ method: 'find', type: gqltype.name, args: structuredClone(args) });
    return rowsFor(Model);
  },
  async count(Model, gqltype, args) {
    calls.push({ method: 'count', type: gqltype.name, args: structuredClone(args) });
    return rowsFor(Model).length;
  },
  async aggregate(Model, gqltype, args) {
    calls.push({ method: 'aggregate', type: gqltype.name, args: structuredClone(args) });
    return [{ groupId: 'g', facts: { n: 1 } }];
  },
  async findChildren(Model, gqltype, connectionField, parentId, args) {
    calls.push({ method: 'findChildren', type: gqltype.name, args: structuredClone(args) });
    return rowsFor(Model);
  },
});

let counter = 0;
const build = ({ permissions, defaultPolicy = 'DENY', middleware } = {}) => {
  const calls = [];
  const runtime = createRuntime(createAdapter(calls));
  const prefix = `Qp${String.fromCharCode(97 + (counter++ % 26))}${counter}`;
  const fixture = createQueryPathFixture(runtime, prefix);
  const membership = createMembershipScopeFixture(runtime, prefix);
  if (middleware) runtime.use(middleware);
  const schema = runtime.createSchema();
  if (permissions) auth.createAuthPlugin(permissions(prefix), { defaultPolicy }).onSchemaChange({ schema });
  const run = (source, user = { role: 'viewer', tenant: 'A' }) => graphql({
    schema, source, contextValue: { user },
  });
  return {
    ...fixture, names: { ...fixture.names, ...membership.names }, runtime, schema, calls, run, prefix,
  };
};

const expectForbiddenPath = (result) => {
  expect(result.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN_FILTER_PATH', status: 403 });
};

describe('client query paths: queryability', () => {
  test('rejects an aggregate groupId that reaches a masked field through a relation', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.posts}_aggregate(aggregation: {groupId: "author.passwordHash",
      facts: [{operation: COUNT, factName: "n", path: "id"}]}) { groupId facts }}`);
    expectForbiddenPath(result);
    expect(result.errors[0].message).toContain('passwordHash');
    expect(calls).toEqual([]);
  });

  test.each([
    ['relation term', (n) => `${n.posts}(author: {terms: [{path: "passwordHash", operator: LT, value: "$2b"}]}) {id}`],
    ['dotted condition', (n) => `${n.posts}(AND: [{conditions: [{field: "author.passwordHash", value: "x"}]}]) {id}`],
    ['condition path', (n) => `${n.posts}(OR: [{conditions: [{field: "author", path: "passwordHash", value: "x"}]}]) {id}`],
    ['nested group', (n) => `${n.posts}(AND: [{OR: [{AND: [{conditions: [{field: "author.passwordHash", value: "x"}]}]}]}]) {id}`],
    ['sort', (n) => `${n.posts}(sort: {terms: [{field: "author.passwordHash", order: ASC}]}) {id}`],
    ['root filter', (n) => `${n.users}(passwordHash: {value: "x"}) {id}`],
    ['queryable false', (n) => `${n.users}(tenant: {value: "B"}) {id}`],
    ['queryable false through relation', (n) => `${n.posts}(author: {terms: [{path: "tenant", value: "B"}]}) {id}`],
    ['aggregate fact', (n) => `${n.posts}_aggregate(aggregation: {groupId: "title",
      facts: [{operation: MAX, factName: "m", path: "author.passwordHash"}]}) {groupId}`],
    ['collection field', (n) => `${n.team}(id: "t1") { members(passwordHash: {value: "x"}) {id} }`],
  ])('rejects a masked or non-queryable %s path', async (_name, query) => {
    const { run, calls, names } = build();
    const result = await run(`{${query(names)}}`);
    expectForbiddenPath(result);
    expect(calls.filter((call) => call.type.endsWith('User') || call.type.endsWith('Post'))).toEqual([]);
  });

  test('allows generated fields and explicitly queryable resolver fields', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.posts}(author: {terms: [{path: "nickname", value: "annie"}]},
      sort: {terms: [{field: "id", order: ASC}]}) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('leaves unknown paths to the backend', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.posts}(author: {terms: [{path: "missing", value: 1}]}) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.author).toEqual({ terms: [{ path: 'missing', value: 1 }] });
  });

  test('trusts paths added by middleware and scopes', async () => {
    const { run, calls, names } = build({
      middleware: async ({ type, args, operation }, next) => {
        if (type.gqltype.name.endsWith('Post') && operation === 'find') {
          args.AND = [...(args.AND || []), { conditions: [{ field: 'author.passwordHash', value: 'x' }] }];
        }
        await next();
      },
    });
    const posts = await run(`{${names.posts} {id}}`);
    const users = await run(`{${names.users} {id}}`);
    expect(posts.errors).toBeUndefined();
    expect(users.errors).toBeUndefined();
    expect(calls[0].args.AND).toEqual([{ conditions: [{ field: 'author.passwordHash', value: 'x' }] }]);
    expect(calls[1].args.tenant).toEqual({ operator: 'EQ', value: 'A' });
  });

  test('keeps the resolver snapshot after auth wrapping and a later schema build', async () => {
    const { runtime, schema, names, prefix } = build();
    auth.createAuthPlugin({}, { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema });
    runtime.connect(null, new GraphQLObjectType({
      name: `${prefix}Extra`,
      fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
    }), `${prefix.toLowerCase()}extra`, `${prefix.toLowerCase()}extras`);
    const rebuilt = runtime.createSchema();
    const run = (source) => graphql({ schema: rebuilt, source, contextValue: { user: { tenant: 'A' } } });

    const allowed = await run(`{${names.users}(name: {value: "ann"}, sort: {terms: [{field: "email", order: ASC}]}) {id}}`);
    expect(allowed.errors).toBeUndefined();
    expectForbiddenPath(await run(`{${names.users}(passwordHash: {value: "x"}) {id}}`));
  });
});

describe('client query paths: application resolvers on relations and id', () => {
  const buildLibrary = () => {
    const calls = [];
    const runtime = createRuntime(createAdapter(calls));
    const Author = new GraphQLObjectType({
      name: 'ArAuthor',
      fields: () => ({
        id: { type: GraphQLID, resolve: (author) => author._id },
        name: { type: GraphQLString },
        books: {
          type: new GraphQLList(Book),
          extensions: { relation: { connectionField: 'author' } },
          resolve: () => [],
        },
      }),
    });
    const Book = new GraphQLObjectType({
      name: 'ArBook',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        author: { type: Author, extensions: { relation: { connectionField: 'author' } }, resolve: () => null },
        editor: {
          type: Author,
          extensions: { relation: { connectionField: 'editor' }, queryable: true },
          resolve: () => null,
        },
      }),
    });
    runtime.connect(null, Author, 'arauthor', 'arauthors');
    runtime.connect(null, Book, 'arbook', 'arbooks');
    const schema = runtime.createSchema();
    return { calls, run: (source) => graphql({ schema, source, contextValue: {} }) };
  };

  test.each([
    ['single relation filter', '{arbooks(author: {terms: [{path: "name", value: "x"}]}) {id}}', 'ArBook.author'],
    ['single relation sort', '{arbooks(sort: {terms: [{field: "author.name", order: ASC}]}) {id}}', 'ArBook.author'],
    ['collection relation filter', '{arauthors(books: {terms: [{path: "title", value: "x"}]}) {id}}', 'ArAuthor.books'],
    ['custom id sort', '{arauthors(sort: {terms: [{field: "id", order: ASC}]}) {id}}', 'ArAuthor.id'],
    ['custom id through a relation', '{arbooks(editor: {terms: [{path: "id", value: "a1"}]}) {id}}', 'ArAuthor.id'],
  ])('rejects a %s path through an application resolver', async (_name, source, field) => {
    const { run, calls } = buildLibrary();
    const result = await run(source);
    expectForbiddenPath(result);
    expect(result.errors[0].message).toContain(field);
    expect(calls).toEqual([]);
  });

  test('allows a relation resolver that opts in with queryable: true', async () => {
    const { run, calls } = buildLibrary();
    const result = await run(`{arbooks(editor: {terms: [{path: "name", value: "x"}]},
      sort: {terms: [{field: "editor.name", order: ASC}]}) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('client query paths: joined type scopes', () => {
  const userGroup = (prefix, tenant = 'A') => ({
    conditions: [{ field: `${prefix}.tenant`, operator: 'EQ', value: tenant }],
  });

  test.each([
    ['relation filter', (n) => `${n.posts}(author: {terms: [{path: "name", value: "bob"}]}) {id}`, 'find'],
    ['sort', (n) => `${n.posts}(sort: {terms: [{field: "author.name", order: ASC}]}) {id}`, 'find'],
    ['groupId', (n) => `${n.posts}_aggregate(aggregation: {groupId: "author.name",
      facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId}`, 'aggregate'],
  ])('restricts a single reference reached by a %s with the target find scope', async (_name, query, method) => {
    const { run, calls, names } = build();
    const result = await run(`{${query(names)}}`);
    expect(result.errors).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(method);
    expect(calls[0].args.AND).toEqual([userGroup('author')]);
  });

  test('restricts only the AND/OR groups whose conditions use the reference', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.posts}(OR: [
      {conditions: [{field: "author.name", value: "zzz"}]},
      {conditions: [{field: "title", operator: LIKE, value: "Hello"}]},
      {OR: [{conditions: [{field: "author", path: "team.name", value: "Public"}]}], AND: [{conditions: [{field: "title", value: "x"}]}]}
    ]) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.AND).toBeUndefined();
    const teamGroup = {
      OR: [
        { conditions: [{ field: 'author.team.tenant', operator: 'EQ', value: 'A' }] },
        { conditions: [{ field: 'author.team.name', operator: 'EQ', value: 'Public' }] },
      ],
    };
    expect(calls[0].args.OR).toEqual([
      { conditions: [{ field: 'author.name', value: 'zzz' }], AND: [userGroup('author')] },
      { conditions: [{ field: 'title', operator: 'LIKE', value: 'Hello' }] },
      {
        OR: [{ conditions: [{ field: 'author', path: 'team.name', value: 'Public' }], AND: [userGroup('author'), teamGroup] }],
        AND: [{ conditions: [{ field: 'title', value: 'x' }] }],
      },
    ]);
  });

  test('restricts the whole query when the reference is also used outside groups', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.posts}(OR: [{conditions: [{field: "author.name", value: "zzz"}]},
      {conditions: [{field: "title", value: "Hello"}]}], sort: {terms: [{field: "author.name", order: ASC}]}) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.AND).toEqual([userGroup('author')]);
    expect(calls[0].args.OR).toEqual([
      { conditions: [{ field: 'author.name', value: 'zzz' }] },
      { conditions: [{ field: 'title', value: 'Hello' }] },
    ]);
  });

  test('restricts the whole query when middleware detaches a client group', async () => {
    const { run, calls, names } = build({
      middleware: async ({ args }, next) => {
        if (args.OR) args.OR = args.OR.map((group) => ({ ...group }));
        await next();
      },
    });
    const result = await run(`{${names.posts}(OR: [{conditions: [{field: "author.name", value: "zzz"}]},
      {conditions: [{field: "title", value: "Hello"}]}]) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.AND).toEqual([userGroup('author')]);
    expect(calls[0].args.OR[0].AND).toBeUndefined();
  });

  test('applies each scoped prefix once, after the root scope and client groups', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.posts}(
      author: {terms: [{path: "team.name", value: "Public"}, {path: "name", value: "ann"}]}
      AND: [{conditions: [{field: "title", value: "Hello"}]}]
      sort: {terms: [{field: "author.team.name", order: ASC}, {field: "author.name", order: DESC}]}
      pagination: {page: 1, size: 5, count: true}
    ) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['find', 'count']);
    for (const call of calls) {
      expect(call.args.AND).toEqual([
        { conditions: [{ field: 'title', value: 'Hello' }] },
        userGroup('author'),
        {
          OR: [
            { conditions: [{ field: 'author.team.tenant', operator: 'EQ', value: 'A' }] },
            { conditions: [{ field: 'author.team.name', operator: 'EQ', value: 'Public' }] },
          ],
        },
      ]);
    }
  });

  test('adds nothing when the target scope does not restrict the caller', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.posts}(author: {terms: [{path: "name", value: "bob"}]}) {id}}`, { role: 'ADMIN' });
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.AND).toBeUndefined();
  });

  test.each([
    ['sort', (n) => `${n.notes}(sort: {terms: [{field: "member.name", order: ASC}]}) {id}`],
    ['relation filter', (n) => `${n.notes}(member: {terms: [{path: "name", value: "bob"}]}) {id}`],
    ['groupId', (n) => `${n.notes}_aggregate(aggregation: {groupId: "member.name",
      facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId}`],
    ['membership filter', (n) => `${n.memberships}(member: {terms: [{path: "name", value: "bob"}]}) {id}`],
  ])('rejects a %s into a type whose find scope filters through a collection', async (_name, query) => {
    const { run, calls, names, prefix } = build();
    const result = await run(`{${query(names)}}`);
    expectForbiddenPath(result);
    expect(result.errors[0].message).toBe(`Query path member enters ${prefix}Member, `
      + `whose find scope filters through the collection ${prefix}Member.memberships`);
    expect(calls).toEqual([]);
  });

  test('allows those paths when the collection scope adds nothing for the caller', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.notes}(member: {terms: [{path: "name", value: "bob"}]},
      sort: {terms: [{field: "member.name", order: ASC}]}) {id}}`, { role: 'ADMIN' });
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.AND).toBeUndefined();
    expect((await run(`{${names.notes} {id}}`)).errors).toBeUndefined();
  });

  test('rejects a non-array AND before appending joined scope groups', async () => {
    const { run, calls, names } = build({
      middleware: async ({ args }, next) => {
        args.AND = { conditions: [{ field: 'title', value: 'Hello' }] };
        await next();
      },
    });
    const result = await run(`{${names.posts}(author: {terms: [{path: "name", value: "ann"}]}) {id}}`);
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
    expect(result.errors[0].message).toBe('AND requires an array');
    expect(calls).toEqual([]);
  });

  test.each([
    ['filter', (n) => `${n.teams}(members: {terms: [{path: "name", value: "ann"}]}) {id}`],
    ['condition', (n) => `${n.teams}(AND: [{conditions: [{field: "members.id", value: "u1"}]}]) {id}`],
    ['groupId', (n) => `${n.teams}_aggregate(aggregation: {groupId: "members.name",
      facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId}`],
  ])('rejects a %s that enters a scoped collection relation', async (_name, query) => {
    const { run, calls, names, prefix } = build();
    const result = await run(`{${query(names)}}`);
    expectForbiddenPath(result);
    expect(result.errors[0].message).toBe(`Query path members enters the scoped collection ${prefix}Team.members`);
    expect(calls).toEqual([]);
  });

  test('allows scoped collection paths when the collection scope adds nothing for the caller', async () => {
    const { run, calls, names } = build();
    const result = await run(`{${names.teams}(members: {terms: [{path: "name", value: "ann"}]},
      AND: [{conditions: [{field: "members.team.name", value: "Public"}]}]) {id}}`, { role: 'ADMIN' });
    expect(result.errors).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.AND).toEqual([{ conditions: [{ field: 'members.team.name', value: 'Public' }] }]);
  });

  test('moves joined scope groups to the top level when nesting them would exceed the filter depth', async () => {
    const { run, calls, names, runtime, prefix } = build();
    const models = describeModels(runtime.getRegistrations());
    const nest = (levels, group) => (levels ? `{OR: [${nest(levels - 1, group)}]}` : group);
    const teamGroup = {
      OR: [
        { conditions: [{ field: 'author.team.tenant', operator: 'EQ', value: 'A' }] },
        { conditions: [{ field: 'author.team.name', operator: 'EQ', value: 'Public' }] },
      ],
    };
    // [client group depth, path, top-level AND, AND inside the client group]
    for (const [levels, path, topLevel, nested] of [
      [4, 'author.name', undefined, [userGroup('author')]],
      [5, 'author.name', [userGroup('author')], undefined],
      [4, 'author.team.name', [teamGroup], [userGroup('author')]],
    ]) {
      const result = await run(`{${names.posts}(OR: [${nest(levels, `{conditions: [{field: "${path}", value: "x"}]}`)}]) {id}}`);
      expect(result.errors).toBeUndefined();
      const { args } = calls.at(-1);
      let group = args.OR[0];
      for (let level = 0; level < levels; level++) group = group.OR[0];
      expect(group.conditions).toEqual([{ field: path, value: 'x' }]);
      expect(group.AND).toEqual(nested);
      expect(args.AND).toEqual(topLevel);
      expect(() => createQueryPlan(models, `${prefix}Post`, args)).not.toThrow();
    }
  });
});

describe('joined scopes with shared variable values', () => {
  const tenantScope = async ({ args, context }) => {
    if (context.user?.role !== 'ADMIN') args.tenant = { operator: 'EQ', value: context.user?.tenant ?? '__none__' };
  };
  const blogs = [{ _id: 'b1', name: 'one' }, { _id: 'b2', name: 'two' }, { _id: 'b3', name: 'three' }];

  const buildBlogs = (withAuth) => {
    const calls = [];
    const adapter = {
      ...createAdapter(calls),
      // The second blog is read later, so its posts call starts after the first one has finished.
      async getById(Model, id) {
        if (id === 'b2') await new Promise((resolve) => { setTimeout(resolve, 20); });
        return blogs.find((blog) => blog._id === id) || null;
      },
      async find(Model, gqltype, args) {
        calls.push({ method: 'find', type: gqltype.name, args: structuredClone(args) });
        return gqltype.name === 'SvBlog' ? blogs : [];
      },
      async findChildren(Model, gqltype, connectionField, parentId, args) {
        calls.push({ method: 'findChildren', type: gqltype.name, args: structuredClone(args) });
        return [];
      },
    };
    const runtime = createRuntime(adapter);
    const User = new GraphQLObjectType({
      name: 'SvUser',
      extensions: { scope: { find: tenantScope, get_by_id: tenantScope, aggregate: tenantScope } },
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        tenant: { type: GraphQLString, extensions: { queryable: false } },
      }),
    });
    const Post = new GraphQLObjectType({
      name: 'SvPost',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        blog: { type: Blog, extensions: { relation: { connectionField: 'blog' } } },
        author: { type: User, extensions: { relation: { connectionField: 'author' } } },
      }),
    });
    const Blog = new GraphQLObjectType({
      name: 'SvBlog',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        posts: { type: new GraphQLList(Post), extensions: { relation: { connectionField: 'blog' } } },
      }),
    });
    runtime.connect(null, User, 'svuser', 'svusers');
    runtime.connect(null, Blog, 'svblog', 'svblogs');
    runtime.connect(null, Post, 'svpost', 'svposts');
    const schema = runtime.createSchema();
    if (withAuth) {
      auth.createAuthPlugin({
        RootQueryType: { '*': auth.allow() },
        QLTypeAggregationResult: { '*': auth.allow() },
        SvBlog: { '*': auth.allow() },
        SvPost: { '*': auth.allow() },
        SvUser: { id: auth.allow(), name: auth.allow() },
      }, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
    }
    // Keeps the coerced variable values graphql-js shares between the request's resolver calls.
    const root = schema.getQueryType().getFields().svblogs;
    const resolve = root.resolve;
    const shared = {};
    root.resolve = (parent, args, context, info) => {
      shared.variables = info.variableValues;
      return resolve(parent, args, context, info);
    };
    return { schema, calls, shared };
  };

  test.each([['without', false], ['with', true]])('scopes each call once and keeps the variable unchanged %s the auth plugin', async (_name, withAuth) => {
    const { schema, calls, shared } = buildBlogs(withAuth);
    const or = [
      { conditions: [{ field: 'author.name', value: 'ann' }] },
      { conditions: [{ field: 'title', value: 'Hello' }] },
    ];
    const result = await graphql({
      schema,
      source: `query($or: [QLFilterGroup]) {
        first: svblog(id: "b1") { posts(OR: $or) {id} }
        second: svblog(id: "b2") { posts(OR: $or) {id} }
        svblogs { posts(OR: $or) {id} }
        svposts(OR: $or) {id}
        svposts_aggregate(OR: $or, aggregation: {groupId: "title",
          facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId}
      }`,
      variableValues: { or },
      contextValue: { user: { role: 'viewer', tenant: 'A' } },
    });
    expect(result.errors).toBeUndefined();
    const scoped = calls.filter((call) => call.type === 'SvPost');
    expect(scoped.map((call) => call.method).sort()).toEqual([
      'aggregate', 'find', 'findChildren', 'findChildren', 'findChildren', 'findChildren', 'findChildren',
    ]);
    for (const call of scoped) {
      expect(call.args.AND).toBeUndefined();
      expect(call.args.OR).toEqual([
        { ...or[0], AND: [{ conditions: [{ field: 'author.tenant', operator: 'EQ', value: 'A' }] }] },
        or[1],
      ]);
    }
    expect(shared.variables.or).toEqual(or);
  });
});

describe('client query paths: joined scopes through embedded lists', () => {
  const buildRoles = () => {
    const calls = [];
    const runtime = createRuntime(createAdapter(calls));
    const scope = async ({ args, context }) => {
      if (context.user?.role === 'ADMIN') return;
      if (context.form === 'level') args.roles = { terms: [{ path: 'level', value: 'x' }] };
      else args.roles = { terms: [{ path: 'org.id', operator: 'IN', value: ['o1', 'o2'] }] };
    };
    const Org = new GraphQLObjectType({ name: 'ElOrg', fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString } }) });
    const Role = new GraphQLObjectType({
      name: 'ElRole',
      fields: () => ({
        level: { type: GraphQLString },
        org: { type: Org, extensions: { relation: { connectionField: 'org' } } },
      }),
    });
    const User = new GraphQLObjectType({
      name: 'ElUser',
      extensions: { scope: { find: scope } },
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        roles: { type: new GraphQLList(Role), extensions: { relation: { embedded: true } } },
      }),
    });
    const Post = new GraphQLObjectType({
      name: 'ElPost',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        author: { type: User, extensions: { relation: { connectionField: 'author' } } },
      }),
    });
    runtime.connect(null, Org, 'elorg', 'elorgs');
    runtime.addNoEndpointType(Role);
    runtime.connect(null, User, 'eluser', 'elusers');
    runtime.connect(null, Post, 'elpost', 'elposts');
    const schema = runtime.createSchema();
    return {
      calls,
      run: (source, contextValue = { user: { role: 'viewer' } }) => graphql({ schema, source, contextValue }),
    };
  };

  test.each([
    ['sort', '{elposts(sort: {terms: [{field: "author.name", order: ASC}]}) {id}}'],
    ['relation filter', '{elposts(author: {terms: [{path: "name", operator: NE, value: "x"}]}) {id}}'],
    ['groupId', '{elposts_aggregate(aggregation: {groupId: "author.name", facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId}}'],
  ])('rejects a %s into a type whose find scope joins a reference inside an embedded list', async (_name, source) => {
    const { run, calls } = buildRoles();
    const result = await run(source);
    expectForbiddenPath(result);
    expect(result.errors[0].message).toBe(
      'Query path author enters ElUser, whose find scope filters through the relation ElRole.org inside a list',
    );
    expect(calls).toEqual([]);
  });

  test('allows those paths for embedded list scalars and when the scope adds nothing', async () => {
    const { run, calls } = buildRoles();
    const source = '{elposts(sort: {terms: [{field: "author.name", order: ASC}]}) {id}}';
    expect((await run(source, { user: { role: 'ADMIN' } })).errors).toBeUndefined();
    expect(calls[0].args.AND).toBeUndefined();
    expect((await run(source, { user: { role: 'viewer' }, form: 'level' })).errors).toBeUndefined();
    expect(calls[1].args.AND).toEqual([
      { conditions: [{ field: 'author.roles.level', operator: undefined, value: 'x' }] },
    ]);
  });
});

describe('joined scope rewriting', () => {
  const buildHost = () => {
    const calls = [];
    const runtime = createRuntime(createAdapter(calls));
    const scope = vi.fn(async ({ args, context }) => context.scope?.(args));
    const Owner = new GraphQLObjectType({
      name: 'RwOwner',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        hosts: { type: new GraphQLList(Host), extensions: { relation: { connectionField: 'owner' } } },
      }),
    });
    const Target = new GraphQLObjectType({
      name: 'RwTarget',
      extensions: { scope: { find: scope } },
      fields: () => ({
        id: { type: GraphQLID },
        code: { type: GraphQLString },
        owner: { type: Owner, extensions: { relation: { connectionField: 'owner' } } },
      }),
    });
    const Host = new GraphQLObjectType({
      name: 'RwHost',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        target: { type: Target, extensions: { relation: { connectionField: 'target' } } },
        owner: { type: Owner, extensions: { relation: { connectionField: 'owner' } } },
      }),
    });
    runtime.connect(null, Owner, 'rwowner', 'rwowners');
    runtime.connect(null, Target, 'rwtarget', 'rwtargets');
    runtime.connect(null, Host, 'rwhost', 'rwhosts');
    const schema = runtime.createSchema();
    const run = (scopeBody, source = '{rwhosts(target: {terms: [{path: "code", value: "c"}]}) {id}}') => graphql({
      schema, source, contextValue: { scope: scopeBody },
    });
    return { run, calls, scope, runtime, Target };
  };

  test('prefixes flat, relation-term, grouped and OR scope filters', async () => {
    const { run, calls, scope, runtime, Target } = buildHost();
    const result = await run((args) => {
      args.code = { operator: 'IN', value: ['a', 'b'] };
      args.owner = { terms: [{ path: 'name', operator: 'EQ', value: 'o' }, { path: 'id', value: 'x1' }] };
      args.AND = [{
        conditions: [{ field: 'owner', path: 'name', value: 'o' }],
        OR: [{ conditions: [{ field: 'code', operator: 'NE', value: 'z' }] }],
      }];
      args.OR = [{ conditions: [{ field: 'code', value: 'a' }] }, { conditions: [{ field: 'owner.name', value: 'p' }] }];
      args.sort = { terms: [{ field: 'code', order: 'ASC' }] };
      args.pagination = { page: 1, size: 1 };
    });
    expect(result.errors).toBeUndefined();
    expect(scope).toHaveBeenCalledTimes(1);
    expect(scope.mock.calls[0][0]).toMatchObject({ operation: 'find' });
    expect(scope.mock.calls[0][0].type.gqltype).toBe(Target);
    expect(calls[0].args.AND).toEqual([
      {
        conditions: [
          { field: 'target.code', operator: 'IN', value: ['a', 'b'] },
          { field: 'target.owner.name', operator: 'EQ', value: 'o' },
          { field: 'target.owner.id', operator: undefined, value: 'x1' },
        ],
      },
      {
        conditions: [{ field: 'target.owner.name', operator: undefined, value: 'o' }],
        OR: [{ conditions: [{ field: 'target.code', operator: 'NE', value: 'z' }] }],
      },
      {
        OR: [
          { conditions: [{ field: 'target.code', operator: undefined, value: 'a' }] },
          { conditions: [{ field: 'target.owner.name', operator: undefined, value: 'p' }] },
        ],
      },
    ]);
    expect(calls[0].args.sort).toBeUndefined();
    expect(calls[0].args.pagination).toBeUndefined();

    // The relational planner accepts the multi-level dotted conditions.
    const models = describeModels(runtime.getRegistrations());
    const plan = createQueryPlan(models, 'RwHost', calls[0].args);
    expect(JSON.stringify(plan.where)).toContain('"path":["target","owner","name"]');
  });

  test('rejects joined scopes whose groups filter through a collection', async () => {
    const { run, calls } = buildHost();
    const result = await run((args) => {
      args.AND = [{ OR: [{ conditions: [{ field: 'owner', path: 'hosts.name', value: 'h' }] }] }];
    });
    expectForbiddenPath(result);
    expect(result.errors[0].message).toBe(
      'Query path target enters RwTarget, whose find scope filters through the collection RwOwner.hosts',
    );
    expect(calls).toEqual([]);
  });

  test('restricts relation paths in generated collection fields', async () => {
    const { run, calls } = buildHost();
    const result = await run((args) => { args.code = { value: 'visible' }; },
      '{rwowner(id: "o1") { hosts(target: {terms: [{path: "code", value: "c"}]}) {id} }}');
    expect(result.errors).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['findChildren']);
    expect(calls[0].args.AND).toEqual([
      { conditions: [{ field: 'target.code', operator: undefined, value: 'visible' }] },
    ]);
  });

  test('rejects scope relation filters without terms and propagates scope errors', async () => {
    const { run, calls } = buildHost();
    const empty = await run((args) => { args.owner = { terms: [] }; });
    expect(empty.errors?.[0]?.extensions).toMatchObject({ code: 'MISSING_FILTER_PATH' });
    const denied = await run(() => { throw new auth.ForbiddenError('Target scope denied'); });
    expect(denied.errors?.[0]?.message).toBe('Target scope denied');
    expect(calls).toEqual([]);
  });
});

describe('auth plugin query path rules', () => {
  const permissions = (prefix) => ({
    RootQueryType: { '*': auth.allow() },
    QLTypeAggregationResult: { '*': auth.allow() },
    [`${prefix}Post`]: { '*': auth.allow() },
    [`${prefix}User`]: {
      '*': auth.allow(),
      email: auth.requireRole('ADMIN'),
      bio: auth.isOwner('id'),
    },
  });
  const withTeams = (prefix) => ({ ...permissions(prefix), [`${prefix}Team`]: { '*': auth.allow() } });
  const roleDenied = () => 'Requires role: ADMIN';

  test.each([
    ['relation term', (n) => `${n.posts}(author: {terms: [{path: "email", operator: LIKE, value: "a"}]}) {id}`, roleDenied],
    ['sort', (n) => `${n.posts}(sort: {terms: [{field: "author.email", order: ASC}]}) {id}`, roleDenied],
    ['groupId', (n) => `${n.posts}_aggregate(aggregation: {groupId: "author.email",
      facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId}`, roleDenied],
    ['fact', (n) => `${n.posts}_aggregate(aggregation: {groupId: "title",
      facts: [{operation: MAX, factName: "m", path: "author.email"}]}) {groupId}`, roleDenied],
    ['root filter', (n) => `${n.users}(email: {value: "x"}) {id}`, roleDenied],
    ['OR condition', (n) => `${n.users}(OR: [{conditions: [{field: "email", value: "x"}]}]) {id}`, roleDenied],
    ['collection field', (n) => `${n.team}(id: "t1") { members(email: {value: "x"}) {id} }`, roleDenied],
    ['parent-dependent rule', (n) => `${n.users}(bio: {value: "x"}) {id}`, (prefix) => `Access denied to ${prefix}User.bio`],
  ])('denies a %s path that a field rule protects', async (_name, query, message) => {
    const { run, calls, names, prefix } = build({ permissions: withTeams });
    const result = await run(`{${query(names)}}`, { id: 'u1', role: 'viewer', tenant: 'A' });
    expect(result.errors?.[0]?.message).toBe(message(prefix));
    expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(calls.filter((call) => call.type !== `${prefix}Team`)).toEqual([]);
  });

  test('applies the default policy to path segments without a rule', async () => {
    const { run, calls, names, prefix } = build({ permissions });
    const result = await run(`{${names.posts}(author: {terms: [{path: "team.name", value: "x"}]}) {id}}`);
    expect(result.errors?.[0]?.message).toBe(`Access denied to ${prefix}Team.name`);
    expect(calls).toEqual([]);
  });

  test('allows protected paths for callers the rules admit', async () => {
    const { run, calls, names } = build({ permissions });
    const result = await run(`{${names.posts}_aggregate(aggregation: {groupId: "author.email",
      facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId facts}}`, { role: 'ADMIN' });
    expect(result.errors).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['aggregate']);
  });

  test('treats aggregate sort terms as result keys', async () => {
    const { run, names } = build({ permissions });
    const result = await run(`{${names.posts}_aggregate(aggregation: {groupId: "title",
      facts: [{operation: COUNT, factName: "email", path: "id"}]}, sort: {terms: [{field: "email", order: DESC}]}) {groupId}}`);
    expect(result.errors).toBeUndefined();
  });

  test('runs path rules without a parent and with empty args', async () => {
    const rule = vi.fn(() => true);
    const { run, names, User } = build({
      permissions: (prefix) => ({ ...permissions(prefix), [`${prefix}User`]: { '*': auth.allow(), name: rule } }),
    });
    const result = await run(`{${names.users}(name: {value: "ann"}) {id}}`);
    expect(result.errors).toBeUndefined();
    expect(rule).toHaveBeenCalledTimes(1);
    const [parent, args, context, info] = rule.mock.calls[0];
    expect(parent).toBeUndefined();
    expect(args).toEqual({});
    expect(context.user.tenant).toBe('A');
    expect(info.fieldName).toBe('name');
    expect(info.parentType).toBe(User);
    expect(info.returnType).toBe(GraphQLString);
  });

  test.each([
    ['filter', (n) => `${n.users}(name: {value: "ann"}) {id}`],
    ['relation filter', (n) => `${n.posts}(author: {terms: [{path: "name", value: "ann"}]}) {id}`],
    ['sort', (n) => `${n.posts}(sort: {terms: [{field: "author.name", order: ASC}]}) {id}`],
    ['groupId', (n) => `${n.posts}_aggregate(aggregation: {groupId: "author.name", facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId}`],
    ['fact', (n) => `${n.posts}_aggregate(aggregation: {groupId: "title", facts: [{operation: MAX, factName: "n", path: "author.name"}]}) {facts}`],
  ])('uses the protected field identity for info-dependent rules on a %s', async (_name, query) => {
    const { run, names, calls, schema, prefix } = build({
      permissions: (p) => ({
        ...permissions(p),
        [`${p}User`]: {
          '*': (_parent, _args, ctx, info) => (
            info.parentType.name !== `${p}User` || info.fieldName !== 'name'
            || info.returnType !== GraphQLString || ctx.user.role === 'ADMIN'
          ),
        },
      }),
    });
    const direct = await run(`{${names.users} {name}}`);
    expect(direct.errors?.[0]?.extensions.code).toBe('FORBIDDEN');
    calls.length = 0;
    const result = await run(`{${query(names)}}`);
    expect(result.errors?.[0]?.extensions.code).toBe('FORBIDDEN');
    expect(calls).toEqual([]);
    expect((await run(`{${query(names)}}`, { role: 'ADMIN' })).errors).toBeUndefined();

    // The deprecated function middleware uses the same field identity as the plugin.
    const rule = (_parent, _args, _ctx, info) => info.parentType.name !== `${prefix}User` || info.fieldName !== 'name';
    const middleware = auth.createAuthMiddleware({ [`${prefix}User`]: { '*': rule } }, { defaultPolicy: 'ALLOW' });
    await expect(middleware(async () => [], undefined, { name: { value: 'ann' } }, {}, {
      schema, parentType: schema.getQueryType(), fieldName: names.users,
    })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  test('denies a path whose rule throws, keeping Simfinity and GraphQL errors', async () => {
    const { run, calls, names, prefix } = build({
      permissions: (p) => ({
        ...permissions(p),
        [`${p}User`]: {
          '*': auth.allow(),
          bio: (parent, args, ctx) => parent.ownerId === ctx.user.id,
          email: () => { throw new auth.UnauthenticatedError('Sign in first'); },
          name: () => { throw new SimfinityError('Name rule failed', 'NAME_RULE', 409); },
          nickname: () => { throw new GraphQLError('Nickname hidden', { extensions: { code: 'HIDDEN' } }); },
        },
      }),
    });
    const bio = await run(`{${names.users}(bio: {value: "x"}) {id}}`);
    expect(bio.errors?.[0]?.message).toBe(`Access denied to ${prefix}User.bio`);
    expect(bio.errors[0].extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const email = await run(`{${names.users}(sort: {terms: [{field: "email", order: ASC}]}) {id}}`);
    expect(email.errors?.[0]?.message).toBe('Sign in first');
    expect(email.errors[0].extensions).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    const name = await run(`{${names.users}(name: {value: "x"}) {id}}`);
    expect(name.errors?.[0]?.extensions).toMatchObject({ code: 'NAME_RULE', status: 409 });
    const nickname = await run(`{${names.users}(nickname: {value: "x"}) {id}}`);
    expect(nickname.errors?.[0]?.message).toBe('Nickname hidden');
    expect(nickname.errors[0].extensions).toMatchObject({ code: 'HIDDEN' });
    expect(calls).toEqual([]);
  });

  test('applies the same path check in the deprecated middleware', async () => {
    const { schema, names, prefix } = build();
    const middleware = auth.createAuthMiddleware(permissions(prefix), { defaultPolicy: 'DENY' });
    const resolve = vi.fn(async () => []);
    const info = { parentType: schema.getQueryType(), fieldName: names.posts, schema };
    await expect(middleware(resolve, undefined, { author: { terms: [{ path: 'bio', value: 'x' }] } },
      { user: { id: 'u1', role: 'viewer' } }, info)).rejects.toThrow(`Access denied to ${prefix}User.bio`);
    expect(resolve).not.toHaveBeenCalled();
    await middleware(resolve, undefined, { title: { value: 'x' } }, { user: { role: 'viewer' } }, info);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

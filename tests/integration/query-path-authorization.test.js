import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, it,
} from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import * as auth from '../../packages/core/src/auth/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import {
  createEmbeddedRoleScopeFixture, createMembershipScopeFixture, createQueryPathFixture,
} from '../fixtures/query-path-authorization.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const namespace = `qpath_${randomUUID().replaceAll('-', '')}`;
let pool;

/**
 * Blogs list posts whose authors' find scope filters a field clients may not query, so a joined
 * scope written into a shared client group would be read back as a forbidden client path.
 */
const createBlogFixture = (runtime) => {
  const userScope = async ({ args, context }) => {
    if (context?.user?.role === 'ADMIN') return;
    args.tenant = { operator: 'EQ', value: context?.user?.tenant ?? '__none__' };
  };
  const User = new GraphQLObjectType({
    name: 'QpvUser',
    extensions: { scope: { find: userScope, get_by_id: userScope, aggregate: userScope } },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tenant: { type: GraphQLString, extensions: { queryable: false } },
    }),
  });
  const Post = new GraphQLObjectType({
    name: 'QpvPost',
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      blog: { type: Blog, extensions: { relation: { connectionField: 'blog' } } },
      author: { type: User, extensions: { relation: { connectionField: 'author' } } },
    }),
  });
  const Blog = new GraphQLObjectType({
    name: 'QpvBlog',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      posts: { type: new GraphQLList(Post), extensions: { relation: { connectionField: 'blog' } } },
    }),
  });
  runtime.connect(null, User, 'qpvuser', 'qpvusers');
  runtime.connect(null, Blog, 'qpvblog', 'qpvblogs');
  runtime.connect(null, Post, 'qpvpost', 'qpvposts');
};

/**
 * Secrets are scoped by a field named `aggregation`, which list queries filter like any other
 * field. Boxes hold secrets as a collection, and holders reference one secret each.
 */
const createAggregationScopeFixture = (runtime) => {
  const tenantOf = (context) => context?.user?.tenant ?? '__none__';
  const findScope = async ({ args, context }) => {
    if (context?.user?.role === 'ADMIN') return;
    args.aggregation = { operator: 'EQ', value: tenantOf(context) };
  };
  // On the aggregate endpoint `args.aggregation` is the expression, so the scope adds a group.
  const aggregateScope = async ({ args, context }) => {
    if (context?.user?.role === 'ADMIN') return;
    args.AND = [...(args.AND || []), { conditions: [{ field: 'aggregation', operator: 'EQ', value: tenantOf(context) }] }];
  };
  const Secret = new GraphQLObjectType({
    name: 'QpgSecret',
    extensions: { scope: { find: findScope, get_by_id: findScope, aggregate: aggregateScope } },
    fields: () => ({
      id: { type: GraphQLID },
      key: { type: GraphQLString },
      aggregation: { type: GraphQLString },
      box: { type: Box, extensions: { relation: { connectionField: 'box' } } },
    }),
  });
  const Box = new GraphQLObjectType({
    name: 'QpgBox',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      secrets: { type: new GraphQLList(Secret), extensions: { relation: { connectionField: 'box' } } },
    }),
  });
  const Holder = new GraphQLObjectType({
    name: 'QpgHolder',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      secret: { type: Secret, extensions: { relation: { connectionField: 'secret' } } },
    }),
  });
  runtime.connect(null, Box, 'qpgbox', 'qpgboxes');
  runtime.connect(null, Secret, 'qpgsecret', 'qpgsecrets');
  runtime.connect(null, Holder, 'qpgholder', 'qpgholders');
};

const backends = [
  {
    name: 'MongoDB',
    enabled: !!mongoUri,
    async create() {
      await mongoose.connect(mongoUri, { dbName: namespace });
      const api = createRuntime(createMongoAdapter());
      api.preventCreatingCollection(true);
      const fixture = createQueryPathFixture(api, 'Qpi');
      createMembershipScopeFixture(api, 'Qpi');
      createEmbeddedRoleScopeFixture(api, 'Qpi');
      createBlogFixture(api);
      createAggregationScopeFixture(api);
      const schema = api.createSchema();
      for (const { model } of api.getRegistrations()) await model.createCollection();
      return { fixture, schema };
    },
    async destroy() {
      if (mongoose.connection.readyState) {
        await mongoose.connection.db.dropDatabase();
        await mongoose.disconnect();
      }
    },
  },
  {
    name: 'PostgreSQL',
    enabled: !!postgresUri,
    async create() {
      pool = new pg.Pool({ connectionString: postgresUri });
      const api = createPostgres({ pool, schema: namespace });
      const fixture = createQueryPathFixture(api, 'Qpi');
      createMembershipScopeFixture(api, 'Qpi');
      createEmbeddedRoleScopeFixture(api, 'Qpi');
      createBlogFixture(api);
      createAggregationScopeFixture(api);
      const schema = api.createSchema();
      await api.initializeDatabase();
      return { fixture, schema };
    },
    async destroy() {
      if (pool) {
        await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await pool.end();
      }
    },
  },
];

const viewer = { user: { role: 'viewer', tenant: 'A' } };
const admin = { user: { role: 'ADMIN' } };
const requireAdmin = auth.requireRole('ADMIN');
const permissions = {
  RootQueryType: { '*': auth.allow() },
  Mutation: { '*': auth.allow() },
  QLTypeAggregationResult: { '*': auth.allow() },
  QpiTeam: { '*': auth.allow() },
  QpiUser: {
    '*': (parent, args, context, info) => (
      info.parentType.name === 'QpiUser' && info.fieldName === 'email'
        ? requireAdmin(parent, args, context, info) : true
    ),
  },
  QpiPost: { '*': auth.allow() },
  QpiMember: { '*': auth.allow() },
  QpiMembership: { '*': auth.allow() },
  QpiNote: { '*': auth.allow() },
  QpiOrg: { '*': auth.allow() },
  QpiRole: { '*': auth.allow() },
  QpiStaff: { '*': auth.allow() },
  QpiTask: { '*': auth.allow() },
  QpvUser: { '*': auth.allow() },
  QpvBlog: { '*': auth.allow() },
  QpvPost: { '*': auth.allow() },
  QpgBox: { '*': auth.allow() },
  QpgSecret: { '*': auth.allow() },
  QpgHolder: { '*': auth.allow() },
};
const countBy = (groupId) => `aggregation: {groupId: "${groupId}", facts: [{operation: COUNT, factName: "n", path: "id"}]}`;

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`${backend.name} client query path authorization`, () => {
    let schema;
    const teams = {};
    const secrets = {};
    let box;
    const roleViewer = { user: { role: 'viewer', orgs: [] } };
    const leadViewer = { user: { role: 'viewer', form: 'level' } };
    const run = async (source, context = viewer) => {
      const contextValue = structuredClone(context);
      const result = await graphql({ schema, source, contextValue });
      return { ...result, count: contextValue.count };
    };
    const ok = async (source, context) => {
      const result = await run(source, context);
      expect(result.errors).toBeUndefined();
      return result;
    };
    const titles = async (args, context) => (
      await ok(`{qpiposts(${args}) {title}}`, context)
    ).data.qpiposts.map((post) => post.title);
    const groups = async (args, context) => (
      await ok(`{qpiposts_aggregate(${args}) {groupId facts}}`, context)
    ).data.qpiposts_aggregate;
    const forbiddenPath = async (source, context = viewer) => {
      const result = await run(source, context);
      expect(result.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN_FILTER_PATH', status: 403 });
      expect(JSON.stringify(result)).not.toContain('hash-');
    };

    beforeAll(async () => {
      ({ schema } = await backend.create());
      auth.createAuthPlugin(permissions, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
      const mutate = async (type, input, prefix = 'Qpi') => {
        const field = `add${prefix.toLowerCase()}${type.toLowerCase()}`;
        const result = await graphql({
          schema,
          source: `mutation($input: ${prefix}${type}Input!) {${field}(input: $input) {id}}`,
          variableValues: { input },
          contextValue: structuredClone(admin),
        });
        expect(result.errors).toBeUndefined();
        return result.data[field].id;
      };
      for (const [name, tenant] of [['Alpha', 'A'], ['Beta', 'B'], ['Public', 'B']]) {
        teams[name] = await mutate('Team', { name, tenant });
      }
      for (const [name, tenant, team] of [['ann', 'A', 'Alpha'], ['amy', 'A', 'Beta'], ['ada', 'A', 'Public'], ['bob', 'B', 'Beta']]) {
        const author = await mutate('User', {
          name,
          tenant,
          email: `${name}@${tenant.toLowerCase()}.test`,
          passwordHash: `hash-${name}`,
          nickname: `${name}-nick`,
          team: { id: teams[team] },
        });
        await mutate('Post', { title: `${name[0].toUpperCase()}${name.slice(1)} post`, author: { id: author } });
      }
      // ann has two memberships in tenant A, so a join through them would repeat her note.
      for (const [name, orgs] of [['ann', ['A', 'A']], ['bob', ['B']]]) {
        const member = await mutate('Member', { name });
        for (const org of orgs) await mutate('Membership', { org, member: { id: member } });
        await mutate('Note', { title: `${name[0].toUpperCase()}${name.slice(1)} note`, member: { id: member } });
      }
      // kim holds two lead roles in organizations roleViewer may see, so a join through them would
      // repeat her task.
      const orgs = {};
      for (const name of ['North', 'South', 'West']) orgs[name] = await mutate('Org', { name });
      roleViewer.user.orgs = [orgs.North, orgs.South];
      for (const [name, roles] of [['kim', [['lead', 'North'], ['lead', 'South']]], ['lee', [['member', 'West']]]]) {
        const staff = await mutate('Staff', { name, roles: roles.map(([level, org]) => ({ level, org: { id: orgs[org] } })) });
        await mutate('Task', { title: `${name} task`, staff: { id: staff } });
      }
      const blogAuthors = {};
      for (const [name, tenant] of [['ann', 'A'], ['bob', 'B']]) blogAuthors[name] = await mutate('User', { name, tenant }, 'Qpv');
      for (let index = 0; index < 4; index++) {
        const blog = await mutate('Blog', { name: `Blog ${index}` }, 'Qpv');
        for (const name of ['ann', 'bob']) {
          await mutate('Post', { title: `${name} ${index}`, blog: { id: blog }, author: { id: blogAuthors[name] } }, 'Qpv');
        }
      }
      box = await mutate('Box', { name: 'box' }, 'Qpg');
      for (const tenant of ['A', 'B']) {
        secrets[tenant] = await mutate('Secret', { key: `s${tenant}`, aggregation: tenant, box: { id: box } }, 'Qpg');
        await mutate('Holder', { name: `h${tenant}`, secret: { id: secrets[tenant] } }, 'Qpg');
      }
    }, 30000);
    afterAll(() => backend.destroy());

    it('keeps relation filters from revealing scoped-out authors', async () => {
      const bob = 'author: {terms: [{path: "name", value: "bob"}]}, pagination: {page: 1, size: 10, count: true}';
      const hidden = await ok(`{qpiposts(${bob}) {title}}`);
      expect(hidden.data.qpiposts).toEqual([]);
      expect(hidden.count).toBe(0);
      const visible = await ok(`{qpiposts(${bob}) {title}}`, admin);
      expect(visible.data.qpiposts).toEqual([{ title: 'Bob post' }]);
      expect(visible.count).toBe(1);
      expect(await titles('author: {terms: [{path: "name", value: "ann"}]}')).toEqual(['Ann post']);
    });

    it('groups and sorts only through references the target scope admits', async () => {
      expect(await groups(countBy('author.name'))).toEqual([
        { groupId: 'ada', facts: { n: 1 } },
        { groupId: 'amy', facts: { n: 1 } },
        { groupId: 'ann', facts: { n: 1 } },
      ]);
      expect((await groups(countBy('author.name'), admin)).map((group) => group.groupId))
        .toEqual(['ada', 'amy', 'ann', 'bob']);
      const byAuthor = 'sort: {terms: [{field: "author.name", order: DESC}]}';
      expect(await titles(byAuthor)).toEqual(['Ann post', 'Amy post', 'Ada post']);
      expect(await titles(byAuthor, admin)).toEqual(['Bob post', 'Ann post', 'Amy post', 'Ada post']);
    });

    it('applies each scope along multi-level relation paths', async () => {
      const byTitle = 'sort: {terms: [{field: "title", order: ASC}]}';
      const team = (name) => `author: {terms: [{path: "team.name", value: "${name}"}]}, ${byTitle}`;
      expect(await titles(team('Beta'))).toEqual([]);
      expect(await titles(team('Beta'), admin)).toEqual(['Amy post', 'Bob post']);
      expect(await titles(team('Public'))).toEqual(['Ada post']);
      expect(await titles(`OR: [{conditions: [{field: "author.team.name", value: "Beta"}]},
        {conditions: [{field: "author", path: "name", value: "ann"}]}], ${byTitle}`)).toEqual(['Ann post']);
      expect(await groups(countBy('author.team.name'))).toEqual([
        { groupId: 'Alpha', facts: { n: 1 } },
        { groupId: 'Public', facts: { n: 1 } },
      ]);
      expect(await groups(countBy('author.team.name'), admin)).toEqual([
        { groupId: 'Alpha', facts: { n: 1 } },
        { groupId: 'Beta', facts: { n: 2 } },
        { groupId: 'Public', facts: { n: 1 } },
      ]);
    });

    it('rejects masked, non-queryable and scoped collection paths', async () => {
      for (const context of [viewer, admin]) {
        await forbiddenPath(`{qpiposts_aggregate(${countBy('author.passwordHash')}) {groupId facts}}`, context);
        await forbiddenPath('{qpiposts(author: {terms: [{path: "passwordHash", operator: LT, value: "hash-b"}]}) {title}}', context);
        await forbiddenPath('{qpiusers(sort: {terms: [{field: "passwordHash", order: ASC}]}) {name}}', context);
        await forbiddenPath('{qpiusers(tenant: {value: "B"}) {name}}', context);
        await forbiddenPath(`{qpiteam(id: "${teams.Public}") {members(passwordHash: {value: "hash-ada"}) {name}}}`, context);
      }
      // A scoped collection is rejected while its scope restricts the caller.
      const bobsTeams = '{qpiteams(members: {terms: [{path: "name", value: "bob"}]}) {name}}';
      await forbiddenPath(bobsTeams);
      expect((await ok(bobsTeams, admin)).data.qpiteams).toEqual([{ name: 'Beta' }]);
      expect(await titles('author: {terms: [{path: "nickname", value: "ann-nick"}]}')).toEqual(['Ann post']);
      const users = await ok('{qpiusers(sort: {terms: [{field: "name", order: ASC}]}) {name tenant passwordHash}}');
      expect(users.data.qpiusers).toEqual([
        { name: 'ada', tenant: 'A', passwordHash: null },
        { name: 'amy', tenant: 'A', passwordHash: null },
        { name: 'ann', tenant: 'A', passwordHash: null },
      ]);
    });

    it('rejects paths into a type whose find scope filters through a collection', async () => {
      const notes = async (args, context) => (
        await ok(`{qpinotes(${args}) {title}}`, context)
      ).data.qpinotes.map((note) => note.title);
      expect(await notes('sort: {terms: [{field: "title", order: ASC}]}')).toEqual(['Ann note', 'Bob note']);
      await forbiddenPath('{qpinotes(sort: {terms: [{field: "member.name", order: ASC}]}) {title}}');
      await forbiddenPath('{qpinotes(member: {terms: [{path: "name", value: "bob"}]}) {title}}');
      await forbiddenPath(`{qpinotes_aggregate(${countBy('member.name')}) {groupId facts}}`);
      // When the scope adds nothing, paths through the member keep one row per note.
      expect(await notes('sort: {terms: [{field: "member.name", order: DESC}]}', admin)).toEqual(['Bob note', 'Ann note']);
      expect(await notes('member: {terms: [{path: "name", value: "ann"}]}', admin)).toEqual(['Ann note']);
      const counts = await ok(`{qpinotes_aggregate(${countBy('member.name')}) {groupId facts}}`, admin);
      expect(counts.data.qpinotes_aggregate).toEqual([
        { groupId: 'ann', facts: { n: 1 } },
        { groupId: 'bob', facts: { n: 1 } },
      ]);
    });

    it('restricts only the OR branches whose conditions use a scoped reference', async () => {
      const search = (name, title) => `OR: [{conditions: [{field: "author.name", value: "${name}"}]},
        {conditions: [{field: "title", operator: LIKE, value: "${title}"}]}]`;
      const byTitle = 'sort: {terms: [{field: "title", order: ASC}]}';
      const all = ['Ada post', 'Amy post', 'Ann post', 'Bob post'];
      expect(await titles(`${search('zzz', 'post')}, ${byTitle}`)).toEqual(all);
      const counted = await ok(`{qpiposts(${search('zzz', 'post')}, pagination: {page: 1, size: 10, count: true}) {title}}`);
      expect(counted.count).toBe(4);
      expect((await groups(`${search('zzz', 'post')}, ${countBy('title')}`)).map((group) => group.groupId).sort())
        .toEqual(all);
      // The branch that names the author still only matches authors the scope admits.
      expect(await titles(`${search('bob', 'Ann')}, ${byTitle}`)).toEqual(['Ann post']);
      expect(await titles(`${search('bob', 'Ann')}, ${byTitle}`, admin)).toEqual(['Ann post', 'Bob post']);
      expect(await titles(`${search('ann', 'Bob')}, ${byTitle}`)).toEqual(['Ann post', 'Bob post']);
    });

    it('keeps deeply nested client groups within the filter depth limit', async () => {
      const nest = (levels, group) => (levels ? `{OR: [${nest(levels - 1, group)}]}` : group);
      const deep = (name) => `OR: [${nest(5, `{conditions: [{field: "author.name", value: "${name}"}]}`)}]`;
      expect(await titles(deep('ann'))).toEqual(['Ann post']);
      expect(await titles(deep('bob'))).toEqual([]);
      expect(await titles(deep('bob'), admin)).toEqual(['Bob post']);
    });

    it('scopes a shared OR variable in nested collection calls as a literal OR', async () => {
      const or = [
        { conditions: [{ field: 'author.name', value: 'bob' }] },
        { conditions: [{ field: 'title', operator: 'LIKE', value: 'ann' }] },
      ];
      const literal = `[{conditions: [{field: "author.name", value: "bob"}]},
        {conditions: [{field: "title", operator: LIKE, value: "ann"}]}]`;
      const byTitle = 'sort: {terms: [{field: "title", order: ASC}]}';
      const selection = (filter) => `
        qpvposts(title: {operator: LIKE, value: "ann"}, ${byTitle}) { title blog { posts(OR: ${filter}, ${byTitle}) { title } } }
        all: qpvposts(OR: ${filter}, ${byTitle}) { title }
        counts: qpvposts_aggregate(OR: ${filter}, ${countBy('title')}) { groupId facts }`;
      for (const [context, perBlog] of [[viewer, (index) => [`ann ${index}`]], [admin, (index) => [`ann ${index}`, `bob ${index}`]]]) {
        const withVariable = await graphql({
          schema,
          source: `query($or: [QLFilterGroup]) {${selection('$or')}}`,
          variableValues: { or },
          contextValue: structuredClone(context),
        });
        const withLiteral = await run(`{${selection(literal)}}`, context);
        expect(withVariable.errors).toBeUndefined();
        expect(withLiteral.errors).toBeUndefined();
        expect(withVariable.data).toEqual(withLiteral.data);
        expect(withVariable.data.qpvposts.map((post) => post.blog.posts.map((item) => item.title)))
          .toEqual([0, 1, 2, 3].map(perBlog));
        expect(withVariable.data.all.map((post) => post.title)).toEqual([0, 1, 2, 3].flatMap(perBlog).sort());
      }
    });

    it('rejects paths into a type whose find scope joins references inside an embedded list', async () => {
      const tasks = async (args, context) => (
        await ok(`{qpitasks(${args}) {title}}`, context)
      ).data.qpitasks.map((task) => task.title);
      const byStaff = 'sort: {terms: [{field: "staff.name", order: ASC}]}';
      await forbiddenPath(`{qpitasks(${byStaff}) {title}}`, roleViewer);
      await forbiddenPath('{qpitasks(staff: {terms: [{path: "name", operator: NE, value: "x"}]}) {title}}', roleViewer);
      await forbiddenPath(`{qpitasks_aggregate(${countBy('staff.name')}) {groupId facts}}`, roleViewer);
      await forbiddenPath(`{qpitasks_aggregate(aggregation: {groupId: "title",
        facts: [{operation: COUNT, factName: "n", path: "staff.name"}]}) {groupId facts}}`, roleViewer);
      // Callers the scope does not restrict, and scopes on scalar role fields, keep one row per task.
      expect(await tasks(byStaff, admin)).toEqual(['kim task', 'lee task']);
      expect(await tasks(byStaff, leadViewer)).toEqual(['kim task']);
      expect(await tasks('staff: {terms: [{path: "name", operator: NE, value: "x"}]}', leadViewer)).toEqual(['kim task']);
      for (const context of [admin, leadViewer]) {
        const counts = await ok(`{qpitasks_aggregate(${countBy('staff.name')}) {groupId facts}}`, context);
        expect(counts.data.qpitasks_aggregate[0]).toEqual({ groupId: 'kim', facts: { n: 1 } });
      }
    });

    it('enforces field rules on filter, sort, aggregation and collection paths', async () => {
      for (const source of [
        '{qpiusers {email}}',
        `{qpiposts_aggregate(${countBy('author.email')}) {groupId facts}}`,
        '{qpiposts(sort: {terms: [{field: "author.email", order: ASC}]}) {title}}',
        '{qpiusers(email: {operator: LIKE, value: "@"}) {name}}',
        `{qpiteam(id: "${teams.Public}") {members(email: {operator: LIKE, value: "ada"}) {name}}}`,
      ]) {
        const result = await run(source);
        expect(result.errors?.[0]?.message).toBe('Requires role: ADMIN');
        expect(JSON.stringify(result.data ?? null)).not.toContain('.test');
      }
      expect((await groups(countBy('author.email'), admin)).map((group) => group.groupId))
        .toEqual(['ada@a.test', 'amy@a.test', 'ann@a.test', 'bob@b.test']);
      const members = await ok(`{qpiteam(id: "${teams.Beta}") {members(email: {operator: LIKE, value: "bob"}) {name}}}`, admin);
      expect(members.data.qpiteam.members).toEqual([{ name: 'bob' }]);
    });

    it('applies find, get_by_id, collection and joined scopes on a field named aggregation', async () => {
      const byKey = 'sort: {terms: [{field: "key", order: ASC}]}';
      const keys = async (source, field, context) => (
        await ok(source, context)
      ).data[field].map((row) => row.key);
      expect(await keys(`{qpgsecrets(${byKey}) {key}}`, 'qpgsecrets')).toEqual(['sA']);
      expect(await keys(`{qpgsecrets(${byKey}) {key}}`, 'qpgsecrets', admin)).toEqual(['sA', 'sB']);
      const counted = await ok('{qpgsecrets(key: {operator: LIKE, value: "s"}, pagination: {page: 1, size: 10, count: true}) {key}}');
      expect(counted.data.qpgsecrets).toEqual([{ key: 'sA' }]);
      expect(counted.count).toBe(1);
      // The scope's value replaces a client filter on the same field, so it cannot reach B.
      expect((await ok('{qpgsecrets(aggregation: {value: "B"}) {key}}')).data.qpgsecrets).toEqual([{ key: 'sA' }]);
      expect((await ok('{qpgsecrets(aggregation: {value: "B"}) {key}}', admin)).data.qpgsecrets).toEqual([{ key: 'sB' }]);

      expect((await ok(`{qpgsecret(id: "${secrets.B}") {key}}`)).data.qpgsecret).toBeNull();
      expect((await ok(`{qpgsecret(id: "${secrets.A}") {key}}`)).data.qpgsecret).toEqual({ key: 'sA' });
      expect((await ok(`{qpgsecret(id: "${secrets.B}") {key}}`, admin)).data.qpgsecret).toEqual({ key: 'sB' });

      const boxSecrets = `{qpgbox(id: "${box}") {secrets(${byKey}) {key}}}`;
      expect((await ok(boxSecrets)).data.qpgbox.secrets).toEqual([{ key: 'sA' }]);
      expect((await ok(boxSecrets, admin)).data.qpgbox.secrets).toEqual([{ key: 'sA' }, { key: 'sB' }]);

      const byName = 'sort: {terms: [{field: "name", order: ASC}]}';
      const holders = async (args, context) => (
        await ok(`{qpgholders(${args}, ${byName}) {name}}`, context)
      ).data.qpgholders.map((holder) => holder.name);
      const anySecret = 'secret: {terms: [{path: "key", operator: LIKE, value: "s"}]}';
      expect(await holders(anySecret)).toEqual(['hA']);
      expect(await holders(anySecret, admin)).toEqual(['hA', 'hB']);
      expect(await holders('OR: [{conditions: [{field: "secret.key", value: "sB"}]}, {conditions: [{field: "name", value: "hA"}]}]'))
        .toEqual(['hA']);
      expect((await ok(`{qpgholders(${byName}) {name secret {key}}}`)).data.qpgholders).toEqual([
        { name: 'hA', secret: { key: 'sA' } },
        { name: 'hB', secret: null },
      ]);

      const counts = await ok('{qpgsecrets_aggregate(aggregation: {groupId: "aggregation", facts: [{operation: COUNT, factName: "n", path: "id"}]}) {groupId facts}}');
      expect(counts.data.qpgsecrets_aggregate).toEqual([{ groupId: 'A', facts: { n: 1 } }]);
    });
  });
}

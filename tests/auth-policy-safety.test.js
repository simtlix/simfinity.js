import { describe, test, expect, vi } from 'vitest';
import {
  GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql,
} from 'graphql';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import '../packages/core/src/introspection.js';
import auth from '../packages/mongodb/src/auth/index.js';
import { isOwner as deepIsOwner } from '../packages/mongodb/src/auth/rules.js';

const {
  createAuthPlugin, createAuthMiddleware, createFieldMiddleware,
  evaluateExpression, isPolicyExpression, createRuleFromExpression,
  composeRules, anyRule, createRule, isOwner, requireAuth, requireRole, requirePermission,
  allow, deny, ForbiddenError, UnauthenticatedError,
} = auth;

const executePolicy = async (rule, parent = {}, contextValue = {}) => {
  let protectedReads = 0;
  const Post = new GraphQLObjectType({
    name: 'Post',
    fields: {
      content: {
        type: GraphQLString,
        resolve: () => { protectedReads++; return 'private content'; },
      },
    },
  });
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { post: { type: Post, resolve: () => parent } },
    }),
  });
  createAuthPlugin({ Post: { content: rule } }, { defaultPolicy: 'ALLOW' })
    .onSchemaChange({ schema });
  const result = await graphql({ schema, source: '{ post { content } }', contextValue });
  return { result, protectedReads };
};

const expectDenied = ({ result, protectedReads }) => {
  expect(result.data.post.content).toBeNull();
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].extensions.code).toBe('FORBIDDEN');
  expect(protectedReads).toBe(0);
};

const publicOrOwner = {
  anyOf: [
    { eq: [{ ref: 'parent.published' }, true] },
    { eq: [{ ref: 'parent.authorId' }, { ref: 'ctx.user.id' }] },
  ],
};

describe('Authorization policy safety', () => {
  test('the README policy denies anonymous access to a private post without an author', async () => {
    expectDenied(await executePolicy(publicOrOwner, { published: false }));
  });

  test.each([
    [{ published: true }, {}],
    [{ published: false, authorId: 'user-1' }, { user: { id: 'user-1' } }],
  ])('the README policy preserves public and owner grants %#', async (parent, ctx) => {
    const { result, protectedReads } = await executePolicy(publicOrOwner, parent, ctx);
    expect(result.errors).toBeUndefined();
    expect(result.data.post.content).toBe('private content');
    expect(protectedReads).toBe(1);
  });

  describe('missing references', () => {
    const missingComparison = { eq: [{ ref: 'parent.ownerId' }, { ref: 'ctx.user.id' }] };
    test.each([
      missingComparison,
      { not: missingComparison },
      { not: { not: missingComparison } },
      { not: { anyOf: [false, missingComparison] } },
      { not: { allOf: [false, missingComparison] } },
      { not: { in: ['admin', { ref: 'ctx.user.roles' }] } },
    ])('never grants through comparison, membership, or negation %#', async (expression) => {
      expect(evaluateExpression(expression, { parent: {}, ctx: {} })).toBe(false);
      expectDenied(await executePolicy(expression));
    });

    test('does not negate a membership operand that resolves to a non-array', async () => {
      expectDenied(await executePolicy(
        { not: { in: ['admin', { ref: 'ctx.user.roles' }] } },
        {}, { user: { roles: 'admin' } },
      ));
    });

    test('distinguishes explicit null and other falsey values from missing data', async () => {
      for (const value of [null, false, 0, '']) {
        const { result } = await executePolicy({ eq: [{ ref: 'parent.value' }, value] }, { value });
        expect(result.errors).toBeUndefined();
        expect(result.data.post.content).toBe('private content');
      }
    });

    test('preserves root references, array paths, and Mongoose document getters', () => {
      const document = new mongoose.Document({}, new mongoose.Schema({ authorId: String }));
      document.set('authorId', 'user-1');
      const context = { parent: document, args: { values: ['user-1'] }, ctx: { id: 'user-1' } };
      expect(evaluateExpression({ eq: [{ ref: 'parent.authorId' }, { ref: 'args.values.0' }] }, context)).toBe(true);
      expect(evaluateExpression({ eq: [{ ref: 'ctx' }, context.ctx] }, context)).toBe(true);
    });
  });

  describe('malformed configuration', () => {
    const malformed = [
      null, undefined, 'AUTH', 0, {}, [], { typo: true },
      { not: null }, { not: { unknown: true } }, { eq: [1] },
      { eq: [1, 1, 1] }, { allOf: true }, { anyOf: [true, { unknown: true }] },
      { eq: [1, 1], unknown: true }, { in: [1, 1] },
      { eq: [{ ref: 'process.env' }, 1] }, { eq: [{ ref: 'ctx..id' }, 1] },
      { eq: [{ ref: 1 }, 1] }, { eq: [{ ref: 'ctx.id', typo: true }, 1] },
      { eq: [{ ref: 'ctx.constructor' }, { ref: 'parent.constructor' }] },
      { eq: [{ ref: 'ctx.__proto__' }, null] },
      { in: [{ ref: 'ctx.user.id' }, [undefined]] },
      // Literal membership lists hold only JSON primitives; a nested reference is never resolved.
      { not: { in: [{ ref: 'ctx.user.id' }, [{ ref: 'parent.ownerId' }]] } },
      { in: ['admin', ['editor', { ref: 'ctx.user.role' }]] },
      { in: ['admin', [['admin']]] }, { in: ['admin', [{}]] }, { in: [1, [NaN]] },
      // eslint-disable-next-line no-sparse-arrays
      { in: [1, [1, , 2]] },
      { not: { eq: [{ ref: 'ctx.user' }, { id: { ref: 'parent.ownerId' } }] } },
      { eq: [[{ ref: 'ctx.user.id' }], ['user-1']] },
    ];

    test.each(malformed.map(value => [value]))('rejects malformed rules before serving %#', (expression) => {
      expect(evaluateExpression({ not: expression }, {})).toBe(false);
      expect(isPolicyExpression(expression)).toBe(false);
      expect(() => createRuleFromExpression(expression)).toThrow(TypeError);
      for (const factory of [createAuthPlugin, createAuthMiddleware, createFieldMiddleware]) {
        expect(() => factory({ Post: { content: expression } }, { defaultPolicy: 'ALLOW' })).toThrow(TypeError);
        expect(() => factory({ Post: { '*': expression } }, { defaultPolicy: 'ALLOW' })).toThrow(TypeError);
      }
    });

    test.each([null, false, 'allow', 'DENI', '', 1])('rejects invalid default policy %j', (defaultPolicy) => {
      for (const factory of [createAuthPlugin, createAuthMiddleware, createFieldMiddleware]) {
        expect(() => factory({}, { defaultPolicy })).toThrow(TypeError);
      }
    });

    test.each([null, [], 'invalid', new Map(), new Date(),
      { Post: null }, { Post: [] }, { Post: true }, { Post: new Map() },
    ])('rejects invalid permission maps %#', (permissions) => {
      expect(() => createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' })).toThrow(TypeError);
    });

    test('revalidates changed configuration before wrapping any schema resolvers', () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query', fields: { content: { type: GraphQLString } },
        }),
      });
      const permissions = { Query: { content: false } };
      const plugin = createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' });
      permissions.Query = null;
      expect(() => plugin.onSchemaChange({ schema })).toThrow(TypeError);
      expect(schema.getQueryType().getFields().content.resolve).toBeUndefined();
    });

    test('legacy middleware denies a configured type replaced with an invalid map', async () => {
      const permissions = { Post: { content: false } };
      const middleware = createAuthMiddleware(permissions, { defaultPolicy: 'ALLOW' });
      permissions.Post = null;
      await expect(middleware(() => 'private content', {}, {}, {}, {
        parentType: { name: 'Post' }, fieldName: 'content',
      })).rejects.toThrow(TypeError);
    });

    test('preserves null-prototype permission maps and default policy for absent rules', async () => {
      for (const defaultPolicy of ['ALLOW', 'DENY']) {
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query', fields: { content: { type: GraphQLString, resolve: () => 'public content' } },
          }),
        });
        createAuthPlugin(Object.create(null), { defaultPolicy }).onSchemaChange({ schema });
        const result = await graphql({ schema, source: '{ content }' });
        expect(result.data.content).toBe(defaultPolicy === 'ALLOW' ? 'public content' : null);
      }
    });

    test('rejects invalid members rather than silently dropping them from rule arrays', () => {
      expect(() => createAuthPlugin({ Post: { content: [() => true, {}] } }, { defaultPolicy: 'ALLOW' })).toThrow(TypeError);
      expect(() => createAuthPlugin({ Post: { content: [() => true, []] } })).toThrow(TypeError);
    });

    test('preserves explicit booleans and logical identity expressions', async () => {
      for (const rule of [true, { allOf: [] }, { not: false }, { not: { eq: [1, 2] } }]) {
        const { result } = await executePolicy(rule);
        expect(result.errors).toBeUndefined();
      }
      for (const rule of [false, { anyOf: [] }]) expectDenied(await executePolicy(rule));
    });

    test('preserves nested rule arrays and implicit AND expressions', async () => {
      const { result } = await executePolicy([
        () => true, [{ eq: [1, 1], not: false }, true],
      ]);
      expect(result.errors).toBeUndefined();
    });
  });

  describe('consistent rule results', () => {
    test.each([null, 0, '', false, 1, 'yes', {}, []])('denies non-allow results across direct and composed rules %#', async (value) => {
      const rule = async () => value;
      for (const wrapped of [rule, composeRules(rule), anyRule(rule), createRule(rule)]) {
        expectDenied(await executePolicy(wrapped));
      }
    });

    test.each([true, undefined])('preserves true and void grants %#', async (value) => {
      const rule = async () => value;
      for (const wrapped of [rule, composeRules(rule), anyRule(rule), createRule(rule)]) {
        const { result } = await executePolicy(wrapped);
        expect(result.errors).toBeUndefined();
      }
    });

    test('OR continues after a rejected result or error, while AND stops', async () => {
      const { result } = await executePolicy(anyRule(() => null, () => { throw new Error('deny'); }, () => true));
      expect(result.errors).toBeUndefined();
      let laterRuleRuns = 0;
      expectDenied(await executePolicy(composeRules(() => null, () => { laterRuleRuns++; return true; })));
      expect(laterRuleRuns).toBe(0);
    });

    test('rejects nonfunction rule helper arguments when the helper is created', () => {
      expect(() => composeRules(() => true, null)).toThrow(TypeError);
      expect(() => anyRule(() => true, {})).toThrow(TypeError);
      expect(() => createRule(null)).toThrow(TypeError);
    });
  });

  describe('owner identity', () => {
    test.each([
      [null, null], [undefined, undefined], [{ a: 1 }, { b: 2 }],
      ['', ''], [[], []], [false, false], [NaN, NaN], [Infinity, Infinity],
    ])('denies missing and nonidentifier ownership values %#', async (ownerId, userId) => {
      expectDenied(await executePolicy(isOwner('authorId'), { authorId: ownerId }, { user: { id: userId } }));
    });

    test.each([
      ['own brand and method', () => ({
        _bsontype: 'ObjectId',
        toHexString: () => '507f1f77bcf86cd799439011',
      })],
      ['forged prototype brand and method', () => Object.create({
        _bsontype: 'ObjectId',
        toHexString: () => '507f1f77bcf86cd799439011',
      })],
      ['authentic prototype without ObjectId state', () => Object.create(mongoose.Types.ObjectId.prototype)],
    ])('denies objects with %s', async (_description, createValue) => {
      expectDenied(await executePolicy(
        isOwner('authorId'),
        { authorId: createValue() },
        { user: { id: createValue() } },
      ));
    });

    test.each([
      ['user-1', 'user-1'], [0, 0], [123, '123'],
      [new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011'],
      ['507f1f77bcf86cd799439011', new mongoose.Types.ObjectId('507f1f77bcf86cd799439011')],
      [new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'), new mongoose.Types.ObjectId('507f1f77bcf86cd799439011')],
    ])('preserves scalar and ObjectId ownership %#', async (ownerId, userId) => {
      const { result } = await executePolicy(isOwner('authorId'), { authorId: ownerId }, { user: { id: userId } });
      expect(result.errors).toBeUndefined();
    });

    test('preserves authentic ObjectIds through the deep root rules import', async () => {
      const id = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
      const { result } = await executePolicy(
        deepIsOwner('authorId'),
        { authorId: id },
        { user: { id: id.toHexString() } },
      );
      expect(result.errors).toBeUndefined();
    });

    test('denies different ObjectIds', async () => {
      expectDenied(await executePolicy(isOwner('authorId'),
        { authorId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439011') },
        { user: { id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439012') } }));
    });
  });

  describe('permission claims', () => {
    test.each(['posts:read-extra', 'posts:*', '*', 'posts:read', {}, ['*', null]].map(value => [value]))('denies malformed claims %#', async (permissions) => {
      expectDenied(await executePolicy(requirePermission('posts:read'), {}, { user: { permissions } }));
    });

    test.each([['posts:read'], ['*']].map(value => [value]))('preserves exact permission and wildcard entries %#', async (permissions) => {
      const { result } = await executePolicy(requirePermission('posts:read'), {}, { user: { permissions } });
      expect(result.errors).toBeUndefined();
    });

    test('does not match prefixes or embedded wildcard characters in array entries', () => {
      for (const permissions of [['posts:read-extra'], ['posts:*']]) {
        expect(() => requirePermission('posts:read')(null, {}, { user: { permissions } })).toThrow(ForbiddenError);
      }
    });

    test.each([undefined, null, '', [], ['posts:read', null]].map(value => [value]))('rejects malformed required permissions %#', (permission) => {
      expect(() => requirePermission(permission)).toThrow(TypeError);
    });
  });

  describe('required role configuration', () => {
    test.each([undefined, null, '', [], [undefined], ['admin', null], 0].map(value => [value]))('rejects invalid required roles %#', (role) => {
      expect(() => requireRole(role)).toThrow(TypeError);
    });

    test('preserves exact role matches while denying missing or different claims', async () => {
      for (const role of [undefined, null, 'admin-extra', ['admin']]) {
        expectDenied(await executePolicy(requireRole(['admin', 'editor']), {}, { user: { role } }));
      }
      for (const role of ['admin', 'editor']) {
        const { result } = await executePolicy(requireRole(['admin', 'editor']), {}, { user: { role } });
        expect(result.errors).toBeUndefined();
      }
    });
  });

  describe('identity comparisons', () => {
    const hex = '507f1f77bcf86cd799439011';
    const { ObjectId } = mongoose.Types;
    const values = () => ({ ownerId: new ObjectId(hex), blockedUsers: [new ObjectId(hex)], levels: [1] });
    const parents = [
      ['document', () => {
        const document = new mongoose.Document({}, new mongoose.Schema({
          ownerId: mongoose.Schema.Types.ObjectId,
          blockedUsers: [mongoose.Schema.Types.ObjectId],
          levels: [Number],
        }));
        document.set(values());
        return document;
      }],
      ['aggregate result', values],
    ];
    const owner = { eq: [{ ref: 'parent.ownerId' }, { ref: 'ctx.user.id' }] };
    const blocked = { in: [{ ref: 'ctx.user.id' }, { ref: 'parent.blockedUsers' }] };

    test.each(parents)('%s parents compare ObjectIds by value in eq, in and not', async (_kind, createParent) => {
      for (const id of [hex, new ObjectId(hex)]) {
        const ctx = { user: { id } };
        expect(evaluateExpression(owner, { parent: createParent(), ctx })).toBe(true);
        expect(evaluateExpression(blocked, { parent: createParent(), ctx })).toBe(true);
        expectDenied(await executePolicy({ not: blocked }, createParent(), ctx));
      }
      const ctx = { user: { id: '507f1f77bcf86cd799439012' } };
      expect(evaluateExpression(owner, { parent: createParent(), ctx })).toBe(false);
      const { result } = await executePolicy({ not: blocked }, createParent(), ctx);
      expect(result.errors).toBeUndefined();
    });

    test.each(parents)('%s parents compare membership strictly, without casting', async (_kind, createParent) => {
      expect(evaluateExpression({ in: ['1', { ref: 'parent.levels' }] }, { parent: createParent() })).toBe(false);
      expect(evaluateExpression({ in: [1, { ref: 'parent.levels' }] }, { parent: createParent() })).toBe(true);
      // A string never matches a list of numbers, and negating the mismatch must not grant.
      const notBlocked = { not: { in: [{ ref: 'ctx.user.id' }, { ref: 'parent.levels' }] } };
      expect(evaluateExpression(notBlocked, { parent: createParent(), ctx: { user: { id: '1' } } })).toBe(false);
      expectDenied(await executePolicy(notBlocked, createParent(), { user: { id: '1' } }));
    });

    test.each([
      [{ not: { eq: [{ ref: 'ctx.user.roles' }, 'banned'] } }, { user: { roles: ['banned'] } }],
      [{ not: { eq: [{ ref: 'ctx.user.id' }, 42] } }, { user: { id: '42' } }],
      [{ not: { eq: [{ ref: 'ctx.user.active' }, 'true'] } }, { user: { active: true } }],
      [{ not: { in: [{ ref: 'ctx.user.id' }, [1, 2]] } }, { user: { id: '1' } }],
      [{ not: { in: [{ ref: 'ctx.user.id' }, { ref: 'ctx.blocked' }] } }, { user: { id: '42' }, blocked: [null, 42] }],
      [{ not: { in: [{ ref: 'ctx.user.id' }, { ref: 'ctx.blocked' }] } }, { user: { id: '42' }, blocked: ['x', 42] }],
    ])('comparisons between different types never grant through negation %#', async (expression, ctx) => {
      expect(evaluateExpression(expression, { ctx })).toBe(false);
      expectDenied(await executePolicy(expression, {}, ctx));
    });

    test('null stays comparable with values of any type', () => {
      const context = { parent: { deletedAt: new Date(0), tags: ['a'], title: 'title' } };
      for (const ref of ['parent.deletedAt', 'parent.tags', 'parent.title']) {
        expect(evaluateExpression({ eq: [{ ref }, null] }, context)).toBe(false);
        expect(evaluateExpression({ not: { eq: [{ ref }, null] } }, context)).toBe(true);
      }
      expect(evaluateExpression({ not: { in: [{ ref: 'parent.title' }, [null, 'draft']] } }, context)).toBe(true);
      expect(evaluateExpression({ in: [{ ref: 'parent.title' }, [null, 'title']] }, context)).toBe(true);
    });

    test('literal membership lists accept ObjectIds and bigints', () => {
      const ctx = { user: { id: hex, level: 2n } };
      expect(evaluateExpression({ in: [{ ref: 'ctx.user.id' }, [new ObjectId(hex)]] }, { ctx })).toBe(true);
      expect(evaluateExpression({ in: [{ ref: 'ctx.user.level' }, [1n, 2n]] }, { ctx })).toBe(true);
    });

    test('a list or plain object is not a member value, even under negation', async () => {
      for (const roles of [['admin'], { role: 'admin' }]) {
        const expression = { not: { in: [{ ref: 'ctx.user.roles' }, ['banned']] } };
        expect(evaluateExpression(expression, { ctx: { user: { roles } } })).toBe(false);
        expectDenied(await executePolicy(expression, {}, { user: { roles } }));
      }
    });

    test('other objects keep strict identity', () => {
      const date = new Date(0);
      expect(evaluateExpression({ eq: [{ ref: 'ctx.at' }, date] }, { ctx: { at: date } })).toBe(true);
      expect(evaluateExpression({ eq: [{ ref: 'ctx.at' }, new Date(0)] }, { ctx: { at: date } })).toBe(false);
    });
  });

  describe('expression rules', () => {
    test('keep the validated policy when the configured object changes', () => {
      const expression = { eq: [{ ref: 'ctx.user.role' }, 'admin'] };
      const rule = createRuleFromExpression(expression);
      expression.eq[1] = 'guest';
      expect(rule(null, {}, { user: { role: 'admin' } })).toBe(true);
      expect(rule(null, {}, { user: { role: 'guest' } })).toBe(false);
      expression.eq = null;
      expect(rule(null, {}, { user: { role: 'admin' } })).toBe(true);
    });

    test('keep the validated membership list when the configured list changes', () => {
      const allowedUsers = ['user-1'];
      const rule = createRuleFromExpression({ in: [{ ref: 'ctx.user.id' }, allowedUsers] });
      allowedUsers.push({ ref: 'ctx.user.id' }, 'user-2');
      allowedUsers[0] = 'user-3';
      expect(rule(null, {}, { user: { id: 'user-1' } })).toBe(true);
      expect(rule(null, {}, { user: { id: 'user-2' } })).toBe(false);
    });
  });

  describe('rule helpers', () => {
    test('composition helpers require at least one rule', () => {
      const none = [];
      expect(() => composeRules(...none)).toThrow(TypeError);
      expect(() => anyRule(...none)).toThrow(TypeError);
    });

    test('anyRule throws the last denial after every rule denies', async () => {
      const adminOrOwner = anyRule(requireRole('ADMIN'), isOwner('authorId'));
      const ctx = { user: { id: 'user-1', role: 'USER' } };
      await expect(adminOrOwner({ authorId: 'user-1' }, {}, ctx)).resolves.toBe(true);
      await expect(adminOrOwner({ authorId: 'user-2' }, {}, ctx)).rejects.toThrow('Requires role: ADMIN');
      await expect(anyRule(requireAuth(), deny('Closed'))({}, {}, {})).rejects.toThrow('Closed');
      await expect(anyRule(deny('Closed'), requireAuth())({}, {}, {})).rejects.toThrow(UnauthenticatedError);
      await expect(anyRule(deny('Closed'), () => Promise.reject(undefined))({}, {}, {})).resolves.toBe(false);
      await expect(anyRule(deny('Closed'), () => false)({}, {}, {})).rejects.toThrow('Closed');
    });

    test('built-in rules still throw their denial when called directly', () => {
      expect(() => requireAuth()(null, {}, {})).toThrow(UnauthenticatedError);
      expect(() => requireRole('ADMIN')(null, {}, { user: { role: 'USER' } })).toThrow('Requires role: ADMIN');
      expect(() => isOwner()(null, {}, null)).toThrow(UnauthenticatedError);
      expect(() => deny('Closed')()).toThrow(ForbiddenError);
    });

    test('requirePermission reads claims on every evaluation, even with a long-lived context', () => {
      const ctx = { user: { permissions: ['posts:read'] } };
      const rule = requirePermission(['posts:read', 'posts:write']);
      expect(() => rule(null, {}, ctx)).toThrow('Missing permission: posts:write');
      ctx.user.permissions.push('posts:write');
      for (let call = 0; call < 3; call++) expect(rule(null, {}, ctx)).toBe(true);
      ctx.user.permissions.splice(0, 1);
      expect(() => rule(null, {}, ctx)).toThrow('Missing permission: posts:read');
      ctx.user.permissions.push('posts:read', '');
      expect(() => rule(null, {}, ctx)).toThrow('User permissions must be an array of nonempty strings');
    });

    test('requirePermission keeps denying malformed claims used repeatedly in a request', () => {
      const ctx = { user: { permissions: ['*', null] } };
      const rule = requirePermission('posts:read');
      for (let call = 0; call < 3; call++) expect(() => rule(null, {}, ctx)).toThrow(ForbiddenError);
    });
  });

  describe('schema integration', () => {
    const createPostType = (fields = {}) => new GraphQLObjectType({
      name: 'Post',
      fields: {
        content: { type: GraphQLString },
        author: { type: GraphQLString, extensions: { relation: { embedded: true } } },
        ...fields,
      },
    });
    const buildPostSchema = (Post) => new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { post: { type: Post, resolve: () => ({ content: 'private content', author: 'author' }) } },
      }),
    });
    const readContent = schema => graphql({ schema, source: '{ post { content } }' });

    test('DENY leaves Simfinity field metadata introspection readable', async () => {
      const schema = buildPostSchema(createPostType());
      createAuthPlugin({}, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
      const result = await graphql({
        schema,
        source: '{ __type(name: "Post") { fields { name extensions { readOnly relation { embedded } } } } }',
      });
      expect(result.errors).toBeUndefined();
      expect(result.data.__type.fields).toEqual([
        { name: 'content', extensions: { readOnly: null, relation: null } },
        { name: 'author', extensions: { readOnly: null, relation: { embedded: true } } },
      ]);
    });

    test('a schema no auth plugin processed keeps the rules of its shared fields', async () => {
      const Post = createPostType();
      const protectedSchema = buildPostSchema(Post);
      const otherSchema = buildPostSchema(Post);
      createAuthPlugin({ Post: { content: deny() } }, { defaultPolicy: 'ALLOW' })
        .onSchemaChange({ schema: protectedSchema });
      for (const schema of [protectedSchema, otherSchema, new GraphQLSchema(protectedSchema.toConfig())]) {
        const result = await readContent(schema);
        expect(result.data.post.content).toBeNull();
        expect(result.errors[0].extensions.code).toBe('FORBIDDEN');
      }
    });

    test('permission maps that name Simfinity field metadata types still protect them', async () => {
      const schema = buildPostSchema(createPostType());
      createAuthPlugin({ FieldExtensionsType: { '*': requireAuth() } }, { defaultPolicy: 'ALLOW' })
        .onSchemaChange({ schema });
      const source = '{ __type(name: "Post") { fields { extensions { readOnly } } } }';
      const anonymous = await graphql({ schema, source, contextValue: {} });
      expect(anonymous.errors[0].extensions.code).toBe('UNAUTHENTICATED');
      const signedIn = await graphql({ schema, source, contextValue: { user: { id: 'user-1' } } });
      expect(signedIn.errors).toBeUndefined();
    });

    test('wraps each shared field once for every schema built from the same types', async () => {
      let ruleCalls = 0;
      const plugin = createAuthPlugin({
        Post: { content: () => { ruleCalls++; return true; } },
      }, { defaultPolicy: 'ALLOW' });
      const schema = buildPostSchema(createPostType());
      const schemas = [schema, new GraphQLSchema(schema.toConfig()), new GraphQLSchema(schema.toConfig())];
      for (const current of schemas) plugin.onSchemaChange({ schema: current });
      for (const current of schemas) {
        ruleCalls = 0;
        const result = await readContent(current);
        expect(result.errors).toBeUndefined();
        expect(ruleCalls).toBe(1);
      }
    });

    test('separate plugin instances keep separate permission maps', async () => {
      const Post = createPostType();
      const publicSchema = buildPostSchema(Post);
      const privateSchema = buildPostSchema(Post);
      createAuthPlugin({ Query: { post: allow() }, Post: { content: allow() } }, { defaultPolicy: 'DENY' })
        .onSchemaChange({ schema: publicSchema });
      createAuthPlugin({ Post: { content: deny() } }, { defaultPolicy: 'ALLOW' })
        .onSchemaChange({ schema: privateSchema });
      const allowed = await readContent(publicSchema);
      expect(allowed.errors).toBeUndefined();
      expect(allowed.data.post.content).toBe('private content');
      const denied = await readContent(privateSchema);
      expect(denied.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    test('wraps a field again after its resolver is replaced', async () => {
      const Post = createPostType();
      const schema = buildPostSchema(Post);
      const plugin = createAuthPlugin({ Post: { content: deny() } }, { defaultPolicy: 'ALLOW' });
      plugin.onSchemaChange({ schema });
      Post.getFields().content.resolve = () => 'replaced';
      const copy = new GraphQLSchema(schema.toConfig());
      plugin.onSchemaChange({ schema: copy });
      const result = await readContent(copy);
      expect(result.data.post.content).toBeNull();
      expect(result.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    test('leaves allowed fields without rules or query paths untouched', () => {
      const resolve = () => 'private content';
      const Post = createPostType({ summary: { type: GraphQLString, resolve } });
      createAuthPlugin({ Post: { content: allow() } }, { defaultPolicy: 'ALLOW' })
        .onSchemaChange({ schema: buildPostSchema(Post) });
      expect(Post.getFields().summary.resolve).toBe(resolve);
      expect(Post.getFields().author.resolve).toBeUndefined();
      expect(Post.getFields().content.resolve).toBeTypeOf('function');
    });

    test('resolves synchronously when every rule is synchronous', () => {
      const Post = createPostType();
      const schema = buildPostSchema(Post);
      createAuthPlugin({ Post: { content: [allow(), { eq: [1, 1] }] } }, { defaultPolicy: 'DENY' })
        .onSchemaChange({ schema });
      const info = { schema, fieldName: 'content', parentType: Post };
      expect(Post.getFields().content.resolve({ content: 'private content' }, {}, {}, info)).toBe('private content');
    });

    test('denied non-null fields still reach GraphQL as rejections', async () => {
      const Post = createPostType({
        secret: { type: new GraphQLNonNull(GraphQLString), resolve: () => 'secret' },
        title: { type: GraphQLString, resolve: async () => 'title' },
      });
      const schema = buildPostSchema(Post);
      createAuthPlugin({ Post: { secret: deny() } }, { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema });
      const info = { schema, fieldName: 'secret', parentType: Post };
      await expect(Post.getFields().secret.resolve({}, {}, {}, info)).rejects.toThrow(ForbiddenError);
      const result = await graphql({ schema, source: '{ post { title secret } }' });
      expect(result.data).toEqual({ post: null });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    test('warns once when permissions name a Query type the schema calls differently', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'RootQueryType',
            fields: { series: { type: GraphQLString, resolve: () => 'series' } },
          }),
        });
        const plugin = createAuthPlugin({ Query: { series: deny() } }, { defaultPolicy: 'ALLOW' });
        plugin.onSchemaChange({ schema });
        plugin.onSchemaChange({ schema: new GraphQLSchema(schema.toConfig()) });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('"RootQueryType"');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('graphql-middleware factories', () => {
    // graphql-middleware loads the CommonJS graphql build, so the schema must use it too.
    const require = createRequire(import.meta.url);
    const { applyMiddleware } = require('graphql-middleware');
    const cjs = require('graphql');

    test('createFieldMiddleware applies wildcard rules and the default policy to every field', async () => {
      const {
        GraphQLObjectType, GraphQLSchema, GraphQLString, graphql,
      } = cjs;
      const Post = new GraphQLObjectType({
        name: 'Post',
        fields: { title: { type: GraphQLString }, content: { type: GraphQLString } },
      });
      const baseSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            post: { type: Post, resolve: () => ({ title: 'public title', content: 'private content' }) },
            secret: { type: GraphQLString, resolve: () => 'secret' },
          },
        }),
      });
      const permissions = { Query: { post: allow() }, Post: { '*': requireAuth(), title: allow() } };
      const schema = applyMiddleware(baseSchema, createFieldMiddleware(permissions));

      const anonymous = await graphql({ schema, source: '{ post { title content } secret }', contextValue: {} });
      expect(anonymous.data).toEqual({ post: { title: 'public title', content: null }, secret: null });
      expect(anonymous.errors.map(error => error.extensions.code).sort()).toEqual(['FORBIDDEN', 'UNAUTHENTICATED']);

      const signedIn = await graphql({ schema, source: '{ post { content } }', contextValue: { user: { id: 'user-1' } } });
      expect(signedIn.errors).toBeUndefined();
      expect(signedIn.data.post.content).toBe('private content');
    });
  });
});

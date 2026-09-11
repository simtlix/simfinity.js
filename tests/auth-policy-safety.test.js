import { describe, test, expect } from 'vitest';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, graphql } from 'graphql';
import mongoose from 'mongoose';
import auth from '../src/auth/index.js';

const {
  createAuthPlugin, createAuthMiddleware, createFieldMiddleware,
  evaluateExpression, isPolicyExpression, createRuleFromExpression,
  composeRules, anyRule, createRule, isOwner, requireRole, requirePermission, ForbiddenError,
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
      { in: [{ ref: 'ctx.user.id' }, [undefined]] },
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
      ['user-1', 'user-1'], [0, 0], [123, '123'],
      [new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011'],
      ['507f1f77bcf86cd799439011', new mongoose.Types.ObjectId('507f1f77bcf86cd799439011')],
      [new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'), new mongoose.Types.ObjectId('507f1f77bcf86cd799439011')],
    ])('preserves scalar and ObjectId ownership %#', async (ownerId, userId) => {
      const { result } = await executePolicy(isOwner('authorId'), { authorId: ownerId }, { user: { id: userId } });
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
});

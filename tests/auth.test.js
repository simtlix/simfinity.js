import {
  describe, test, expect, beforeEach,
} from 'vitest';
import { auth } from '../src/index.js';
import SimfinityError from '../src/errors/simfinity.error.js';

const {
  createAuthMiddleware,
  resolvePath,
  requireAuth,
  requireRole,
  requirePermission,
  composeRules,
  anyRule,
  isOwner,
  allow,
  deny,
  evaluateExpression,
  isPolicyExpression,
  createRuleFromExpression,
  UnauthenticatedError,
  ForbiddenError,
} = auth;

// Mock resolve function for testing middleware
const mockResolve = (returnValue = 'resolved') => {
  return async () => returnValue;
};

// Mock GraphQL info object
const createMockInfo = (typeName, fieldName) => ({
  parentType: { name: typeName },
  fieldName,
});

describe('Auth Module Export', () => {
  test('should export auth object with all expected members', () => {
    expect(auth).toBeDefined();
    expect(auth.createAuthMiddleware).toBeDefined();
    expect(auth.resolvePath).toBeDefined();
    expect(auth.requireAuth).toBeDefined();
    expect(auth.requireRole).toBeDefined();
    expect(auth.requirePermission).toBeDefined();
    expect(auth.composeRules).toBeDefined();
    expect(auth.anyRule).toBeDefined();
    expect(auth.isOwner).toBeDefined();
    expect(auth.allow).toBeDefined();
    expect(auth.deny).toBeDefined();
    expect(auth.evaluateExpression).toBeDefined();
    expect(auth.isPolicyExpression).toBeDefined();
    expect(auth.createRuleFromExpression).toBeDefined();
    expect(auth.UnauthenticatedError).toBeDefined();
    expect(auth.ForbiddenError).toBeDefined();
  });
});

describe('resolvePath Utility', () => {
  test('should resolve simple path', () => {
    const obj = { user: { id: '123' } };
    expect(resolvePath(obj, 'user')).toEqual({ id: '123' });
    expect(resolvePath(obj, 'user.id')).toBe('123');
  });

  test('should resolve deeply nested path', () => {
    const obj = { a: { b: { c: { d: 'value' } } } };
    expect(resolvePath(obj, 'a.b.c.d')).toBe('value');
  });

  test('should return undefined for missing path', () => {
    const obj = { user: { id: '123' } };
    expect(resolvePath(obj, 'user.name')).toBeUndefined();
    expect(resolvePath(obj, 'missing.path')).toBeUndefined();
  });

  test('should return undefined for null/undefined in path', () => {
    const obj = { user: null };
    expect(resolvePath(obj, 'user.id')).toBeUndefined();
  });

  test('should support function as path resolver', () => {
    const obj = { user: { profile: { id: 'abc' } } };
    expect(resolvePath(obj, (o) => o.user.profile.id)).toBe('abc');
  });

  test('should return undefined for non-string non-function path', () => {
    const obj = { user: { id: '123' } };
    expect(resolvePath(obj, 123)).toBeUndefined();
    expect(resolvePath(obj, null)).toBeUndefined();
  });
});

describe('Auth Errors', () => {
  test('UnauthenticatedError should have correct code and status', () => {
    const error = new UnauthenticatedError('Test message');
    expect(error.message).toBe('Test message');
    expect(error.extensions.code).toBe('UNAUTHENTICATED');
    expect(error.extensions.status).toBe(401);
    expect(error).toBeInstanceOf(SimfinityError);
  });

  test('ForbiddenError should have correct code and status', () => {
    const error = new ForbiddenError('Test message');
    expect(error.message).toBe('Test message');
    expect(error.extensions.code).toBe('FORBIDDEN');
    expect(error.extensions.status).toBe(403);
    expect(error).toBeInstanceOf(SimfinityError);
  });
});

describe('Rule Helpers', () => {
  describe('requireAuth', () => {
    test('should allow when ctx.user exists', async () => {
      const rule = requireAuth();
      const ctx = { user: { id: '1', name: 'Test User' } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should throw UnauthenticatedError when ctx.user is missing', () => {
      const rule = requireAuth();
      const ctx = {};
      expect(() => rule(null, {}, ctx, {})).toThrow(UnauthenticatedError);
    });

    test('should throw UnauthenticatedError when ctx is missing', () => {
      const rule = requireAuth();
      expect(() => rule(null, {}, null, {})).toThrow(UnauthenticatedError);
    });

    test('should support custom user path', async () => {
      const rule = requireAuth('auth.currentUser');
      const ctx = { auth: { currentUser: { id: '1', name: 'Test' } } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should throw when custom user path is not found', () => {
      const rule = requireAuth('auth.currentUser');
      const ctx = { user: { id: '1' } }; // wrong path
      expect(() => rule(null, {}, ctx, {})).toThrow(UnauthenticatedError);
    });

    test('should support deeply nested user path', async () => {
      const rule = requireAuth('session.data.user');
      const ctx = { session: { data: { user: { id: '1' } } } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });
  });

  describe('requireRole', () => {
    test('should allow when user has required role', async () => {
      const rule = requireRole('ADMIN');
      const ctx = { user: { id: '1', role: 'ADMIN' } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should allow when user has one of required roles (array)', async () => {
      const rule = requireRole(['ADMIN', 'EDITOR']);
      const ctx = { user: { id: '1', role: 'EDITOR' } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should throw ForbiddenError when user lacks role', () => {
      const rule = requireRole('ADMIN');
      const ctx = { user: { id: '1', role: 'USER' } };
      expect(() => rule(null, {}, ctx, {})).toThrow(ForbiddenError);
    });

    test('should throw UnauthenticatedError when user is missing', () => {
      const rule = requireRole('ADMIN');
      const ctx = {};
      expect(() => rule(null, {}, ctx, {})).toThrow(UnauthenticatedError);
    });

    test('should support custom user path and role path', async () => {
      const rule = requireRole('ADMIN', { userPath: 'auth.user', rolePath: 'profile.role' });
      const ctx = { auth: { user: { id: '1', profile: { role: 'ADMIN' } } } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should deny when role at custom path does not match', () => {
      const rule = requireRole('ADMIN', { userPath: 'auth.user', rolePath: 'profile.role' });
      const ctx = { auth: { user: { id: '1', profile: { role: 'USER' } } } };
      expect(() => rule(null, {}, ctx, {})).toThrow(ForbiddenError);
    });
  });

  describe('requirePermission', () => {
    test('should allow when user has required permission', async () => {
      const rule = requirePermission('posts:read');
      const ctx = { user: { id: '1', permissions: ['posts:read', 'posts:write'] } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should allow when user has all required permissions (array)', async () => {
      const rule = requirePermission(['posts:read', 'posts:write']);
      const ctx = { user: { id: '1', permissions: ['posts:read', 'posts:write', 'users:read'] } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should allow when user has wildcard permission', async () => {
      const rule = requirePermission('posts:read');
      const ctx = { user: { id: '1', permissions: ['*'] } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should throw ForbiddenError when user lacks permission', () => {
      const rule = requirePermission('posts:delete');
      const ctx = { user: { id: '1', permissions: ['posts:read'] } };
      expect(() => rule(null, {}, ctx, {})).toThrow(ForbiddenError);
    });

    test('should support custom user path and permissions path', async () => {
      const rule = requirePermission('posts:read', { 
        userPath: 'session.user', 
        permissionsPath: 'access.grants',
      });
      const ctx = { session: { user: { id: '1', access: { grants: ['posts:read'] } } } };
      const result = await rule(null, {}, ctx, {});
      expect(result).toBe(true);
    });
  });

  describe('composeRules', () => {
    test('should pass when all rules pass', async () => {
      const rule1 = () => true;
      const rule2 = () => true;
      const composed = composeRules(rule1, rule2);
      const result = await composed(null, {}, { user: {} }, {});
      expect(result).toBe(true);
    });

    test('should fail when any rule returns false', async () => {
      const rule1 = () => true;
      const rule2 = () => false;
      const composed = composeRules(rule1, rule2);
      const result = await composed(null, {}, { user: {} }, {});
      expect(result).toBe(false);
    });

    test('should propagate errors from rules', async () => {
      const rule1 = () => true;
      const rule2 = () => { throw new ForbiddenError('Test'); };
      const composed = composeRules(rule1, rule2);
      await expect(composed(null, {}, { user: {} }, {})).rejects.toThrow(ForbiddenError);
    });

    test('should work with async rules', async () => {
      const rule1 = async () => { await Promise.resolve(); return true; };
      const rule2 = async () => { await Promise.resolve(); return true; };
      const composed = composeRules(rule1, rule2);
      const result = await composed(null, {}, { user: {} }, {});
      expect(result).toBe(true);
    });
  });

  describe('anyRule', () => {
    test('should pass when any rule passes', async () => {
      const rule1 = () => false;
      const rule2 = () => true;
      const combined = anyRule(rule1, rule2);
      const result = await combined(null, {}, { user: {} }, {});
      expect(result).toBe(true);
    });

    test('should fail when all rules fail', async () => {
      const rule1 = () => false;
      const rule2 = () => false;
      const combined = anyRule(rule1, rule2);
      const result = await combined(null, {}, { user: {} }, {});
      expect(result).toBe(false);
    });

    test('should not throw if at least one rule passes', async () => {
      const rule1 = () => { throw new ForbiddenError('Test'); };
      const rule2 = () => true;
      const combined = anyRule(rule1, rule2);
      const result = await combined(null, {}, { user: {} }, {});
      expect(result).toBe(true);
    });
  });

  describe('isOwner', () => {
    test('should return true when user owns resource', async () => {
      const rule = isOwner('authorId', 'id');
      const parent = { authorId: '123' };
      const ctx = { user: { id: '123' } };
      const result = await rule(parent, {}, ctx, {});
      expect(result).toBe(true);
    });

    test('should return false when user does not own resource', async () => {
      const rule = isOwner('authorId', 'id');
      const parent = { authorId: '123' };
      const ctx = { user: { id: '456' } };
      const result = await rule(parent, {}, ctx, {});
      expect(result).toBe(false);
    });

    test('should work with custom field extractors', async () => {
      const rule = isOwner(
        (parent) => parent.owner.userId,
        (user) => user.profile.id,
      );
      const parent = { owner: { userId: 'abc' } };
      const ctx = { user: { profile: { id: 'abc' } } };
      const result = await rule(parent, {}, ctx, {});
      expect(result).toBe(true);
    });
  });

  describe('allow and deny', () => {
    test('allow should always return true', async () => {
      const rule = allow();
      const result = await rule(null, {}, {}, {});
      expect(result).toBe(true);
    });

    test('deny should always throw ForbiddenError', () => {
      const rule = deny('Custom message');
      expect(() => rule(null, {}, {}, {})).toThrow(ForbiddenError);
      expect(() => rule(null, {}, {}, {})).toThrow('Custom message');
    });
  });
});

describe('Policy Expression Evaluator', () => {
  describe('isPolicyExpression', () => {
    test('should return true for objects with operator keys', () => {
      expect(isPolicyExpression({ eq: [1, 1] })).toBe(true);
      expect(isPolicyExpression({ allOf: [true] })).toBe(true);
      expect(isPolicyExpression({ anyOf: [true] })).toBe(true);
      expect(isPolicyExpression({ not: true })).toBe(true);
      expect(isPolicyExpression({ in: ['a', ['a', 'b']] })).toBe(true);
    });

    test('should return false for non-expressions', () => {
      expect(isPolicyExpression(null)).toBe(false);
      expect(isPolicyExpression(() => {})).toBe(false);
      expect(isPolicyExpression({ foo: 'bar' })).toBe(false);
      expect(isPolicyExpression('string')).toBe(false);
      expect(isPolicyExpression(123)).toBe(false);
    });
  });

  describe('evaluateExpression', () => {
    const context = {
      parent: { published: true, authorId: 'user1' },
      args: { limit: 10 },
      ctx: { user: { id: 'user1', role: 'ADMIN' } },
    };

    describe('boolean literals', () => {
      test('should return true for true', () => {
        expect(evaluateExpression(true, context)).toBe(true);
      });

      test('should return false for false', () => {
        expect(evaluateExpression(false, context)).toBe(false);
      });
    });

    describe('eq operator', () => {
      test('should return true when values are equal', () => {
        expect(evaluateExpression({ eq: [1, 1] }, context)).toBe(true);
        expect(evaluateExpression({ eq: ['a', 'a'] }, context)).toBe(true);
      });

      test('should return false when values are not equal', () => {
        expect(evaluateExpression({ eq: [1, 2] }, context)).toBe(false);
      });

      test('should work with references', () => {
        expect(evaluateExpression({
          eq: [{ ref: 'parent.published' }, true],
        }, context)).toBe(true);

        expect(evaluateExpression({
          eq: [{ ref: 'parent.authorId' }, { ref: 'ctx.user.id' }],
        }, context)).toBe(true);
      });
    });

    describe('in operator', () => {
      test('should return true when value is in array', () => {
        expect(evaluateExpression({
          in: ['a', ['a', 'b', 'c']],
        }, context)).toBe(true);
      });

      test('should return false when value is not in array', () => {
        expect(evaluateExpression({
          in: ['d', ['a', 'b', 'c']],
        }, context)).toBe(false);
      });

      test('should work with references', () => {
        const ctx = {
          ...context,
          ctx: { user: { id: 'user1', roles: ['ADMIN', 'USER'] } },
        };
        expect(evaluateExpression({
          in: ['ADMIN', { ref: 'ctx.user.roles' }],
        }, ctx)).toBe(true);
      });
    });

    describe('allOf operator', () => {
      test('should return true when all expressions are true', () => {
        expect(evaluateExpression({
          allOf: [
            { eq: [1, 1] },
            { eq: [2, 2] },
          ],
        }, context)).toBe(true);
      });

      test('should return false when any expression is false', () => {
        expect(evaluateExpression({
          allOf: [
            { eq: [1, 1] },
            { eq: [1, 2] },
          ],
        }, context)).toBe(false);
      });
    });

    describe('anyOf operator', () => {
      test('should return true when any expression is true', () => {
        expect(evaluateExpression({
          anyOf: [
            { eq: [1, 2] },
            { eq: [1, 1] },
          ],
        }, context)).toBe(true);
      });

      test('should return false when all expressions are false', () => {
        expect(evaluateExpression({
          anyOf: [
            { eq: [1, 2] },
            { eq: [2, 3] },
          ],
        }, context)).toBe(false);
      });
    });

    describe('not operator', () => {
      test('should negate true to false', () => {
        expect(evaluateExpression({ not: true }, context)).toBe(false);
      });

      test('should negate false to true', () => {
        expect(evaluateExpression({ not: false }, context)).toBe(true);
      });

      test('should negate expressions', () => {
        expect(evaluateExpression({
          not: { eq: [1, 2] },
        }, context)).toBe(true);
      });
    });

    describe('fail closed behavior', () => {
      test('should return false for unknown operators', () => {
        expect(evaluateExpression({ unknownOp: [1, 1] }, context)).toBe(false);
      });

      test('should return false for null', () => {
        expect(evaluateExpression(null, context)).toBe(false);
      });

      test('should return false for undefined', () => {
        expect(evaluateExpression(undefined, context)).toBe(false);
      });

      test('should return false for invalid ref paths', () => {
        expect(evaluateExpression({
          eq: [{ ref: 'invalid.path' }, 'value'],
        }, context)).toBe(false);
      });

      test('should return false for non-allowed root refs', () => {
        expect(evaluateExpression({
          eq: [{ ref: 'process.env.SECRET' }, 'value'],
        }, context)).toBe(false);
      });
    });

    describe('complex expressions', () => {
      test('should evaluate example from requirements', () => {
        const expr = {
          anyOf: [
            { eq: [{ ref: 'parent.published' }, true] },
            { eq: [{ ref: 'parent.authorId' }, { ref: 'ctx.user.id' }] },
          ],
        };
        expect(evaluateExpression(expr, context)).toBe(true);

        // Test when published is false but user is author
        const ctx2 = {
          parent: { published: false, authorId: 'user1' },
          args: {},
          ctx: { user: { id: 'user1' } },
        };
        expect(evaluateExpression(expr, ctx2)).toBe(true);

        // Test when both conditions fail
        const ctx3 = {
          parent: { published: false, authorId: 'user2' },
          args: {},
          ctx: { user: { id: 'user1' } },
        };
        expect(evaluateExpression(expr, ctx3)).toBe(false);
      });
    });
  });

  describe('createRuleFromExpression', () => {
    test('should create a rule function from expression', async () => {
      const rule = createRuleFromExpression({
        eq: [{ ref: 'parent.published' }, true],
      });
      
      const result = await rule({ published: true }, {}, {}, {});
      expect(result).toBe(true);
    });
  });
});

describe('createAuthMiddleware', () => {
  describe('field rule resolution', () => {
    test('should use exact field rule when available', async () => {
      let fieldRuleCalled = false;
      let wildcardRuleCalled = false;

      const permissions = {
        User: {
          '*': () => { wildcardRuleCalled = true; return true; },
          email: () => { fieldRuleCalled = true; return true; },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'email'));

      expect(fieldRuleCalled).toBe(true);
      expect(wildcardRuleCalled).toBe(false);
    });

    test('should fallback to wildcard when no exact field rule', async () => {
      let wildcardRuleCalled = false;

      const permissions = {
        User: {
          '*': () => { wildcardRuleCalled = true; return true; },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'name'));

      expect(wildcardRuleCalled).toBe(true);
    });
  });

  describe('default policy', () => {
    test('should deny by default when no rules match (defaultPolicy: DENY)', async () => {
      const permissions = {};
      const middleware = createAuthMiddleware(permissions, { defaultPolicy: 'DENY' });

      await expect(
        middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'email')),
      ).rejects.toThrow(ForbiddenError);
    });

    test('should allow when no rules match (defaultPolicy: ALLOW)', async () => {
      const permissions = {};
      const middleware = createAuthMiddleware(permissions, { defaultPolicy: 'ALLOW' });

      const result = await middleware(
        mockResolve('success'),
        {},
        {},
        {},
        createMockInfo('User', 'email'),
      );
      expect(result).toBe('success');
    });
  });

  describe('rule execution', () => {
    test('should allow when function rule returns true', async () => {
      const permissions = {
        User: {
          email: () => true,
        },
      };

      const middleware = createAuthMiddleware(permissions);
      const result = await middleware(
        mockResolve('success'),
        {},
        {},
        {},
        createMockInfo('User', 'email'),
      );
      expect(result).toBe('success');
    });

    test('should allow when function rule returns void/undefined', async () => {
      const permissions = {
        User: {
          email: () => {
            // Returns undefined (void)
          },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      const result = await middleware(
        mockResolve('success'),
        {},
        {},
        {},
        createMockInfo('User', 'email'),
      );
      expect(result).toBe('success');
    });

    test('should deny when function rule returns false', async () => {
      const permissions = {
        User: {
          email: () => false,
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await expect(
        middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'email')),
      ).rejects.toThrow(ForbiddenError);
    });

    test('should deny when function rule throws', async () => {
      const permissions = {
        User: {
          email: () => { throw new ForbiddenError('Custom error'); },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await expect(
        middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'email')),
      ).rejects.toThrow('Custom error');
    });

    test('should support async rules', async () => {
      const permissions = {
        User: {
          email: async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return true;
          },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      const result = await middleware(
        mockResolve('success'),
        {},
        {},
        {},
        createMockInfo('User', 'email'),
      );
      expect(result).toBe('success');
    });

    test('should execute all rules (AND logic)', async () => {
      let rule1Called = false;
      let rule2Called = false;

      const permissions = {
        User: {
          email: [
            () => { rule1Called = true; return true; },
            () => { rule2Called = true; return true; },
          ],
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'email'));

      expect(rule1Called).toBe(true);
      expect(rule2Called).toBe(true);
    });

    test('should short-circuit on first failing rule', async () => {
      let rule2Called = false;

      const permissions = {
        User: {
          email: [
            () => false,
            () => { rule2Called = true; return true; },
          ],
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await expect(
        middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'email')),
      ).rejects.toThrow(ForbiddenError);

      expect(rule2Called).toBe(false);
    });
  });

  describe('policy expression rules', () => {
    test('should allow when expression evaluates to true', async () => {
      const permissions = {
        Post: {
          content: {
            eq: [{ ref: 'parent.published' }, true],
          },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      const result = await middleware(
        mockResolve('success'),
        { published: true },
        {},
        {},
        createMockInfo('Post', 'content'),
      );
      expect(result).toBe('success');
    });

    test('should deny when expression evaluates to false', async () => {
      const permissions = {
        Post: {
          content: {
            eq: [{ ref: 'parent.published' }, true],
          },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await expect(
        middleware(
          mockResolve(),
          { published: false },
          {},
          {},
          createMockInfo('Post', 'content'),
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    test('should work with complex anyOf expression', async () => {
      const permissions = {
        Post: {
          content: {
            anyOf: [
              { eq: [{ ref: 'parent.published' }, true] },
              { eq: [{ ref: 'parent.authorId' }, { ref: 'ctx.user.id' }] },
            ],
          },
        },
      };

      const middleware = createAuthMiddleware(permissions);

      // Published post should be accessible
      const result1 = await middleware(
        mockResolve('success'),
        { published: true, authorId: 'other' },
        {},
        { user: { id: 'user1' } },
        createMockInfo('Post', 'content'),
      );
      expect(result1).toBe('success');

      // Own post should be accessible even if not published
      const result2 = await middleware(
        mockResolve('success'),
        { published: false, authorId: 'user1' },
        {},
        { user: { id: 'user1' } },
        createMockInfo('Post', 'content'),
      );
      expect(result2).toBe('success');

      // Other's unpublished post should be denied
      await expect(
        middleware(
          mockResolve(),
          { published: false, authorId: 'other' },
          {},
          { user: { id: 'user1' } },
          createMockInfo('Post', 'content'),
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    test('invalid expressions should fail closed', async () => {
      const permissions = {
        Post: {
          content: {
            invalidOperator: [1, 1],
          },
        },
      };

      const middleware = createAuthMiddleware(permissions);
      await expect(
        middleware(mockResolve(), {}, {}, {}, createMockInfo('Post', 'content')),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('mixed function and expression rules', () => {
    test('should support mixing function and expression rules', async () => {
      const permissions = {
        Post: {
          content: [
            requireAuth(),
            {
              anyOf: [
                { eq: [{ ref: 'parent.published' }, true] },
                { eq: [{ ref: 'parent.authorId' }, { ref: 'ctx.user.id' }] },
              ],
            },
          ],
        },
      };

      const middleware = createAuthMiddleware(permissions);

      // Should deny unauthenticated users
      await expect(
        middleware(
          mockResolve(),
          { published: true },
          {},
          {},
          createMockInfo('Post', 'content'),
        ),
      ).rejects.toThrow(UnauthenticatedError);

      // Should allow authenticated users with published post
      const result = await middleware(
        mockResolve('success'),
        { published: true, authorId: 'other' },
        {},
        { user: { id: 'user1' } },
        createMockInfo('Post', 'content'),
      );
      expect(result).toBe('success');
    });
  });
});

describe('Integration: Example Permission Schema', () => {
  // This is the example permission schema from the requirements
  const permissions = {
    Query: {
      users: requireAuth(),
      adminDashboard: requireRole('ADMIN'),
    },
    Mutation: {
      publishPost: requireRole('EDITOR'),
    },
    User: {
      '*': requireAuth(),
      email: requireRole('ADMIN'),
    },
    Post: {
      '*': requireAuth(),
      content: async (post, _args, ctx) => {
        if (post.published) return true;
        if (post.authorId === ctx.user?.id) return true;
        return false;
      },
    },
  };

  let middleware;

  beforeEach(() => {
    middleware = createAuthMiddleware(permissions, { defaultPolicy: 'DENY' });
  });

  test('Query.users should require authentication', async () => {
    // Unauthenticated
    await expect(
      middleware(mockResolve(), {}, {}, {}, createMockInfo('Query', 'users')),
    ).rejects.toThrow(UnauthenticatedError);

    // Authenticated
    const result = await middleware(
      mockResolve('users'),
      {},
      {},
      { user: { id: '1' } },
      createMockInfo('Query', 'users'),
    );
    expect(result).toBe('users');
  });

  test('Query.adminDashboard should require ADMIN role', async () => {
    // Regular user
    await expect(
      middleware(
        mockResolve(),
        {},
        {},
        { user: { id: '1', role: 'USER' } },
        createMockInfo('Query', 'adminDashboard'),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Admin user
    const result = await middleware(
      mockResolve('dashboard'),
      {},
      {},
      { user: { id: '1', role: 'ADMIN' } },
      createMockInfo('Query', 'adminDashboard'),
    );
    expect(result).toBe('dashboard');
  });

  test('Mutation.publishPost should require EDITOR role', async () => {
    // Regular user
    await expect(
      middleware(
        mockResolve(),
        {},
        {},
        { user: { id: '1', role: 'USER' } },
        createMockInfo('Mutation', 'publishPost'),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Editor user
    const result = await middleware(
      mockResolve('published'),
      {},
      {},
      { user: { id: '1', role: 'EDITOR' } },
      createMockInfo('Mutation', 'publishPost'),
    );
    expect(result).toBe('published');
  });

  test('User.* wildcard should require authentication', async () => {
    // Unauthenticated accessing name field
    await expect(
      middleware(mockResolve(), {}, {}, {}, createMockInfo('User', 'name')),
    ).rejects.toThrow(UnauthenticatedError);

    // Authenticated accessing name field
    const result = await middleware(
      mockResolve('John'),
      {},
      {},
      { user: { id: '1' } },
      createMockInfo('User', 'name'),
    );
    expect(result).toBe('John');
  });

  test('User.email should require ADMIN role (overrides wildcard)', async () => {
    // Authenticated but not admin
    await expect(
      middleware(
        mockResolve(),
        {},
        {},
        { user: { id: '1', role: 'USER' } },
        createMockInfo('User', 'email'),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Admin user
    const result = await middleware(
      mockResolve('admin@example.com'),
      {},
      {},
      { user: { id: '1', role: 'ADMIN' } },
      createMockInfo('User', 'email'),
    );
    expect(result).toBe('admin@example.com');
  });

  test('Post.content should allow if published', async () => {
    const result = await middleware(
      mockResolve('content'),
      { published: true, authorId: 'other' },
      {},
      { user: { id: '1' } },
      createMockInfo('Post', 'content'),
    );
    expect(result).toBe('content');
  });

  test('Post.content should allow if author', async () => {
    const result = await middleware(
      mockResolve('draft content'),
      { published: false, authorId: '1' },
      {},
      { user: { id: '1' } },
      createMockInfo('Post', 'content'),
    );
    expect(result).toBe('draft content');
  });

  test('Post.content should deny if not published and not author', async () => {
    await expect(
      middleware(
        mockResolve(),
        { published: false, authorId: 'other' },
        {},
        { user: { id: '1' } },
        createMockInfo('Post', 'content'),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  test('Unknown type.field should use default policy (DENY)', async () => {
    await expect(
      middleware(
        mockResolve(),
        {},
        {},
        { user: { id: '1' } },
        createMockInfo('Unknown', 'field'),
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});


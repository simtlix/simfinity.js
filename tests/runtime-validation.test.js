import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';

import { createRuntime } from '../packages/core/src/index.js';

const rows = {
  ValidationOrg: [
    { _id: 'o1', id: 'o1', name: 'A org', tenantId: 'A' },
    { _id: 'o2', id: 'o2', name: 'B org', tenantId: 'B' },
  ],
  ValidationMember: [
    { _id: 'm1', id: 'm1', name: 'A member', tenantId: 'A', org: 'o1' },
    { _id: 'm2', id: 'm2', name: 'B member', tenantId: 'B', org: 'o2' },
  ],
};

const tenantOf = (args) => (args.AND || [])
  .flatMap((group) => group.conditions || [])
  .filter((condition) => condition.field === 'tenantId')
  .map((condition) => condition.value);
const applyTenant = (records, args) => records.filter((record) => tenantOf(args)
  .every((tenant) => record.tenantId === tenant));

const createAdapter = () => {
  const calls = [];
  return {
    calls,
    bind() {},
    prepare: vi.fn(),
    validateRegistration: vi.fn(),
    createModel: vi.fn((gqltype) => ({ name: gqltype.name })),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) {
      calls.push(`getById:${Model.name}`);
      return rows[Model.name].find((record) => record._id === String(id)) || null;
    },
    async getByIds(Model, ids) {
      calls.push(`getByIds:${Model.name}`);
      return rows[Model.name].filter((record) => ids.includes(record._id));
    },
    async find(Model, gqltype, args) {
      calls.push(`find:${Model.name}`);
      const found = applyTenant(rows[Model.name], args);
      return args.id?.operator === 'EQ' ? found.filter((record) => record._id === args.id.value) : found;
    },
    async count(Model, gqltype, args) {
      calls.push(`count:${Model.name}`);
      return applyTenant(rows[Model.name], args).length;
    },
    async aggregate(Model, gqltype, args) {
      calls.push(`aggregate:${Model.name}`);
      return [{ groupId: 'all', facts: { count: applyTenant(rows[Model.name], args).length } }];
    },
    async findChildren(Model, gqltype, connectionField, parentId, args) {
      calls.push(`findChildren:${Model.name}`);
      return applyTenant(rows[Model.name].filter((record) => record[connectionField] === parentId), args);
    },
  };
};

const tenantScope = ({ args, context }) => {
  args.AND = [...(args.AND || []), { conditions: [{ field: 'tenantId', operator: 'EQ', value: context.tenant }] }];
};
const validScope = () => ({ find: tenantScope, get_by_id: tenantScope, aggregate: tenantScope });

const createTypes = ({ orgScope, memberScope } = {}) => {
  const OrgType = new GraphQLObjectType({
    name: 'ValidationOrg',
    extensions: orgScope === undefined ? {} : { scope: orgScope },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tenantId: { type: GraphQLString, extensions: { readOnly: true } },
      members: {
        type: new GraphQLList(MemberType),
        extensions: { relation: { embedded: false, connectionField: 'org' } },
      },
    }),
  });
  const MemberType = new GraphQLObjectType({
    name: 'ValidationMember',
    extensions: memberScope === undefined ? {} : { scope: memberScope },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tenantId: { type: GraphQLString, extensions: { readOnly: true } },
      org: { type: OrgType, extensions: { relation: { embedded: false, connectionField: 'org' } } },
    }),
  });
  return { OrgType, MemberType };
};

const build = (scopes) => {
  const adapter = createAdapter();
  const runtime = createRuntime(adapter);
  const { OrgType, MemberType } = createTypes(scopes);
  runtime.connect(null, OrgType, 'org', 'orgs');
  runtime.connect(null, MemberType, 'member', 'members');
  return {
    adapter, runtime, schema: runtime.createSchema(), OrgType, MemberType,
  };
};

const run = (schema, source) => graphql({ schema, source, contextValue: { tenant: 'A' } });

const errorWith = (code) => expect.objectContaining({
  extensions: expect.objectContaining({ code, status: 500 }),
});

class ScopeClass {
  find() {}
}

describe('query scope validation', () => {
  test.each([
    ['a string value', { find: 'tenantScope' }],
    ['an array value', { find: [tenantScope] }],
    ['an undefined value', { find: undefined }],
    ['a null value', { get_by_id: null }],
    ['an object value', { find: tenantScope, get_by_id: { fn: tenantScope } }],
    ['a camelCase getById key', { getById: tenantScope }],
    ['an unknown findAll key', { findAll: tenantScope }],
    ['a write operation key', { delete: tenantScope }],
    ['a bare function', tenantScope],
    ['null', null],
    ['an array', [tenantScope]],
    ['a class instance', new ScopeClass()],
    ['an object with inherited functions', Object.create({ find: tenantScope })],
    ['a non-enumerable getById key', Object.create(null, {
      find: { value: tenantScope },
      getById: { value: tenantScope },
    })],
    ['a non-enumerable undefined value', Object.create(null, { find: { value: undefined } })],
    ['a non-enumerable string value', Object.defineProperty({}, 'find', { value: 'tenantScope' })],
  ])('rejects %s at registration without keeping it', (label, scope) => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const { OrgType } = createTypes({ orgScope: scope });

    expect(() => runtime.connect(null, OrgType, 'org', 'orgs')).toThrow(errorWith('INVALID_SCOPE'));
    expect(() => runtime.addNoEndpointType(OrgType)).toThrow(errorWith('INVALID_SCOPE'));
    expect(runtime.getRegistrations()).toEqual([]);
    expect(adapter.validateRegistration).not.toHaveBeenCalled();
  });

  test('rejects a scope made invalid before createSchema without preparing models', () => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const scope = validScope();
    const { OrgType } = createTypes({ orgScope: scope });
    runtime.connect(null, OrgType, 'org', 'orgs');
    scope.findAll = tenantScope;

    expect(() => runtime.createSchema()).toThrow(errorWith('INVALID_SCOPE'));
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
  });

  test('accepts a subset of operations and null-prototype scope objects', async () => {
    const { schema, adapter } = build({
      orgScope: { find: tenantScope },
      memberScope: Object.assign(Object.create(null), { get_by_id: tenantScope }),
    });

    const orgs = await run(schema, '{ orgs { id } }');
    const member = await run(schema, '{ member(id: "m2") { id } }');

    expect(orgs.errors).toBeUndefined();
    expect(orgs.data.orgs).toEqual([{ id: 'o1' }]);
    expect(member.errors).toBeUndefined();
    expect(member.data.member).toBeNull();
    expect(adapter.calls).toEqual(['find:ValidationOrg', 'find:ValidationMember']);
  });

  test('applies scope functions defined as non-enumerable properties', async () => {
    const { schema } = build({ orgScope: Object.create(null, { find: { value: tenantScope } }) });

    const orgs = await run(schema, '{ orgs { id } }');

    expect(orgs.errors).toBeUndefined();
    expect(orgs.data.orgs).toEqual([{ id: 'o1' }]);
  });

  describe('scopes changed after createSchema', () => {
    test.each([
      ['lists', '{ orgs { id } }'],
      ['counted lists', '{ orgs(pagination: { page: 1, size: 10, count: true }) { id } }'],
      ['aggregations', `{ orgs_aggregate(aggregation: {
        groupId: "tenantId", facts: [{ operation: COUNT, factName: "count", path: "id" }]
      }) { groupId facts } }`],
      ['reads by ID', '{ org(id: "o2") { id } }'],
    ])('fail %s of the scoped type without reading', async (label, source) => {
      const scope = validScope();
      const { schema, adapter } = build({ orgScope: scope });
      scope.find = 'disabled';

      const result = await run(schema, source);

      expect(result.errors?.[0].extensions).toMatchObject({ code: 'INVALID_SCOPE', status: 500 });
      expect(adapter.calls).toEqual([]);
    });

    test('fail generated collection relations into the scoped type', async () => {
      const scope = validScope();
      const { schema, adapter } = build({ memberScope: scope });
      scope.find = 'disabled';

      const result = await run(schema, '{ orgs { id members { id } } }');

      expect(result.errors?.[0].extensions.code).toBe('INVALID_SCOPE');
      expect(adapter.calls).toEqual(['find:ValidationOrg']);
    });

    test('fail generated single references to the scoped type', async () => {
      const scope = validScope();
      const { schema, adapter } = build({ orgScope: scope });
      scope.get_by_id = null;

      const result = await run(schema, '{ members { id org { id } } }');

      expect(result.errors?.[0].extensions.code).toBe('INVALID_SCOPE');
      expect(adapter.calls).toEqual(['find:ValidationMember']);
    });

    test('fail client paths that join the scoped type', async () => {
      const scope = validScope();
      const { schema, adapter } = build({ orgScope: scope });
      scope.find = [tenantScope];

      const result = await run(schema, `{
        members(org: { terms: [{ path: "name", operator: EQ, value: "B org" }] }) { id }
      }`);

      expect(result.errors?.[0].extensions.code).toBe('INVALID_SCOPE');
      expect(adapter.calls).toEqual([]);
    });
  });
});

describe('middleware validation', () => {
  const createDocsRuntime = () => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    runtime.connect(null, new GraphQLObjectType({
      name: 'ValidationOrg',
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
    }), 'org', 'orgs');
    return { adapter, runtime };
  };
  const denied = async () => {
    throw new Error('denied');
  };
  let unhandled;
  const onUnhandled = (reason) => unhandled.push(reason);

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['an object', { handle: denied }],
    ['a string', 'denied'],
  ])('rejects %s and keeps later middleware', async (label, middleware) => {
    const { adapter, runtime } = createDocsRuntime();
    const guard = vi.fn(denied);

    expect(() => runtime.use(middleware)).toThrow(errorWith('INVALID_MIDDLEWARE'));
    runtime.use(guard);
    const result = await run(runtime.createSchema(), '{ orgs { id } }');

    expect(guard).toHaveBeenCalledOnce();
    expect(result.errors?.[0].message).toBe('denied');
    expect(adapter.calls).toEqual([]);
  });

  test('waits for the rest of the chain when a middleware does not await next()', async () => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    const { adapter, runtime } = createDocsRuntime();
    runtime.use((params, next) => {
      next();
    });
    runtime.use(denied);

    const result = await run(runtime.createSchema(), '{ orgs { id } }');
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    expect(result.errors?.[0].message).toBe('denied');
    expect(result.data.orgs).toBeNull();
    expect(adapter.calls).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test.each([
    ['a microtask', () => Promise.resolve()],
    ['setImmediate', () => new Promise((resolve) => { setImmediate(resolve); })],
    ['a timer', () => new Promise((resolve) => { setTimeout(resolve, 5); })],
  ])('handles a later rejection while a middleware that did not await next() waits on %s', async (label, wait) => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    const { adapter, runtime } = createDocsRuntime();
    runtime.use(async (params, next) => {
      next();
      await wait();
    });
    runtime.use(denied);

    const result = await run(runtime.createSchema(), '{ orgs { id } }');
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    expect(result.errors?.[0].message).toBe('denied');
    expect(adapter.calls).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test.each([
    ['throws', (params, next) => {
      next();
      throw new Error('rejected after next');
    }],
    ['rejects', async (params, next) => {
      next();
      await Promise.resolve();
      throw new Error('rejected after next');
    }],
  ])('lets the rest of the chain finish when a middleware that did not await next() %s', async (label, middleware) => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    const { adapter, runtime } = createDocsRuntime();
    const order = [];
    runtime.use(middleware);
    runtime.use(async (params, next) => {
      order.push('slow start');
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      await next();
      order.push('slow end');
    });
    runtime.use(async () => {
      order.push('last');
      throw new Error('later failure');
    });

    const result = await run(runtime.createSchema(), '{ orgs { id } }');
    order.push('response');
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(result.errors?.[0].message).toBe('rejected after next');
    expect(order).toEqual(['slow start', 'last', 'response']);
    expect(adapter.calls).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test('lets a started chain finish before rejecting even when it succeeds', async () => {
    const { adapter, runtime } = createDocsRuntime();
    const order = [];
    runtime.use((params, next) => {
      next();
      throw new Error('rejected after next');
    });
    runtime.use(async (params, next) => {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      await next();
      order.push('slow end');
    });

    const result = await run(runtime.createSchema(), '{ orgs { id } }');
    order.push('response');

    expect(result.errors?.[0].message).toBe('rejected after next');
    expect(order).toEqual(['slow end', 'response']);
    expect(adapter.calls).toEqual([]);
  });

  test('ignores next() called after the middleware has finished', async () => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    const { adapter, runtime } = createDocsRuntime();
    const later = vi.fn(denied);
    let lateNext;
    runtime.use((params, next) => {
      lateNext = next;
    });
    runtime.use(later);

    const result = await run(runtime.createSchema(), '{ orgs { id } }');
    const lateResult = lateNext();
    await expect(lateResult).resolves.toBeUndefined();

    expect(result.errors).toBeUndefined();
    expect(adapter.calls).toEqual(['find:ValidationOrg']);
    expect(later).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  test('does not run later middleware for a callback-style next()', async () => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    const { adapter, runtime } = createDocsRuntime();
    const later = vi.fn(denied);
    runtime.use((params, next) => {
      setTimeout(() => next(), 1);
    });
    runtime.use(later);

    const result = await run(runtime.createSchema(), '{ orgs { id } }');
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(result.errors).toBeUndefined();
    expect(adapter.calls).toEqual(['find:ValidationOrg']);
    expect(later).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  test.each([
    ['awaits next()', async (params, next) => { await next(); }],
    ['returns next()', (params, next) => next()],
    ['logs and rethrows around next()', async (params, next) => {
      try {
        await next();
      } catch (error) {
        params.context.logged.push(error.message);
        throw error;
      }
    }],
  ])('runs every middleware before the operation when a middleware %s', async (label, middleware) => {
    const { adapter, runtime } = createDocsRuntime();
    const order = [];
    runtime.use(async (params, next) => {
      order.push('first');
      await next();
      order.push('first done');
    });
    runtime.use(middleware);
    runtime.use(async (params, next) => {
      order.push('last');
      await next();
    });
    const schema = runtime.createSchema();

    const allowed = await run(schema, '{ orgs { id } }');
    runtime.use(denied);
    const rejected = await graphql({ schema, source: '{ orgs { id } }', contextValue: { logged: [] } });

    expect(allowed.errors).toBeUndefined();
    expect(order.slice(0, 3)).toEqual(['first', 'last', 'first done']);
    expect(rejected.errors?.[0].message).toBe('denied');
    expect(adapter.calls).toEqual(['find:ValidationOrg']);
  });

  test('runs the rest of the chain once when next() is called twice', async () => {
    const { runtime } = createDocsRuntime();
    const later = vi.fn((params, next) => next());
    runtime.use(async (params, next) => {
      await next();
      await next();
    });
    runtime.use(later);

    const result = await run(runtime.createSchema(), '{ orgs { id } }');

    expect(result.errors).toBeUndefined();
    expect(later).toHaveBeenCalledOnce();
  });

  test('skips the remaining middleware when next() is not called', async () => {
    const { runtime } = createDocsRuntime();
    const later = vi.fn(denied);
    runtime.use(() => {});
    runtime.use(later);

    const result = await run(runtime.createSchema(), '{ orgs { id } }');

    expect(result.errors).toBeUndefined();
    expect(result.data.orgs).toHaveLength(2);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('unregistered relation targets', () => {
  const buildWithReference = (shape, extra = {}) => {
    const runtime = createRuntime(createAdapter());
    const Hidden = new GraphQLObjectType({
      name: `UnregisteredHidden${shape}`,
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
    });
    const Owner = new GraphQLObjectType({
      name: `UnregisteredOwner${shape}`,
      fields: {
        id: { type: GraphQLID },
        ref: {
          type: shape.endsWith('List') ? new GraphQLList(Hidden) : Hidden,
          extensions: {
            ...extra.extensions,
            relation: { embedded: shape.startsWith('Embedded'), connectionField: 'ref' },
          },
          resolve: extra.resolve,
        },
      },
    });
    runtime.connect(null, Owner, `owner${shape}`, `owners${shape}`);
    return () => runtime.createSchema();
  };

  test.each(['ReferenceList', 'EmbeddedSingle', 'EmbeddedList'])('reports an unregistered %s target', (shape) => {
    const createSchema = buildWithReference(shape);

    expect(createSchema).toThrow(errorWith('UNREGISTERED_RELATION_TARGET'));
    expect(createSchema).toThrow(
      `Field UnregisteredOwner${shape}.ref references UnregisteredHidden${shape}, which is not registered`,
    );
  });

  test('keeps building unregistered single references and resolved read-only lists', () => {
    expect(buildWithReference('ReferenceSingle')).not.toThrow();
    expect(buildWithReference('ReferenceList', {
      extensions: { readOnly: true },
      resolve: () => [],
    })).not.toThrow();
  });
});

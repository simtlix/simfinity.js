import { afterEach, describe, expect, it } from 'vitest';
import { graphql } from 'graphql';
import { configureQueryLimits, createRuntime, createQueryPlan, describeModels, QLOperator } from '../packages/core/src/index.js';
import * as auth from '../packages/core/src/auth/index.js';
import { createQueryPathFixture } from './fixtures/query-path-authorization.js';

let ordinal = 0;
const features = { operators: QLOperator.getValues().map(({ value }) => value), referenceEmptiness: true, quantifiers: true, valuePath: true };
const build = ({ middleware, capability = true, permissions, view, scope } = {}) => {
  const calls = [];
  const adapter = {
    queryFeatures: { ...features, valuePath: capability },
    bind() {}, prepare() {}, castId: String,
    createModel: (gqltype) => ({ name: gqltype.name }),
    getById: async (_, id) => ({ _id: id, id }),
    withTransaction: async (session, body) => body(session || {}),
    find: async (Model, type, args) => {
      const plan = createQueryPlan(models, type.name, args);
      calls.push({ args: structuredClone(args), plan });
      return args.id?.value ? [{ _id: args.id.value, id: args.id.value }] : [];
    },
  };
  adapter.count = adapter.find;
  adapter.aggregate = adapter.find;
  adapter.findChildren = (Model, type, connectionField, parentId, args) => adapter.find(Model, type, args);
  const runtime = createRuntime(adapter);
  const fixture = createQueryPathFixture(runtime, `Fcr${++ordinal}`);
  const models = describeModels([fixture.Team, fixture.User, fixture.Post].map((gqltype) => ({ gqltype })));
  if (middleware) runtime.use(middleware);
  if (view) runtime.registerView('comparedPosts', { type: fixture.Post, description: 'Posts with compared fields', where: () => view });
  if (scope) fixture.Post.extensions.scope = { find: scope };
  const schema = runtime.createSchema();
  if (permissions) auth.createAuthPlugin(permissions(fixture), { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema });
  const run = (args, entity = fixture.names.posts) => graphql({ schema, source: `{ ${entity}${args ? `(${args})` : ''} { id } }`, contextValue: { user: { tenant: 'A' } } });
  return { runtime, schema, calls, run, ...fixture };
};
const code = (result, value) => expect(result.errors?.[0]?.extensions?.code).toBe(value);

afterEach(() => configureQueryLimits());

describe('runtime field comparisons', () => {
  it.each(['QLFilter', 'QLTypeFilter', 'QLFilterCondition'])('exposes nullable valuePath on %s', (name) => {
    expect(String(build().schema.getType(name).getFields().valuePath?.type)).toBe('String');
  });
  it('marks RHS-only references on top-level scalar filters and avoids restrictive joined scopes', async () => {
    const { run, calls } = build();
    const result = await run('title: {valuePath: "author.name"}');
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.title.__scope.scopes).toEqual({ author: { tenant: { operator: 'EQ', value: 'A' } } });
    expect(calls[0].args.AND).toBeUndefined();
    expect(calls[0].plan.where).toMatchObject({ path: ['title'], operand: { up: 0, path: ['author', 'name'] }, joins: { author: { path: ['tenant'], value: 'A' } } });
  });
  it('authorizes an unselected right operand before middleware', async () => {
    let ran = false;
    const { run, calls } = build({ middleware: async (_, next) => { ran = true; await next(); } });
    code(await run('title: {valuePath: "author.passwordHash"}'), 'FORBIDDEN_FILTER_PATH');
    expect(ran).toBe(false);
    expect(calls).toEqual([]);
  });
  it('checks auth field rules on an unselected right operand', async () => {
    const { run, calls } = build({ permissions: ({ User }) => ({ [User.name]: { name: auth.deny() } }) });
    code(await run('title: {valuePath: "author.name"}'), 'FORBIDDEN');
    expect(calls).toEqual([]);
  });
  it('keeps relation-term RHS origins inside the relation', async () => {
    const { run, calls } = build();
    expect((await run('author: {terms: [{path: "name", valuePath: "email"}]}')).errors).toBeUndefined();
    expect(calls[0].plan.where).toMatchObject({ path: ['author', 'name'], operand: { up: 0, path: ['author', 'email'] } });
  });
  it('refills a retained comparison marker after only its right path changes', async () => {
    const { run, calls } = build({ middleware: async ({ args }, next) => {
      args.title.valuePath = 'author.team.name';
      await next();
    } });
    expect((await run('title: {valuePath: "author.name"}')).errors).toBeUndefined();
    expect(Object.keys(calls[0].args.title.__scope.scopes)).toEqual(['author', 'author.team']);
  });
  it('retains right-side scopes when middleware narrows the left path', async () => {
    const { run, calls } = build({ middleware: async ({ args }, next) => {
      args.AND[0].conditions[0].field = 'title';
      await next();
    } });
    expect((await run('AND: [{conditions: [{field: "author.email", valuePath: "author.name"}]}]')).errors).toBeUndefined();
    expect(Object.keys(calls[0].args.AND[0].conditions[0].__scope.scopes)).toEqual(['author']);
  });
  it('rejects rebuilt top-level comparison filters that dropped their marker', async () => {
    const { run, calls } = build({ middleware: async ({ args }, next) => {
      args.title = { valuePath: args.title.valuePath };
      await next();
    } });
    code(await run('title: {valuePath: "author.name"}'), 'DETACHED_CLIENT_FILTER');
    expect(calls).toEqual([]);
  });
  it('rejects undeclared capability before middleware and on trusted final input', async () => {
    let ran = false;
    const first = build({ capability: false, middleware: async (_, next) => { ran = true; await next(); } });
    code(await first.run('title: {valuePath: "author.name"}'), 'UNSUPPORTED_QUERY');
    expect(ran).toBe(false);
    const second = build({ capability: false, middleware: async ({ args }, next) => { args.title = { valuePath: 'title' }; await next(); } });
    code(await second.run(''), 'UNSUPPORTED_QUERY');
    expect(second.calls).toEqual([]);
  });
  it('rejects value:null together with a path but preserves literal null path behavior', async () => {
    const { run } = build();
    code(await run('title: {value: null, valuePath: "title"}'), 'INVALID_FILTER_VALUE');
    expect((await run('title: {value: "x", valuePath: null}')).errors).toBeUndefined();
  });
  it('prefixes both operands of a trusted joined scope', async () => {
    const built = build();
    built.User.extensions.scope.find = async ({ args }) => { args.name = { valuePath: 'email' }; };
    expect((await built.run('author: {terms: [{path: "name", value: "A"}]}')).errors).toBeUndefined();
    expect(built.calls[0].args.AND).toEqual([{ conditions: [{ field: 'author.name', operator: undefined, value: undefined, valuePath: 'author.email' }] }]);
  });
});


describe('comparison provenance across read surfaces', () => {
  it('copies named-view predicates and keeps their scope markers separate from client predicates', async () => {
    const view = [{ conditions: [{ field: 'title', valuePath: 'author.name' }] }];
    const snapshot = structuredClone(view);
    const f = build({ view });
    expect((await f.run('title: {valuePath: "author.email"}', 'comparedPosts')).errors).toBeUndefined();
    const args = f.calls[0].args;
    expect(args.title.__scope.id).not.toBe(args.AND[0].conditions[0].__scope.id);
    expect(Object.keys(args.AND[0].conditions[0].__scope.scopes)).toEqual(['author']);
    expect(view).toEqual(snapshot);
  });
  it('checks both operands against a named-view frame budget', async () => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ view: [{ conditions: [{ field: 'title', valuePath: 'author.team.name' }] }] });
    code(await f.run('', 'comparedPosts'), 'FILTER_DEPTH_EXCEEDED');
    expect(f.calls).toEqual([]);
  });
  it('deduplicates the same target paths in the comparison budget', async () => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build();
    expect((await f.run('author: {terms: [{path: "name", valuePath: "email"}]}')).errors).toBeUndefined();
  });
  it('rejects a scoped comparison moved into a trusted wrapper', async () => {
    const f = build({ middleware: async ({ args }, next) => {
      const condition = args.AND[0].conditions[0];
      args.AND = [{ ANY: [{ path: 'author', conditions: [{ ...condition, field: 'name', valuePath: 'email' }] }] }];
      await next();
    } });
    code(await f.run('AND: [{conditions: [{field: "title", valuePath: "author.name"}]}]'), 'DETACHED_CLIENT_FILTER');
  });
  it('does not share markers between GraphQL aliases using the same variable', async () => {
    const f = build();
    const result = await graphql({ schema: f.schema, source: `query($filter: QLFilter) { a: ${f.names.posts}(title: $filter) {id} b: ${f.names.posts}(title: $filter) {id} }`, variableValues: { filter: { valuePath: 'author.name' } }, contextValue: { user: { tenant: 'A' } } });
    expect(result.errors).toBeUndefined();
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map(({ args }) => args.title.__scope.id)).toEqual([0, 0]);
  });
  it('starts collection-field operands at the child type', async () => {
    const f = build();
    const result = await graphql({ schema: f.schema, source: `{ ${f.names.team}(id: "t1") {members(name: {valuePath: "email"}) {id}} }`, contextValue: { user: { tenant: 'A' } } });
    expect(result.errors).toBeUndefined();
    expect(f.calls.at(-1).plan.where.terms.find((term) => term.operand)).toMatchObject({ path: ['name'], operand: { up: 0, path: ['email'] } });
  });
  it('keeps scope-added operands trusted while client operands are scoped', async () => {
    const f = build({ scope: ({ args }) => { args.AND = [{ conditions: [{ field: 'title', valuePath: 'author.email' }] }]; } });
    expect((await f.run('title: {valuePath: "author.name"}')).errors).toBeUndefined();
    expect(f.calls[0].args.title.__scope).toBeDefined();
    expect(f.calls[0].args.AND[0].conditions[0].__scope).toBeUndefined();
    expect(f.calls[0].plan.where.terms[1].joins).toBeUndefined();
  });
});

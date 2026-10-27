import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createTransactions } from '../packages/sql/src/transactions.js';

afterEach(() => { vi.restoreAllMocks(); });

const setup = ({ supported = true, parent = {}, child = {}, build = true, transaction = false } = {}) => {
  const events = [];
  const records = new Map();
  let nextId = 0;
  const driver = {
    acquire: async () => ({}), begin: async () => {},
    commit: vi.fn(async () => { events.push('commit'); }),
    rollback: async () => { events.push('rollback'); }, release: async () => { events.push('release'); },
    isRetryable: (error) => error?.retryable === true, normalizeError: (error) => error,
  };
  const tx = createTransactions(() => ({}), () => {}, { driver, displayName: 'Memory' });
  const adapter = {
    createModel: (type) => ({ name: type.name }),
    assertTransactionModels: () => {},
    castId: (id) => id, readByIdIsInert: () => true,
    stateValue: (state) => state.value,
    withTransaction: (session, body) => session?.external ? body(session) : tx.withTransaction(session, body),
    newRecord: (model, data) => ({ ...data, _id: String(++nextId) }),
    saveRecord: async (model, record) => { records.set(record._id, record); return record; },
    toObject: (record) => ({ ...record }),
    getById: async (model, id) => records.get(id) || null,
    prepareUpdate: (set, unset) => ({ set, unset }),
    update: async (model, id, { set, unset }) => {
      const record = records.get(id);
      if (!record) return null;
      Object.assign(record, set);
      for (const key of Object.keys(unset)) delete record[key];
      return record;
    },
    delete: async (model, id) => { const record = records.get(id); records.delete(id); return record || null; },
  };
  if (supported) adapter.enqueueAfterCommit = tx.enqueueAfterCommit;
  const api = createRuntime(adapter);
  const State = new GraphQLEnumType({ name: 'CommitState', values: { DRAFT: { value: 10 }, LIVE: { value: 20 } } });
  const Child = new GraphQLObjectType({ name: 'CommitChild', fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, parentId: { type: GraphQLID } } });
  const Parent = new GraphQLObjectType({ name: 'CommitParent', fields: {
    id: { type: GraphQLID }, name: { type: GraphQLString }, state: { type: State },
    children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
  } });
  api.connect(null, Child, 'child', 'children', child);
  api.connect(null, Parent, 'parent', 'parents', parent, null, {
    initialState: State.getValue('DRAFT'), actions: { publish: { from: State.getValue('DRAFT'), to: State.getValue('LIVE') } },
  });
  const input = new GraphQLInputObjectType({ name: 'CommitCustom', fields: { name: { type: GraphQLString } } });
  api.registerMutation('custom', '', input, Parent, (args, session, context) => api.saveObject(Parent.name, args, session, context));
  const schema = build ? api.createSchema(undefined, undefined, undefined, transaction
    ? { transaction: { types: [Parent] } } : {}) : undefined;
  const run = (name, input, context) => schema.getMutationType().getFields()[name].resolve(null,
    name === 'deleteparent' ? { id: input } : { input }, context);
  return { api, adapter, driver, records, events, parent, child, run, schema, tx };
};

describe('controller after-commit callbacks', () => {
  it('awaits children before parent, after release, with original context and plain results', async () => {
    const f = setup();
    const context = Object.freeze({ request: 'r' });
    f.child.onSaveCommitted = async (record, args, received) => {
      expect(received).toBe(context);
      expect(record.name).toBe(args.name);
      await Promise.resolve();
      f.events.push(record.name);
    };
    f.parent.onSaveCommitted = function (record, args, received) {
      expect(this).toBe(f.parent);
      expect(received).toBe(context);
      expect(record.state).toBe(10);
      f.events.push(record.name);
    };
    await f.run('addparent', { name: 'parent', children: { added: [{ name: 'one' }, { name: 'two' }] } }, context);
    expect(f.events).toEqual(['commit', 'release', 'one', 'two', 'parent']);
  });

  it('distinguishes updates, transitions and deletes, and ignores a missing delete', async () => {
    const f = setup();
    const record = await f.run('addparent', { name: 'start' });
    const notices = [];
    f.parent.onUpdateCommitted = (...args) => notices.push(['update', ...args]);
    f.parent.onTransitionCommitted = (...args) => notices.push(['transition', ...args]);
    f.parent.onDeleteCommitted = (...args) => notices.push(['delete', ...args]);
    f.parent.onUpdated = vi.fn();
    const context = { user: 'a' };
    await f.run('updateparent', { id: record._id, name: 'updated' }, context);
    await f.run('publish_parent', { id: record._id }, context);
    await f.run('deleteparent', record._id, context);
    await f.run('deleteparent', record._id, context);
    expect(notices.map(([operation]) => operation)).toEqual(['update', 'transition', 'delete']);
    expect(notices[0][1].name).toBe('updated');
    expect(notices[1][1].state).toBe(20);
    expect(notices[1][2]).toBe('publish');
    expect(notices[1][3]).toBe(context);
    expect(notices[2][2]).toBe(context);
    expect(f.parent.onUpdated).toHaveBeenCalledTimes(2);
  });

  it('preserves nested added/updated/deleted completion order', async () => {
    const f = setup();
    const record = await f.run('addparent', { children: { added: [{ name: 'keep' }, { name: 'remove' }] } });
    f.child.onSaveCommitted = () => f.events.push('child-add');
    f.child.onUpdateCommitted = () => f.events.push('child-update');
    f.child.onDeleteCommitted = () => f.events.push('child-delete');
    f.parent.onUpdateCommitted = () => f.events.push('parent-update');
    f.events.length = 0;
    await f.run('updateparent', { id: record._id, children: { added: [{ name: 'new' }], updated: [{ id: '2', name: 'kept' }], deleted: ['3'] } });
    expect(f.events).toEqual(['commit', 'release', 'child-add', 'child-update', 'child-delete', 'parent-update']);
  });

  it('keeps child notifications when a transition replaces the parent update notification', async () => {
    const f = setup();
    const record = await f.run('addparent', { children: { added: [{ name: 'keep' }, { name: 'remove' }] } });
    f.child.onSaveCommitted = () => f.events.push('child-add');
    f.child.onUpdateCommitted = () => f.events.push('child-update');
    f.child.onDeleteCommitted = () => f.events.push('child-delete');
    f.parent.onUpdateCommitted = () => f.events.push('parent-update');
    f.parent.onTransitionCommitted = (result, action) => {
      expect(result.state).toBe(20);
      expect(action).toBe('publish');
      f.events.push('transition');
    };
    f.events.length = 0;
    await f.run('publish_parent', { id: record._id, children: { added: [{ name: 'new' }], updated: [{ id: '2', name: 'kept' }], deleted: ['3'] } });
    expect(f.events).toEqual(['commit', 'release', 'child-add', 'child-update', 'child-delete', 'transition']);
  });

  it('discards child notifications if the parent lifecycle hook fails', async () => {
    const f = setup();
    f.child.onSaveCommitted = () => f.events.push('child-effect');
    f.parent.onSaved = () => { throw new Error('legacy'); };
    await expect(f.run('addparent', { children: { added: [{ name: 'child' }] } })).rejects.toThrow('legacy');
    expect(f.events).toEqual(['rollback', 'release']);
  });

  it('joins registered mutations and isolates notification payloads from later result mutations', async () => {
    const f = setup();
    const received = [];
    class Scalar { value = 'opaque'; }
    const opaque = new Scalar();
    f.parent.onSaved = (record, args) => {
      record.payload = { date: new Date('2020-01-01'), nested: ['captured'], opaque };
      record.payload.sparse = ['first'];
      record.payload.sparse.length = 3;
      record.payload.self = record.payload;
      args.extra = { value: 'captured' };
    };
    f.parent.onSaveCommitted = (record, args, context) => received.push({ record, args, context });
    await f.tx.withTransaction(null, async (session) => {
      const args = { name: 'first' };
      const record = await f.api.saveObject('CommitParent', args, session);
      record.payload.nested.push('later');
      record.payload.date.setUTCFullYear(2025);
      record.name = 'later';
      expect(received).toHaveLength(0);
    });
    expect(received[0].record.name).toBe('first');
    expect(received[0].record.payload.nested).toEqual(['captured']);
    expect(received[0].record.payload.sparse).toHaveLength(3);
    expect(1 in received[0].record.payload.sparse).toBe(false);
    expect(2 in received[0].record.payload.sparse).toBe(false);
    expect(received[0].record.payload.date.getUTCFullYear()).toBe(2020);
    expect(received[0].record.payload.self).toBe(received[0].record.payload);
    expect(received[0].record.payload.opaque).toBe(opaque);
    expect(received[0].context).toBeUndefined();
    await f.run('custom', { name: 'registered' }, { request: 2 });
    expect(received[1].record.name).toBe('registered');
    expect(received[1].context).toEqual({ request: 2 });
  });

  it('reports callback failures without failing GraphQL or skipping later callbacks', async () => {
    const f = setup();
    const failure = Object.assign(new Error('secret'), { retryable: true });
    const reports = [];
    const notices = [];
    const context = Object.freeze({ request: 'r' });
    f.api.configureAfterCommit({ onError: (error, details) => { reports.push({ error, details }); throw null; } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('logger'); });
    f.child.onSaveCommitted = () => { throw failure; };
    f.parent.onSaveCommitted = () => notices.push('parent');
    const result = await graphql({ schema: f.schema, contextValue: context,
      source: 'mutation { addparent(input:{name:"ok",children:{added:[{name:"child"}]}}) { name } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data.addparent.name).toBe('ok');
    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(failure);
    expect(reports[0].details).toMatchObject({ committed: true, typeName: 'CommitChild', operation: 'save', callbackName: 'onSaveCommitted' });
    expect(reports[0].details.context).toBe(context);
    expect(notices).toEqual(['parent']);
    expect(f.driver.commit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });

  it('skips external owners, warning once per type without mutating context', async () => {
    const f = setup();
    const callback = vi.fn();
    f.parent.onSaveCommitted = callback;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = { external: true };
    await f.api.saveObject('CommitParent', { name: 'one' }, session, Object.freeze({}));
    await f.api.saveObject('CommitParent', { name: 'two' }, session);
    expect(callback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([]);
  });

  it('rejects unsupported adapters at setup and at operation entry after controller changes', async () => {
    const controller = {};
    const f = setup({ supported: false, parent: controller });
    controller.onSaveCommitted = () => {};
    await expect(f.run('addparent', { name: 'no' })).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_AFTER_COMMIT' } });
    expect(f.records.size).toBe(0);
    const g = setup({ supported: false, parent: controller, build: false });
    let failure;
    try { g.api.createSchema(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ extensions: { code: 'UNSUPPORTED_AFTER_COMMIT' } });
  });

  it('rejects non-function callbacks during schema creation and before writing with a changed controller', async () => {
    const f = setup({ parent: { onUpdateCommitted: 'notify' }, build: false });
    let failure;
    try { f.api.createSchema(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ extensions: { code: 'INVALID_CONTROLLER', status: 400 } });
    expect(f.records.size).toBe(0);
    const g = setup();
    g.parent.onSaveCommitted = 42;
    await expect(g.run('addparent', { name: 'rejected' })).rejects.toMatchObject({ extensions: { code: 'INVALID_CONTROLLER', status: 400 } });
    expect(g.records.size).toBe(0);
    expect(g.driver.commit).not.toHaveBeenCalled();
  });

  it('validates configuration without changing the previous handler and isolates runtimes', async () => {
    const f = setup(); const g = setup();
    const errors = [];
    f.api.configureAfterCommit({ onError: (error) => errors.push(error) });
    for (const options of [{ onError: 1 }, { handler: () => {} }, null, [], new Date(),
      Object.create({ onError: () => {} }), { [Symbol('typo')]: true },
      Object.defineProperty({}, 'onEror', { value: () => {} })]) {
      expect(() => f.api.configureAfterCommit(options)).toThrow();
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.parent.onSaveCommitted = () => { throw 'first'; };
    g.parent.onSaveCommitted = () => { throw 'second'; };
    await f.run('addparent', {}); await g.run('addparent', {});
    expect(errors).toEqual(['first']);
    expect(log).toHaveBeenCalledTimes(1);
    f.api.configureAfterCommit();
    await f.run('addparent', {});
    expect(errors).toEqual(['first']);
  });
});


describe('after-commit integration with lifecycle helpers and operation lists', () => {
  it('queues every helper once on its owned transaction with its context and action name', async () => {
    const f = setup();
    const notices = [];
    const context = Object.freeze({ request: 'helpers' });
    f.parent.onSaveCommitted = (record, args, ctx) => notices.push(['save', record.name, ctx]);
    f.parent.onUpdateCommitted = (record, ctx) => notices.push(['update', record.name, ctx]);
    f.parent.onTransitionCommitted = (record, action, ctx) => notices.push(['transition', action, ctx]);
    f.parent.onDeleteCommitted = (record, ctx) => notices.push(['delete', record.name, ctx]);
    const record = await f.api.saveObject('CommitParent', { name: 'first' }, undefined, context);
    await f.api.updateObject('CommitParent', { id: record._id, name: 'second' }, undefined, context);
    await f.api.transitionObject('CommitParent', 'publish', { id: record._id }, undefined, context);
    await f.api.deleteObject('CommitParent', { id: record._id }, undefined, context);
    await f.api.deleteObject('CommitParent', { id: record._id }, undefined, context);
    expect(notices).toEqual([
      ['save', 'first', context], ['update', 'second', context],
      ['transition', 'publish', context], ['delete', 'second', context],
    ]);
  });

  it('captures each operation result and drains the list only after the enclosing commit and cleanup', async () => {
    const f = setup({ transaction: true });
    f.parent.onSaveCommitted = (record) => f.events.push(['save', record.name]);
    f.parent.onUpdateCommitted = (record) => f.events.push(['update', record.name]);
    f.parent.onTransitionCommitted = (record, action) => f.events.push(['transition', action]);
    f.parent.onDeleteCommitted = (record) => f.events.push(['delete', record.name]);
    const result = await graphql({ schema: f.schema, source: `mutation { transaction(operations: [
      { addparent: { name: "first" } },
      { updateparent: { id: "$0", name: "second" } },
      { publish_parent: { id: "$0" } },
      { deleteparent: { id: "$0" } },
      { deleteparent: { id: "missing" } }
    ]) { id } }` });
    expect(result.errors).toBeUndefined();
    expect(f.events).toEqual(['commit', 'release', ['save', 'first'], ['update', 'second'],
      ['transition', 'publish'], ['delete', 'second']]);
  });

  it.each([false, true])('discards failed attempt notifications (retry: %s)', async (retry) => {
    const f = setup({ transaction: true });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    f.parent.onSaved = async (record, args, session) => {
      if (record.name !== 'second') return;
      // A helper joins the same attempt and must use its queue, not notify eagerly.
      await f.api.saveObject('CommitParent', { name: 'from-hook' }, session);
      if (++attempts === 1) throw Object.assign(new Error('fail attempt'), { retryable: retry });
    };
    f.parent.onSaveCommitted = (record) => f.events.push(record.name);
    const result = await graphql({ schema: f.schema, source: `mutation { transaction(operations: [
      { addparent: { name: "first" } }, { addparent: { name: "second" } }
    ]) { id } }` });
    if (retry) {
      expect(result.errors).toBeUndefined();
      expect(f.events).toEqual(['rollback', 'release', 'commit', 'release', 'first', 'from-hook', 'second']);
    } else {
      expect(result.errors?.[0].message).toBe('fail attempt');
      expect(f.events).toEqual(['rollback', 'release']);
    }
  });
});

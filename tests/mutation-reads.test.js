import {
  describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';

import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';

// `inert` is the adapter's readByIdIsInert: omitted, the adapter does not report it.
const createMemoryAdapter = ({ inert } = {}) => {
  const records = new Map();
  let nextId = 1;
  const copy = (record) => (record ? structuredClone(record) : null);
  const adapter = {
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || { memory: true }),
    newRecord: (Model, data) => ({ ...data, _id: String(nextId++) }),
    async saveRecord(Model, record) {
      records.set(record._id, copy(record));
      return copy(record);
    },
    toObject: (record) => ({ ...record }),
    getById: vi.fn(async (Model, id) => copy(records.get(String(id)))),
    prepareUpdate: (set, unset) => ({ set, unset }),
    async update(Model, id, update) {
      const current = records.get(String(id));
      if (!current) return null;
      for (const key of Object.keys(update.unset)) delete current[key];
      Object.assign(current, structuredClone(update.set));
      return copy(current);
    },
    async delete(Model, id) {
      const record = copy(records.get(String(id)));
      records.delete(String(id));
      return record;
    },
    find: async () => [],
    count: async () => 0,
    aggregate: async () => [],
    findChildren: async (Model, gqltype, field, parentId) => [...records.values()]
      .filter((record) => String(record[field]) === String(parentId)).map(copy),
    records,
  };
  if (inert !== undefined) adapter.readByIdIsInert = vi.fn(typeof inert === 'function' ? inert : () => inert);
  return adapter;
};

const PARENT_READ = 'ReadsOrder {"projection":{"address":1,"lines":1},"plain":true,"lock":true}';

const buildFixture = (adapterOptions) => {
  const adapter = createMemoryAdapter(adapterOptions);
  const runtime = createRuntime(adapter);
  const State = new GraphQLEnumType({
    name: 'ReadsState',
    values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' }, MOVED: { value: 'MOVED' } },
  });
  const Address = new GraphQLObjectType({
    name: 'ReadsAddress', fields: { street: { type: GraphQLString }, city: { type: GraphQLString } },
  });
  const Line = new GraphQLObjectType({ name: 'ReadsLine', fields: { label: { type: new GraphQLNonNull(GraphQLString) } } });
  const Item = new GraphQLObjectType({
    name: 'ReadsItem',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      address: { type: Address, extensions: { relation: { embedded: true } } },
      order: { type: Order, extensions: { relation: { connectionField: 'order' } } },
    }),
  });
  const Order = new GraphQLObjectType({
    name: 'ReadsOrder',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      state: { type: State },
      address: { type: Address, extensions: { relation: { embedded: true } } },
      lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
      items: { type: new GraphQLList(Item), extensions: { relation: { connectionField: 'order' } } },
    }),
  });
  const orderController = {};
  const itemController = {};
  runtime.addNoEndpointType(Address);
  runtime.addNoEndpointType(Line);
  runtime.connect(null, Item, 'readsitem', 'readsitems', itemController);
  runtime.connect(null, Order, 'readsorder', 'readsorders', orderController, null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: { from: { name: 'OPEN', value: 'OPEN' }, to: { name: 'CLOSED', value: 'CLOSED' } },
      // Moves the stored address within the transaction before the generated update runs.
      move: {
        from: { name: 'OPEN', value: 'OPEN' },
        to: { name: 'MOVED', value: 'MOVED' },
        action: async (args, session) => {
          await adapter.update(runtime.getModel(Order), args.id, adapter.prepareUpdate({
            address: { street: 'moved', city: 'moved' },
          }, {}), session);
        },
      },
    },
  });
  const schema = runtime.createSchema();
  const run = (source) => graphql({ schema, source });
  const seed = async () => {
    const result = await run(`mutation { addreadsorder(input: { name: "o", address: { street: "s", city: "c" },
      lines: [{ label: "l" }], items: { added: [{ name: "a", address: { street: "x" } }, { name: "b" }, { name: "c" }] } }) {
      id items { id } } }`);
    expect(result.errors).toBeUndefined();
    adapter.getById.mockClear();
    return { id: result.data.addreadsorder.id, items: result.data.addreadsorder.items.map(({ id }) => id) };
  };
  const reads = () => adapter.getById.mock.calls
    .map(([model, , , options]) => `${model.name} ${JSON.stringify(options ?? {})}`);
  const stored = (id) => {
    const record = structuredClone(adapter.records.get(id));
    // Updates write the requested `id` too.
    delete record._id;
    delete record.id;
    return record;
  };
  return {
    adapter, run, seed, reads, stored, orderController, itemController,
  };
};

describe('generated mutations skip reads by ID whose result they do not use', () => {
  test('an update of a type with embedded fields that merges no embedded value skips its read when reads are inert', async () => {
    const fixture = buildFixture({ inert: true });
    const { id } = await fixture.seed();
    const expected = [
      ['name: "renamed"', { name: 'renamed', address: { street: 's', city: 'c' }, lines: [{ label: 'l' }] }],
      ['address: null', { name: 'renamed', lines: [{ label: 'l' }] }],
      ['lines: []', { name: 'renamed', lines: [] }],
      // A list of only nulls writes nothing.
      ['items: { added: [null] }', { name: 'renamed', lines: [] }],
    ];
    for (const [input, record] of expected) {
      fixture.adapter.getById.mockClear();
      const result = await fixture.run(`mutation { updatereadsorder(input: { id: "${id}", ${input} }) { name } }`);
      expect(result.errors).toBeUndefined();
      expect(result.data.updatereadsorder).toEqual({ name: 'renamed' });
      expect(fixture.reads()).toEqual([]);
      expect(fixture.stored(id)).toEqual({ ...record, state: 'OPEN' });
    }
    expect(fixture.adapter.readByIdIsInert).toHaveBeenCalledWith({ name: 'ReadsOrder' });
  });

  test('a delete without onDelete skips its read when reads are inert', async () => {
    const fixture = buildFixture({ inert: true });
    const { items } = await fixture.seed();
    const deleted = await fixture.run(`mutation { deletereadsitem(id: "${items[0]}") { name address { street } } }`);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deletereadsitem).toEqual({ name: 'a', address: { street: 'x' } });
    expect(fixture.reads()).toEqual([]);
    expect(fixture.adapter.records.has(items[0])).toBe(false);

    const missing = await fixture.run('mutation { deletereadsitem(id: "999") { name } }');
    expect(missing).toEqual({ data: { deletereadsitem: null } });
    expect(fixture.reads()).toEqual([]);
  });

  test('the inert report is asked for the model that is read', async () => {
    const fixture = buildFixture({ inert: (Model) => Model.name === 'ReadsItem' });
    const { id, items } = await fixture.seed();
    expect((await fixture.run(`mutation { deletereadsitem(id: "${items[0]}") { name } }`)).errors).toBeUndefined();
    expect((await fixture.run(`mutation { updatereadsorder(input: { id: "${id}", name: "x" }) { name } }`)).errors)
      .toBeUndefined();
    expect(fixture.reads()).toEqual([PARENT_READ]);
  });

  test('unless the adapter reports reads as inert with true, a plain update and a delete without onDelete keep their read', async () => {
    for (const inert of [undefined, false, () => 'yes']) {
      const fixture = buildFixture({ inert });
      const { id, items } = await fixture.seed();
      const updated = await fixture.run(`mutation { updatereadsorder(input: { id: "${id}", name: "x" }) { name } }`);
      expect(updated.errors).toBeUndefined();
      const deleted = await fixture.run(`mutation { deletereadsitem(id: "${items[0]}") { name } }`);
      expect(deleted.data.deletereadsitem).toEqual({ name: 'a' });
      expect(fixture.reads()).toEqual([PARENT_READ, 'ReadsItem {"plain":true}']);
    }
  });

  test('an update keeps the locked read when it merges an embedded object, completes an embedded list, runs onUpdating or carries nested items', async () => {
    const fixture = buildFixture({ inert: true });
    const { id, items } = await fixture.seed();
    const inputs = [
      'address: { city: "d" }',
      'lines: [{ label: "m" }]',
      `items: { updated: [{ id: "${items[1]}", name: "n" }] }`,
      `items: { deleted: ["${items[2]}"] }`,
      'items: { added: [{ name: "e" }] }',
    ];
    for (const input of inputs) {
      fixture.adapter.getById.mockClear();
      const result = await fixture.run(`mutation { updatereadsorder(input: { id: "${id}", ${input} }) { name } }`);
      expect(result.errors).toBeUndefined();
      expect(fixture.reads()[0]).toBe(PARENT_READ);
    }
    expect(fixture.stored(id)).toEqual({
      name: 'o', state: 'OPEN', address: { street: 's', city: 'd' }, lines: [{ label: 'm' }],
    });

    // An invalid embedded list item fails for an existing record, after the read.
    const invalid = await fixture.run(`mutation { updatereadsorder(input: { id: "${id}", lines: [{}] }) { name } }`);
    expect(invalid.errors[0].extensions).toMatchObject({ code: 'REQUIRED_VALUE', status: 400 });
    const missing = await fixture.run('mutation { updatereadsorder(input: { id: "999", lines: [{}] }) { name } }');
    expect(missing.errors[0].extensions).toMatchObject({ code: 'NOT_VALID_ID', status: 404 });

    fixture.orderController.onUpdating = vi.fn();
    fixture.adapter.getById.mockClear();
    expect((await fixture.run(`mutation { updatereadsorder(input: { id: "${id}", name: "x" }) { name } }`)).errors)
      .toBeUndefined();
    expect(fixture.reads()).toEqual([PARENT_READ]);
    expect(fixture.orderController.onUpdating).toHaveBeenCalledWith(id, { set: { id, name: 'x' }, unset: {} },
      { memory: true }, undefined);
  });

  test('a state action reads the record once, with or without an inert report', async () => {
    for (const inert of [undefined, true]) {
      const fixture = buildFixture({ inert });
      const { id } = await fixture.seed();
      fixture.orderController.onUpdating = vi.fn();
      const result = await fixture.run(`mutation { close_readsorder(input: { id: "${id}", name: "closed" }) { name state } }`);
      expect(result.errors).toBeUndefined();
      expect(result.data.close_readsorder).toEqual({ name: 'closed', state: 'CLOSED' });
      expect(fixture.reads()).toEqual(['ReadsOrder {"lock":true}']);
      expect(fixture.orderController.onUpdating).toHaveBeenCalledOnce();
      expect(fixture.stored(id)).toMatchObject({ name: 'closed', state: 'CLOSED', address: { street: 's', city: 'c' } });
    }
  });

  test('a state action merges an embedded object into the record as its action left it', async () => {
    const fixture = buildFixture({ inert: true });
    const { id } = await fixture.seed();
    const result = await fixture.run(`mutation { move_readsorder(input: { id: "${id}", address: { city: "d" } }) {
      state address { street city } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.move_readsorder).toEqual({ state: 'MOVED', address: { street: 'moved', city: 'd' } });
    expect(fixture.reads()).toEqual(['ReadsOrder {"lock":true}', PARENT_READ]);
    expect(fixture.stored(id).address).toEqual({ street: 'moved', city: 'd' });
  });

  test('a delete with onDelete reads the record for the hook', async () => {
    const fixture = buildFixture({ inert: true });
    const { id, items } = await fixture.seed();
    fixture.itemController.onDelete = vi.fn();
    const deleted = await fixture.run(`mutation { deletereadsitem(id: "${items[1]}") { name } }`);
    expect(deleted.data.deletereadsitem).toEqual({ name: 'b' });
    expect(fixture.reads()).toEqual(['ReadsItem {"plain":true}']);
    expect(fixture.itemController.onDelete).toHaveBeenCalledWith({ _id: items[1], name: 'b', order: id },
      { memory: true }, undefined);
    const missing = await fixture.run('mutation { deletereadsitem(id: "999") { name } }');
    expect(missing).toEqual({ data: { deletereadsitem: null } });
    expect(fixture.itemController.onDelete).toHaveBeenLastCalledWith(null, { memory: true }, undefined);
  });

  test('nested updated and deleted children are read once each, and onDelete receives that read', async () => {
    const fixture = buildFixture();
    const { id, items } = await fixture.seed();
    fixture.itemController.onDelete = vi.fn();
    fixture.itemController.onUpdating = vi.fn();
    const deleted = await fixture.run(`mutation { updatereadsorder(input: { id: "${id}",
      items: { deleted: ["${items[0]}", "${items[1]}"] } }) { items { name } } }`);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.updatereadsorder.items).toEqual([{ name: 'c' }]);
    expect(fixture.reads()).toEqual([PARENT_READ, 'ReadsItem {"plain":true,"lock":true}', 'ReadsItem {"plain":true,"lock":true}']);
    expect(fixture.itemController.onDelete.mock.calls.map(([record, session]) => [record, session])).toEqual([
      [{ _id: items[0], name: 'a', address: { street: 'x' }, order: id }, { memory: true }],
      [{ _id: items[1], name: 'b', order: id }, { memory: true }],
    ]);

    fixture.adapter.getById.mockClear();
    const updated = await fixture.run(`mutation { updatereadsorder(input: { id: "${id}",
      items: { updated: [{ id: "${items[2]}", name: "z" }] } }) { items { name } } }`);
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updatereadsorder.items).toEqual([{ name: 'z' }]);
    expect(fixture.reads()).toEqual([PARENT_READ, 'ReadsItem {"plain":true,"lock":true}']);
    expect(fixture.itemController.onUpdating.mock.calls.map(([childId]) => childId)).toEqual([items[2]]);

    // A nested update that merges an embedded object still reads its merge base.
    fixture.adapter.getById.mockClear();
    expect((await fixture.run(`mutation { updatereadsorder(input: { id: "${id}",
      items: { updated: [{ id: "${items[2]}", address: { city: "q" } }] } }) { name } }`)).errors).toBeUndefined();
    expect(fixture.reads()).toEqual([
      PARENT_READ,
      'ReadsItem {"plain":true,"lock":true}',
      'ReadsItem {"projection":{"address":1},"plain":true,"lock":true}',
    ]);
  });
});

describe('the MongoDB adapter reports reads by ID as inert', () => {
  const models = [];
  const model = (name, configure = () => {}) => {
    const schema = new mongoose.Schema({ title: String });
    configure(schema);
    const compiled = mongoose.model(name, schema);
    models.push(name);
    return compiled;
  };

  test('only for models without find, findOne, findOneAndUpdate or findOneAndDelete query middleware or overrides of the by-ID statics, in both modes', () => {
    try {
      const plain = model('MutationReadsPlain', (schema) => {
        schema.pre('save', () => {});
        schema.pre('updateOne', () => {});
        schema.pre('deleteOne', { document: false, query: true }, () => {});
      });
      const guarded = [
        model('MutationReadsPreFindOne', (schema) => schema.pre('findOne', () => {})),
        model('MutationReadsPostFindOne', (schema) => schema.post('findOne', () => {})),
        model('MutationReadsPreFind', (schema) => schema.pre('find', () => {})),
        model('MutationReadsPreFindOneAndUpdate', (schema) => schema.pre('findOneAndUpdate', () => {})),
        model('MutationReadsPostFindOneAndUpdate', (schema) => schema.post('findOneAndUpdate', () => {})),
        model('MutationReadsPreFindOneAndDelete', (schema) => schema.pre('findOneAndDelete', () => {})),
        model('MutationReadsRegexWrite', (schema) => schema.pre(/^findOneAnd/, () => {})),
        model('MutationReadsTimestamps', (schema) => schema.set('timestamps', true)),
        model('MutationReadsStaticFindById', (schema) => schema.static('findById', function findById(...args) {
          return mongoose.Model.findById.apply(this, args);
        })),
        model('MutationReadsClassFindOne', (schema) => schema.loadClass(class {
          static findOne(...args) { return mongoose.Model.findOne.apply(this, args); }
        })),
        model('MutationReadsStaticDelete', (schema) => schema.static('findByIdAndDelete', function findByIdAndDelete(...args) {
          return mongoose.Model.findByIdAndDelete.apply(this, args);
        })),
      ];
      const assigned = model('MutationReadsAssignedUpdate');
      assigned.findByIdAndUpdate = (...args) => mongoose.Model.findByIdAndUpdate.apply(assigned, args);
      guarded.push(assigned);
      for (const adapter of [createMongoAdapter(), createMongoAdapter({ referentialIntegrity: 'transactional' })]) {
        expect(adapter.readByIdIsInert(plain)).toBe(true);
        for (const Model of guarded) expect(adapter.readByIdIsInert(Model)).toBe(false);
      }
    } finally {
      for (const name of models) mongoose.deleteModel(name);
    }
  });
});

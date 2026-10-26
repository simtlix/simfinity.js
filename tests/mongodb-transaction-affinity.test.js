// Model affinity of the generated transaction field (#151, section 4.7) on the MongoDB adapter:
// assertTransactionModels(models) is synchronous, never writes, and throws TRANSACTION_UNSUPPORTED when
// the models cannot share one session. No database: connections are never opened, and a connection's
// client is a stub where a test needs one that is already resolved.
import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { createMongoAdapter, createRuntime, SimfinityError } from '../packages/mongodb/src/index.js';

const MODES = ['off', 'transactional'];
const refusal = (first, second) => ({
  code: 'TRANSACTION_UNSUPPORTED', status: 500, message: `Types ${first}, ${second} cannot share one database transaction`,
});

// The code, status and message of the error a call throws, or undefined.
const thrownBy = (call) => {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(SimfinityError);
    return { code: error.extensions.code, status: error.extensions.status, message: error.message };
  }
  return undefined;
};

const schemaFor = () => new mongoose.Schema({ label: String }, { autoCreate: false, autoIndex: false });
// A connection that is never opened: it has no client and no database.
const unopened = () => mongoose.createConnection();
// The same connection with a client that is already resolved.
const withClient = (connection, client) => {
  connection.getClient = () => client;
  return connection;
};

let counter = 0;
const connections = [];
const track = (connection) => {
  connections.push(connection);
  return connection;
};

// A runtime in `mode` whose types, named after `roles`, are stored through `placements`, one connection
// per role. Returns the adapter, and the models and GraphQL types by role.
const setup = (mode, roles, placements) => {
  counter += 1;
  const adapter = createMongoAdapter({ referentialIntegrity: mode });
  const runtime = createRuntime(adapter);
  runtime.preventCreatingCollection(true);
  const models = {};
  const types = {};
  roles.forEach((role, index) => {
    const name = `Affinity${counter}${role}`;
    types[role] = new GraphQLObjectType({ name, fields: { id: { type: GraphQLID }, label: { type: GraphQLString } } });
    // The model's name differs from its type's, so a name taken from the registration cannot be mistaken for it.
    models[role] = placements[index].model(`${name}Doc`, schemaFor(), name);
    runtime.connect(models[role], types[role], name.toLowerCase(), `${name.toLowerCase()}s`);
  });
  return {
    adapter, runtime, models, types, name: (role) => types[role].name, model: (role) => models[role].modelName,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0).reverse()) {
    for (const name of connection.modelNames()) connection.deleteModel(name);
  }
});

describe.each(MODES)('MongoDB model affinity with referentialIntegrity %s', (mode) => {
  test('an empty list, one model and the same model twice pass', () => {
    const { adapter, models } = setup(mode, ['Author'], [track(unopened())]);

    expect(adapter.assertTransactionModels([])).toBeUndefined();
    expect(adapter.assertTransactionModels([models.Author])).toBeUndefined();
    expect(adapter.assertTransactionModels([models.Author, models.Author])).toBeUndefined();
  });

  test('two connections without a client refuse, naming both types in sorted order whatever the order of the list', () => {
    const { adapter, models, name } = setup(mode, ['Author', 'Book'], [track(unopened()), track(unopened())]);

    const expected = refusal(name('Author'), name('Book'));
    expect(thrownBy(() => adapter.assertTransactionModels([models.Book, models.Author]))).toEqual(expected);
    expect(thrownBy(() => adapter.assertTransactionModels([models.Author, models.Book]))).toEqual(expected);
  });

  test('two connections with different clients refuse, and none of them is named', () => {
    const first = { host: 'mongodb.internal.example:27017', id: 'first' };
    const second = { host: 'mongodb.other.example:27017', id: 'second' };
    const { adapter, models, name } = setup(mode, ['Author', 'Book'], [
      track(withClient(unopened(), first)), track(withClient(unopened(), second)),
    ]);

    const failure = thrownBy(() => adapter.assertTransactionModels([models.Author, models.Book]));
    expect(failure).toEqual(refusal(name('Author'), name('Book')));
    expect(failure.message).not.toMatch(/example|first|second/);
  });

  test('two connections that share one client pass', () => {
    const client = { id: 'shared' };
    const { adapter, models } = setup(mode, ['Author', 'Book'], [
      track(withClient(unopened(), client)), track(withClient(unopened(), client)),
    ]);

    expect(adapter.assertTransactionModels([models.Author, models.Book])).toBeUndefined();
  });

  test('useDb siblings created before the connection opens pass', () => {
    const parent = track(unopened());
    const { adapter, models } = setup(mode, ['Author', 'Book', 'Cover'], [
      track(parent.useDb('first')), track(parent.useDb('second')), track(parent.useDb('third')),
    ]);

    expect(parent.getClient()).toBeUndefined();
    expect(adapter.assertTransactionModels([models.Author, models.Book, models.Cover])).toBeUndefined();
  });

  test('a connection and its useDb descendants pass, at any depth and in any order', () => {
    const parent = track(unopened());
    const child = track(parent.useDb('child'));
    const grandchild = track(child.useDb('grandchild'));
    const sibling = track(parent.useDb('sibling'));
    const { adapter, models } = setup(mode, ['Author', 'Book', 'Cover', 'Dossier'], [parent, grandchild, sibling, child]);

    expect(adapter.assertTransactionModels([models.Author, models.Book, models.Cover, models.Dossier])).toBeUndefined();
    expect(adapter.assertTransactionModels([models.Dossier, models.Cover, models.Book, models.Author])).toBeUndefined();
  });

  test('useDb children that leave their parent\'s list of related databases still pass', () => {
    const parent = track(unopened());
    const { adapter, models } = setup(mode, ['Author', 'Book', 'Cover'], [
      parent, track(parent.useDb('quiet', { noListener: true })), track(parent.useDb('silent', { noListener: true })),
    ]);

    expect(parent.otherDbs).toEqual([]);
    expect(adapter.assertTransactionModels([models.Author, models.Book, models.Cover])).toBeUndefined();
    expect(adapter.assertTransactionModels([models.Cover, models.Book])).toBeUndefined();
  });

  test('walks the related databases and never reads Mongoose\'s private parent', () => {
    const parent = track(unopened());
    const left = track(parent.useDb('left'));
    const right = track(parent.useDb('right'));
    left._parent = undefined;
    right._parent = undefined;
    const { adapter, models } = setup(mode, ['Author', 'Book'], [left, right]);

    expect(adapter.assertTransactionModels([models.Author, models.Book])).toBeUndefined();
  });

  test('a connection that has its client and a useDb child that has none yet pass', () => {
    const parent = withClient(track(unopened()), { id: 'resolved' });
    const child = track(parent.useDb('child'));
    const { adapter, models } = setup(mode, ['Author', 'Book'], [parent, child]);

    expect(child.getClient()).toBeUndefined();
    expect(adapter.assertTransactionModels([models.Author, models.Book])).toBeUndefined();
    expect(adapter.assertTransactionModels([models.Book, models.Author])).toBeUndefined();
  });

  test('a useDb family and an unrelated connection refuse, whether the connections have clients or not', () => {
    const family = track(unopened());
    const members = [track(family.useDb('first')), track(family.useDb('second'))];
    const stranger = track(unopened());
    const { adapter, models, name } = setup(mode, ['Author', 'Book', 'Cover'], [members[0], members[1], stranger]);
    const expected = refusal(name('Author'), name('Cover'));

    expect(thrownBy(() => adapter.assertTransactionModels([models.Author, models.Book, models.Cover]))).toEqual(expected);
    // The family has one client and the stranger none yet.
    for (const member of [family, ...members]) withClient(member, { id: 'family' });
    expect(thrownBy(() => adapter.assertTransactionModels([models.Author, models.Cover]))).toEqual(expected);
    expect(thrownBy(() => adapter.assertTransactionModels([models.Cover, models.Book]))).toEqual(refusal(name('Book'), name('Cover')));
    // The stranger has another client.
    withClient(stranger, { id: 'stranger' });
    expect(thrownBy(() => adapter.assertTransactionModels([models.Author, models.Cover]))).toEqual(expected);
  });

  test('names the first model and the first one that cannot share its client', () => {
    const client = { id: 'shared' };
    const { adapter, models, name } = setup(mode, ['Author', 'Book', 'Cover', 'Dossier'], [
      track(withClient(unopened(), client)), track(withClient(unopened(), client)),
      track(withClient(unopened(), { id: 'cover' })), track(withClient(unopened(), { id: 'dossier' })),
    ]);

    expect(thrownBy(() => adapter.assertTransactionModels([models.Dossier, models.Book, models.Cover, models.Author])))
      .toEqual(refusal(name('Book'), name('Dossier')));
    expect(thrownBy(() => adapter.assertTransactionModels([models.Author, models.Book, models.Dossier, models.Cover])))
      .toEqual(refusal(name('Author'), name('Dossier')));
  });

  test('a model that serves one type is named by that type, not by its own name', () => {
    const { adapter, models, name, model } = setup(mode, ['Author', 'Book'], [track(unopened()), track(unopened())]);

    expect(model('Author')).not.toBe(name('Author'));
    expect(thrownBy(() => adapter.assertTransactionModels([models.Book, models.Author]))).toEqual(refusal(name('Author'), name('Book')));
  });

  test('a model that several types share is named by its modelName', () => {
    const { adapter, runtime, models, name } = setup(mode, ['Book'], [track(unopened())]);
    const Shared = track(unopened()).model(`Affinity${counter}Storage`, schemaFor());
    for (const side of ['Left', 'Right']) {
      const type = new GraphQLObjectType({ name: `Affinity${counter}${side}`, fields: { id: { type: GraphQLID } } });
      runtime.connect(Shared, type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
    }

    expect(thrownBy(() => adapter.assertTransactionModels([Shared, models.Book]))).toEqual(refusal(name('Book'), Shared.modelName));
    expect(Shared.modelName).toBe(`Affinity${counter}Storage`);
  });

  test('a model with no registration, or an adapter that no runtime bound, is named by its modelName', () => {
    const adapter = createMongoAdapter({ referentialIntegrity: mode });
    const [Book, Author] = ['UnboundBook', 'UnboundAuthor'].map((name) => track(unopened()).model(name, schemaFor()));

    expect(thrownBy(() => adapter.assertTransactionModels([Book, Author]))).toEqual(refusal('UnboundAuthor', 'UnboundBook'));
    const { adapter: bound, models, name } = setup(mode, ['Cover'], [track(unopened())]);
    expect(thrownBy(() => bound.assertTransactionModels([Author, models.Cover]))).toEqual(refusal(name('Cover'), 'UnboundAuthor'));
  });

  test('is synchronous and starts nothing on any connection', () => {
    const family = track(unopened());
    const { adapter, models } = setup(mode, ['Author', 'Book', 'Cover'], [track(family.useDb('first')), track(family.useDb('second')), track(unopened())]);
    const starts = [...connections].map((connection) => vi.spyOn(connection, 'startSession'));
    const startDefault = vi.spyOn(mongoose, 'startSession');

    expect(adapter.assertTransactionModels([models.Author, models.Book])).toBeUndefined();
    expect(thrownBy(() => adapter.assertTransactionModels([models.Author, models.Book, models.Cover]))).toBeDefined();
    for (const start of starts) expect(start).not.toHaveBeenCalled();
    expect(startDefault).not.toHaveBeenCalled();
  });
});

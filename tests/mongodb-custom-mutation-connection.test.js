import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../packages/mongodb/src/index.js';

// Which connection opens the owned session of a registered custom mutation in the default
// referentialIntegrity 'off' mode. No database: sessions and connections are stubs.

const fakeSession = (owner) => {
  let active = false;
  return {
    owner,
    inTransaction: () => active,
    startTransaction: vi.fn(() => { active = true; }),
    commitTransaction: vi.fn(async () => { active = false; }),
    abortTransaction: vi.fn(async () => { active = false; }),
    endSession: vi.fn(async () => {}),
  };
};

// A connection that is never opened and starts sessions owned by `owner`.
const stubConnection = (owner, client) => {
  const connection = mongoose.createConnection();
  connection.startSession = vi.fn(async () => fakeSession(owner));
  if (client) connection.getClient = () => client;
  return connection;
};

const schemaFor = () => new mongoose.Schema({ label: String });

let counter = 0;

// Two types whose models come from `modelsFor` (null generates one on the default connection),
// and a custom mutation that records the owner of its session and runs `body`.
const setup = (modelsFor, body = async () => {}) => {
  counter += 1;
  const prefix = `CustomConn${counter}`;
  const types = ['Book', 'Note'].map((name) => new GraphQLObjectType({
    name: `${prefix}${name}`, fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
  }));
  const runtime = createRuntime(createMongoAdapter());
  runtime.preventCreatingCollection(true);
  const models = modelsFor(types);
  types.forEach((type, index) => runtime.connect(models[index], type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`));
  const received = [];
  runtime.registerMutation(`${prefix}Run`, 'custom', null, GraphQLString, async (_input, session, context) => {
    received.push(session.owner);
    await body({ runtime, types, session, context });
    return 'done';
  });
  const schema = runtime.createSchema();
  return {
    run: () => graphql({ schema, source: `mutation { ${prefix}Run }`, contextValue: {} }),
    received,
    types,
  };
};

const onConnection = (connection) => (types) => types.map((type) => connection.model(type.name, schemaFor(), type.name));

describe('MongoDB custom mutation sessions (off mode)', () => {
  let defaultModels;
  const useDbChildren = [];

  // A useDb connection of `parent`, dropped after the test.
  const useDb = (parent, name) => {
    const child = parent.useDb(name);
    useDbChildren.push({ parent, child });
    return child;
  };

  beforeEach(() => {
    defaultModels = new Set(mongoose.modelNames());
    vi.spyOn(mongoose, 'startSession').mockImplementation(async () => fakeSession('default'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Models compiled on the default connection, or on its useDb descendants, would keep it for
    // every later test. Drop the deepest children first.
    for (const name of mongoose.modelNames()) if (!defaultModels.has(name)) mongoose.deleteModel(name);
    for (const { parent, child } of useDbChildren.splice(0).reverse()) {
      for (const name of child.modelNames()) child.deleteModel(name);
      parent.removeDb(child.name);
    }
  });

  const neverOpened = () => vi.spyOn(mongoose.connection, 'getClient').mockReturnValue(undefined);

  test('opens the session on the one connection of the registered models while the default connection was never opened', async () => {
    neverOpened();
    const app = stubConnection('app');
    const { run, received } = setup(onConnection(app));

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['app']);
    expect(app.startSession).toHaveBeenCalledOnce();
    expect(mongoose.startSession).not.toHaveBeenCalled();
  });

  test('saveObject with the callback session joins it and never starts another session', async () => {
    neverOpened();
    const app = stubConnection('app');
    const saved = [];
    const { run, received, types } = setup(onConnection(app), async ({ runtime, session, context }) => {
      for (const type of types) await runtime.saveObject(type.name, { label: 'imported' }, session, context);
    });
    for (const type of types) {
      vi.spyOn(app.model(type.name).prototype, 'save').mockImplementation(async function save() {
        saved.push(this.$session().owner);
        return this;
      });
    }

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['app']);
    expect(saved).toEqual(['app', 'app']);
    expect(app.startSession).toHaveBeenCalledOnce();
    expect(mongoose.startSession).not.toHaveBeenCalled();
  });

  test('withTransaction uses a supplied session or model as is and never reads the registrations', async () => {
    neverOpened();
    const app = stubConnection('app');
    const Model = app.model(`CustomConnDirect${counter}`, schemaFor());
    const getRegistrations = vi.fn(() => [{ model: Model }]);
    const adapter = createMongoAdapter();
    adapter.bind({ getModel: () => null, getType: () => null, getRegistrations });
    getRegistrations.mockClear();

    const active = fakeSession('caller');
    active.startTransaction();
    const body = vi.fn(async (session) => ({ session }));
    await expect(adapter.withTransaction(active, body)).resolves.toEqual({ session: active });
    expect(body).toHaveBeenCalledWith(active);

    const owned = await adapter.withTransaction(null, async (session) => session.owner, Model);
    expect(owned).toBe('app');
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(mongoose.startSession).not.toHaveBeenCalled();
  });

  test('treats connections that share one MongoClient, such as useDb children, as one client', async () => {
    neverOpened();
    const client = {};
    const first = stubConnection('first', client);
    const second = stubConnection('second', client);
    const { run, received } = setup(([book, note]) => [
      first.model(book.name, schemaFor(), book.name),
      second.model(note.name, schemaFor(), note.name),
    ]);

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['first']);
  });

  test('keeps the default connection once it has a client', async () => {
    vi.spyOn(mongoose.connection, 'getClient').mockReturnValue({});
    const app = stubConnection('app');
    const { run, received } = setup(onConnection(app));

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['default']);
    expect(app.startSession).not.toHaveBeenCalled();
  });

  test('keeps the default connection when the registered models use different clients', async () => {
    neverOpened();
    const first = stubConnection('first');
    const second = stubConnection('second');
    const { run, received } = setup(([book, note]) => [
      first.model(book.name, schemaFor(), book.name),
      second.model(note.name, schemaFor(), note.name),
    ]);

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['default']);
    expect(first.startSession).not.toHaveBeenCalled();
    expect(second.startSession).not.toHaveBeenCalled();
  });

  test('keeps the default connection while an application model is compiled on it', async () => {
    neverOpened();
    // The application opens the default connection, maybe after a request arrived, and its
    // callback may write this model with the supplied session.
    mongoose.model(`CustomConnAudit${counter}`, new mongoose.Schema({ msg: String }));
    const app = stubConnection('app');
    const { run, received } = setup(onConnection(app));

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['default']);
    expect(app.startSession).not.toHaveBeenCalled();
  });

  test('keeps the default connection while an application model is compiled on one of its useDb connections', async () => {
    neverOpened();
    // A useDb connection shares the default connection's client, so the application opens it too.
    const child = useDb(mongoose.connection, `custom_conn_audit_${counter}`);
    child.model(`CustomConnChildAudit${counter}`, new mongoose.Schema({ msg: String }));
    expect(mongoose.connection.modelNames()).not.toContain(`CustomConnChildAudit${counter}`);
    const app = stubConnection('app');
    const { run, received } = setup(onConnection(app));

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['default']);
    expect(app.startSession).not.toHaveBeenCalled();
  });

  test('keeps the default connection while an application model is compiled on a nested useDb connection of it', async () => {
    neverOpened();
    // useDb() of a useDb connection shares the same client. Mongoose lists the nested connection
    // only in its parent's otherDbs, and each child lists its parent there too.
    const tenant = useDb(mongoose.connection, `custom_conn_tenant_${counter}`);
    const audit = useDb(tenant, `custom_conn_nested_audit_${counter}`);
    audit.model(`CustomConnNestedAudit${counter}`, new mongoose.Schema({ msg: String }));
    expect(mongoose.connection.otherDbs).toContain(tenant);
    expect(mongoose.connection.otherDbs).not.toContain(audit);
    expect(tenant.otherDbs).toEqual([mongoose.connection, audit]);
    expect(tenant.modelNames()).toEqual([]);
    const app = stubConnection('app');
    const { run, received } = setup(onConnection(app));

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['default']);
    expect(app.startSession).not.toHaveBeenCalled();
  });

  test('keeps the default connection while a generated model is compiled on it', async () => {
    neverOpened();
    const app = stubConnection('app');
    const { run, received } = setup(([book]) => [app.model(book.name, schemaFor(), book.name), null]);

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['default']);
    expect(app.startSession).not.toHaveBeenCalled();
  });

  test('generated models keep mongoose.startSession', async () => {
    neverOpened();
    const { run, received } = setup(() => [null, null]);

    expect((await run()).errors).toBeUndefined();
    expect(received).toEqual(['default']);
  });

  test('an unbound adapter keeps the default connection', async () => {
    neverOpened();
    const owner = await createMongoAdapter().withTransaction(null, async (session) => session.owner);
    expect(owner).toBe('default');
  });
});

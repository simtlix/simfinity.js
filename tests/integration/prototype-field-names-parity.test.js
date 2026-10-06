import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

// A scalar, scalar lists at the root, in an embedded object and in embedded list items, and a
// reference stored as makerId, each named like a member every plain object inherits, next to
// normally named twins. The reference has its own type, so the others are written without it.
// Shelf holds the shapes MongoDB rejects when the schema is created: a scalar stored as
// constructor, and an embedded object and an embedded list so named.
const createTypes = () => {
  const Maker = new GraphQLObjectType({
    name: 'ProtoParityMaker',
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  const Spec = new GraphQLObjectType({
    name: 'ProtoParitySpec',
    fields: {
      label: { type: GraphQLString },
      toString: { type: GraphQLString },
      tags: { type: new GraphQLList(GraphQLString) },
      valueOf: { type: new GraphQLList(GraphQLString) },
    },
  });
  const Gauge = new GraphQLObjectType({
    name: 'ProtoParityGauge',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      toString: { type: GraphQLString },
      tags: { type: new GraphQLList(GraphQLString) },
      valueOf: { type: new GraphQLList(GraphQLString) },
      spec: { type: Spec, extensions: { relation: { embedded: true } } },
      specs: { type: new GraphQLList(Spec), extensions: { relation: { embedded: true } } },
    },
  });
  const Team = new GraphQLObjectType({
    name: 'ProtoParityTeam',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      constructor: { type: Maker, extensions: { relation: { embedded: false, connectionField: 'makerId' } } },
    },
  });
  const Shelf = new GraphQLObjectType({
    name: 'ProtoParityShelf',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      constructor: { type: GraphQLString },
      toString: { type: Spec, extensions: { relation: { embedded: true } } },
      valueOf: { type: new GraphQLList(Spec), extensions: { relation: { embedded: true } } },
    },
  });
  return {
    Maker, Spec, Gauge, Team, Shelf,
  };
};

const register = (api, {
  Maker, Spec, Gauge, Team, Shelf,
}, storesEveryShape) => {
  api.connect(null, Maker, 'protoParitymaker', 'protoParitymakers');
  api.addNoEndpointType(Spec);
  api.connect(null, Gauge, 'protoParitygauge', 'protoParitygauges');
  api.connect(null, Team, 'protoParityteam', 'protoParityteams');
  if (storesEveryShape) api.connect(null, Shelf, 'protoParityshelf', 'protoParityshelves');
  return api.createSchema();
};

// Each backend builds its runtime and gives raw access to what it stores: `raw` returns the stored
// document or row of a type, and `writeSpec` replaces a gauge's embedded object outside Simfinity.
// `open` hands over its cleanup as soon as there is something to clean, so a setup that fails
// halfway still drops what it created and closes its connections.
const backends = {
  mongodb: {
    uri: mongoUri,
    storesEveryShape: false,
    async open(namespace, types, onCleanup) {
      await mongoose.connect(mongoUri, { dbName: namespace });
      onCleanup(async () => {
        try {
          await mongoose.connection.db.dropDatabase();
        } finally {
          await mongoose.disconnect();
        }
      });
      const api = createRuntime(createMongoAdapter());
      api.preventCreatingCollection(true);
      const schema = register(api, types, false);
      for (const { model } of api.getRegistrations()) if (model) await model.createCollection();
      const key = (id) => new mongoose.Types.ObjectId(id);
      return {
        schema,
        raw: (type, id) => api.getModel(type).collection.findOne({ _id: key(id) }),
        writeSpec: (id, spec) => api.getModel(types.Gauge).collection.updateOne({ _id: key(id) }, { $set: { spec } }),
      };
    },
  },
  postgres: {
    uri: postgresUri,
    storesEveryShape: true,
    async open(namespace, types, onCleanup) {
      const pool = new pg.Pool({ connectionString: postgresUri });
      onCleanup(async () => {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        } finally {
          await pool.end();
        }
      });
      const api = createPostgres({ pool, schema: namespace });
      const schema = register(api, types, true);
      await api.initializeDatabase();
      const table = (type) => `"${namespace}"."${type.name}"`;
      return {
        schema,
        raw: async (type, id) => (await pool.query(`SELECT * FROM ${table(type)} WHERE id = $1`, [id])).rows[0],
        writeSpec: (id, spec) => pool.query(`UPDATE ${table(types.Gauge)} SET "spec" = $2::jsonb WHERE id = $1`, [id, JSON.stringify(spec)]),
      };
    },
  },
};

for (const [name, backend] of Object.entries(backends)) {
  describe.skipIf(!backend.uri)(`fields named like Object.prototype members on ${name}`, () => {
    const namespace = `proto_${randomUUID().replaceAll('-', '')}`;
    const types = createTypes();
    let store;
    let cleanup;

    const run = async (source, variableValues) => {
      const result = await graphql({
        schema: store.schema, source, variableValues, contextValue: {},
      });
      expect(result.errors).toBeUndefined();
      return result.data;
    };
    // Inputs are inline literals: graphql-js reads variable objects with plain property access, so it
    // rejects a variable object that omits such a field as holding the inherited member.
    const add = async (input, fields = 'id', type = 'gauge') => (await run(
      `mutation { addprotoParity${type}(input: { ${input} }) { ${fields} } }`,
    ))[`addprotoParity${type}`];
    const update = async (id, input, fields = 'id', type = 'gauge') => (await run(
      `mutation { updateprotoParity${type}(input: { id: "${id}", ${input} }) { ${fields} } }`,
    ))[`updateprotoParity${type}`];
    const read = async (id, fields, type = 'gauge') => (await run(
      `query($id: ID) { protoParity${type}(id: $id) { ${fields} } }`,
      { id },
    ))[`protoParity${type}`];

    beforeAll(async () => {
      store = await backend.open(namespace, types, (close) => { cleanup = close; });
    }, 30000);

    afterAll(async () => {
      await cleanup?.();
    });

    test('a create that omits a field stores no value, and an update that omits it keeps the stored one', async () => {
      const omitted = await add('name: "omitted"', 'id toString');
      const kept = await add('name: "kept", toString: "t"');
      const renamed = await update(kept.id, 'name: "renamed"', 'name toString');

      expect(omitted.toString).toBeNull();
      const stored = await store.raw(types.Gauge, omitted.id);
      if (name === 'mongodb') expect(Object.hasOwn(stored, 'toString')).toBe(false);
      else expect(stored.toString).toBeNull();
      expect(renamed).toEqual({ name: 'renamed', toString: 't' });
      expect((await store.raw(types.Gauge, kept.id)).toString).toBe('t');
      expect(await read(omitted.id, 'name toString')).toEqual({ name: 'omitted', toString: null });
      const listed = await run('{ protoParitygauges { id toString } }');
      expect(listed.protoParitygauges.find((row) => row.id === omitted.id)).toEqual({ id: omitted.id, toString: null });
    });

    test('a create stores [] for an omitted list so named, like for a normally named one', async () => {
      const lists = 'tags valueOf';
      const fields = `id ${lists} spec { ${lists} } specs { ${lists} }`;
      const created = await add('name: "fresh", spec: { label: "s" }, specs: [{ label: "i" }]', fields);
      const expected = {
        id: created.id, tags: [], valueOf: [], spec: { tags: [], valueOf: [] }, specs: [{ tags: [], valueOf: [] }],
      };
      const listed = await run(`{ protoParitygauges { ${fields} } }`);

      expect(created).toEqual(expected);
      expect(await read(created.id, fields)).toEqual(expected);
      expect(listed.protoParitygauges.find((row) => row.id === created.id)).toEqual(expected);
      const stored = await store.raw(types.Gauge, created.id);
      expect([stored.valueOf, stored.spec.valueOf]).toEqual([[], []]);
    });

    test('a stored embedded object without such a key reads null and a partial update completes it like other names', async () => {
      const { id } = await add('name: "legacy", spec: { label: "created" }');
      // Written before the field existed, or outside Simfinity.
      await store.writeSpec(id, { label: 'legacy' });

      const legacy = (await read(id, 'spec { label toString tags valueOf }')).spec;
      const updated = await update(id, 'spec: { label: "b" }', 'spec { label toString tags valueOf }');

      // A hydrated MongoDB document also reads the absent `tags` as [], a default Mongoose skips for a
      // path it finds the inherited member under.
      expect(legacy).toMatchObject({ label: 'legacy', toString: null, valueOf: null });
      expect(updated.spec).toEqual({
        label: 'b', toString: null, tags: [], valueOf: [],
      });
      const { spec } = await store.raw(types.Gauge, id);
      expect(spec).toEqual({ label: 'b', tags: [], valueOf: [] });
      expect(Object.hasOwn(spec, 'toString')).toBe(false);
    });

    test('a reference named constructor reads null when its connectionField holds none', async () => {
      const maker = (await run('mutation { addprotoParitymaker(input: { name: "maker" }) { id } }')).addprotoParitymaker;
      const linked = await add(`name: "linked", constructor: { id: "${maker.id}" }`, 'id constructor { name }', 'team');
      const unlinked = await add('name: "unlinked"', 'id constructor { name }', 'team');
      const cleared = await add(`name: "cleared", constructor: { id: "${maker.id}" }`, 'id', 'team');
      await update(cleared.id, 'constructor: null', 'id', 'team');

      const listed = await run('{ protoParityteams { id constructor { name } } }');
      const rows = Object.fromEntries(listed.protoParityteams.map((row) => [row.id, row.constructor]));

      expect(linked.constructor).toEqual({ name: 'maker' });
      expect(unlinked.constructor).toBeNull();
      expect([rows[linked.id], rows[unlinked.id], rows[cleared.id]]).toEqual([{ name: 'maker' }, null, null]);
      expect(await read(unlinked.id, 'constructor { name }', 'team')).toEqual({ constructor: null });
      expect(await read(cleared.id, 'constructor { name }', 'team')).toEqual({ constructor: null });
      const stored = await store.raw(types.Team, unlinked.id);
      if (name === 'mongodb') expect(Object.hasOwn(stored, 'makerId')).toBe(false);
      else expect(stored.makerId).toBeNull();
    });

    // The shapes MongoDB rejects when the schema is created are stored by SQL backends.
    if (backend.storesEveryShape) {
      test('stores a scalar stored as constructor and embedded values so named', async () => {
        const fields = 'id name constructor toString { label valueOf } valueOf { label valueOf }';
        const full = await add('name: "full", constructor: "c", toString: { label: "o" }, valueOf: [{ label: "l" }]', fields, 'shelf');
        const empty = await add('name: "empty"', fields, 'shelf');
        const renamed = await update(full.id, 'name: "renamed"', fields, 'shelf');
        const listed = await run(`{ protoParityshelves { ${fields} } }`);
        const rows = Object.fromEntries(listed.protoParityshelves.map((row) => [row.id, row]));
        const expected = {
          id: full.id, name: 'renamed', constructor: 'c', toString: { label: 'o', valueOf: [] }, valueOf: [{ label: 'l', valueOf: [] }],
        };

        expect(full).toEqual({ ...expected, name: 'full' });
        // Like a normally named embedded object, an omitted one is stored with its list defaults.
        expect(empty).toEqual({
          id: empty.id, name: 'empty', constructor: null, toString: { label: null, valueOf: [] }, valueOf: [],
        });
        expect(renamed).toEqual(expected);
        expect(await read(full.id, fields, 'shelf')).toEqual(expected);
        expect([rows[full.id], rows[empty.id]]).toEqual([expected, empty]);
      });
    } else {
      test('rejects a scalar stored as constructor and embedded values so named', () => {
        const api = createRuntime(createMongoAdapter());
        api.preventCreatingCollection(true);
        const { Spec, Shelf } = createTypes();
        api.addNoEndpointType(Spec);
        api.connect(null, Shelf, 'protoParityshelf', 'protoParityshelves');

        expect(() => api.createSchema()).toThrow(expect.objectContaining({
          message: 'ProtoParityShelf.constructor cannot be stored on MongoDB: Mongoose drops a stored path named constructor',
          extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
        }));
      });
    }
  });
}

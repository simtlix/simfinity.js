import { describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createRuntime, describeModels, SimfinityError } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../packages/postgres/src/index.js';

// A relation's connectionField names a field of the record that stores the link, never a path into
// an embedded value: `meta.key` would store the link inside `meta` on MongoDB, read it back as
// missing, and name a column "meta.key" on PostgreSQL. createSchema() and describeModels(), which
// PostgreSQL and MongoDB's transactional mode use, reject it before anything is built.

// Each case has its own target, so that a schema one case builds never shares a compiled model with
// another case.
const targetType = (name) => new GraphQLObjectType({
  name: `${name}Target`,
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
});
const metaType = (name) => new GraphQLObjectType({
  name, fields: { label: { type: GraphQLString }, key: { type: GraphQLID } },
});

const expectInvalidModel = (build, message) => {
  let thrown;
  try {
    build();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SimfinityError);
  expect(thrown.extensions).toMatchObject({ code: 'INVALID_MODEL', status: 400 });
  expect(thrown.message).toBe(message);
};

// One runtime per case, on the MongoDB adapter without a connection: createSchema() builds the
// generated models in memory, so a rejected schema must leave no model behind.
const mongoSchema = (name, ownerFields, { extraTypes = [], entities = [] } = {}) => {
  const Target = targetType(name);
  const Meta = metaType(`${name}Meta`);
  const Owner = new GraphQLObjectType({
    name: `${name}Owner`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      meta: { type: Meta, extensions: { relation: { embedded: true } } },
      ...ownerFields(Target, Meta),
    }),
  });
  const runtime = createRuntime(createMongoAdapter());
  runtime.preventCreatingCollection(true);
  runtime.connect(null, Target, `${name.toLowerCase()}target`, `${name.toLowerCase()}targets`);
  runtime.connect(null, Owner, `${name.toLowerCase()}owner`, `${name.toLowerCase()}owners`);
  runtime.addNoEndpointType(Meta);
  for (const type of entities) runtime.connect(null, type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
  for (const type of extraTypes) runtime.addNoEndpointType(type);
  return { runtime, Owner, Meta };
};

describe('connectionField names a field, not a path', () => {
  test('a reference whose connectionField is a path into an embedded value is rejected, with what to do instead', () => {
    const { runtime, Owner } = mongoSchema('CfRef', (Target) => ({
      owner: { type: Target, extensions: { relation: { connectionField: 'meta.key' } } },
    }));
    expectInvalidModel(() => runtime.createSchema(), 'CfRefOwner.owner extensions.relation.connectionField meta.key must name a '
      + 'field of CfRefOwner, not a path into an embedded value; declare a reference that belongs to an embedded value '
      + 'inside the embedded type');
    expect(mongoose.modelNames()).not.toContain(Owner.name);
  });

  test('a collection whose connectionField is a path into the item type is rejected', () => {
    const Child = new GraphQLObjectType({
      name: 'CfColChild',
      fields: () => ({
        id: { type: GraphQLID },
        meta: { type: ChildMeta, extensions: { relation: { embedded: true } } },
      }),
    });
    const ChildMeta = new GraphQLObjectType({
      name: 'CfColChildMeta',
      fields: { parent: { type: GraphQLID } },
    });
    const Parent = new GraphQLObjectType({
      name: 'CfColParent',
      fields: { id: { type: GraphQLID }, children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'meta.parent' } } } },
    });
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.addNoEndpointType(ChildMeta);
    runtime.connect(null, Parent, 'cfcolparent', 'cfcolparents');
    runtime.connect(null, Child, 'cfcolchild', 'cfcolchildren');
    expectInvalidModel(() => runtime.createSchema(), 'CfColParent.children extensions.relation.connectionField meta.parent must '
      + 'name a field of CfColChild, not a path into an embedded value');
    expect(() => describeModels([{ gqltype: Parent }, { gqltype: Child }, { gqltype: ChildMeta, endpoint: false }]))
      .toThrow('CfColParent.children extensions.relation.connectionField meta.parent must name a field of CfColChild');
  });

  test('a reference of an embedded type is checked against that embedded type', () => {
    const Target = targetType('CfEmbCity');
    const Address = new GraphQLObjectType({
      name: 'CfEmbAddress',
      fields: () => ({
        street: { type: GraphQLString },
        geo: { type: Geo, extensions: { relation: { embedded: true } } },
        city: { type: Target, extensions: { relation: { connectionField: 'geo.cityId' } } },
      }),
    });
    const Geo = new GraphQLObjectType({ name: 'CfEmbGeo', fields: { cityId: { type: GraphQLID } } });
    const { runtime } = mongoSchema('CfEmb', () => ({
      address: { type: Address, extensions: { relation: { embedded: true } } },
    }), { extraTypes: [Address, Geo], entities: [Target] });
    expectInvalidModel(() => runtime.createSchema(), 'CfEmbAddress.city extensions.relation.connectionField geo.cityId must name '
      + 'a field of CfEmbAddress, not a path into an embedded value; declare a reference that belongs to an embedded value '
      + 'inside the embedded type');
  });

  test('a connectionField that is not a string is rejected', () => {
    // A String object, as an application could pass one; MongoDB would key the link by its text.
    const boxed = new String('targetId');
    for (const [index, connectionField] of [boxed, ['targetId'], 7].entries()) {
      const { runtime } = mongoSchema(`CfType${index}`, (Target) => ({
        owner: { type: Target, extensions: { relation: { connectionField } } },
      }));
      expectInvalidModel(() => runtime.createSchema(),
        `CfType${index}Owner.owner extensions.relation.connectionField must be the name of a field of CfType${index}Owner`);
    }
  });

  test('describeModels, which PostgreSQL and transactional MongoDB use, rejects a reference path too', () => {
    const Target = targetType('CfDesc');
    const Meta = metaType('CfDescMeta');
    const Owner = new GraphQLObjectType({
      name: 'CfDescOwner',
      fields: {
        id: { type: GraphQLID },
        meta: { type: Meta, extensions: { relation: { embedded: true } } },
        owner: { type: Target, extensions: { relation: { connectionField: 'meta.key' } } },
      },
    });
    expect(() => describeModels([{ gqltype: Target }, { gqltype: Owner }, { gqltype: Meta, endpoint: false }]))
      .toThrow('CfDescOwner.owner extensions.relation.connectionField meta.key must name a field of CfDescOwner');
  });

  test('plain connectionFields, and a reference declared inside the embedded type, build as before', () => {
    const Target = targetType('CfOkLocation');
    const Location = new GraphQLObjectType({
      name: 'CfOkLocation',
      fields: { label: { type: GraphQLString }, owner: { type: Target, extensions: { relation: { connectionField: 'ownerId' } } } },
    });
    const { runtime, Owner } = mongoSchema('CfOk', (OwnTarget) => ({
      owner: { type: OwnTarget, extensions: { relation: { connectionField: 'targetId' } } },
      location: { type: Location, extensions: { relation: { embedded: true } } },
    }), { extraTypes: [Location], entities: [Target] });
    runtime.createSchema();
    const { schema } = runtime.getModel(Owner);
    expect(schema.path('targetId')?.instance).toBe('ObjectId');
    expect(schema.path('location.ownerId')?.instance).toBe('ObjectId');
  });
});

// An embedded type is stored by every model that embeds it, whether or not it is registered itself
// with addNoEndpointType(): a readOnly embedded value needs no generated input, so it builds without
// a registration. Its references are checked like those of a registered type, at any depth, on every
// adapter mode.
let postgresSchemas = 0;
const adapterModes = {
  MongoDB: () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    return runtime;
  },
  'transactional MongoDB': () => {
    const runtime = createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }));
    runtime.preventCreatingCollection(true);
    return runtime;
  },
  PostgreSQL: () => createPostgres({ pool: { connect() {}, query() {} }, schema: `cf_unregistered_${postgresSchemas++}` }),
};

describe.each(Object.keys(adapterModes))('references in an unregistered embedded type on %s', (mode) => {
  const prefix = { MongoDB: 'CfUm', 'transactional MongoDB': 'CfUt', PostgreSQL: 'CfUp' }[mode];
  const readOnlyEmbedded = (type, list = false) => ({
    type: list ? new GraphQLList(type) : type, extensions: { relation: { embedded: true }, readOnly: true },
  });
  // Owner and Target are the only registered types. Meta, and Outer, which embeds it, are not.
  const build = (name, connectionField, shape) => {
    const Target = targetType(`${prefix}${name}`);
    const Meta = new GraphQLObjectType({
      name: `${prefix}${name}Meta`,
      fields: { label: { type: GraphQLString }, target: { type: Target, extensions: { relation: { connectionField } } } },
    });
    const Outer = new GraphQLObjectType({
      name: `${prefix}${name}Outer`,
      fields: { title: { type: GraphQLString }, meta: { type: Meta, extensions: { relation: { embedded: true } } } },
    });
    const Owner = new GraphQLObjectType({
      name: `${prefix}${name}Owner`,
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        ...(shape.includes('object') ? { meta: readOnlyEmbedded(Meta) } : {}),
        ...(shape.includes('list') ? { metas: readOnlyEmbedded(Meta, true) } : {}),
        ...(shape.includes('nested') ? { outer: readOnlyEmbedded(Outer) } : {}),
      },
    });
    const runtime = adapterModes[mode]();
    runtime.connect(null, Target, Target.name.toLowerCase(), `${Target.name.toLowerCase()}s`);
    runtime.connect(null, Owner, Owner.name.toLowerCase(), `${Owner.name.toLowerCase()}s`);
    return { runtime, Owner, Meta };
  };

  test.each([
    ['a readOnly embedded object', 'Object', ['object']],
    ['a readOnly embedded list', 'List', ['list']],
    ['an embedded object of another unregistered embedded type', 'Nested', ['nested']],
  ])('rejects a path in %s, before any model is built', (label, name, shape) => {
    const { runtime, Owner, Meta } = build(name, 'nested.targetId', shape);
    expectInvalidModel(() => runtime.createSchema(), `${Meta.name}.target extensions.relation.connectionField nested.targetId `
      + `must name a field of ${Meta.name}, not a path into an embedded value; declare a reference that belongs to an `
      + 'embedded value inside the embedded type');
    expect(mongoose.modelNames()).not.toContain(Owner.name);
  });

  test('builds a plain connectionField in those embedded types, and stores the link in the embedded value', () => {
    const { runtime, Owner } = build('Plain', 'targetId', ['object', 'list', 'nested']);
    runtime.createSchema();
    if (mode === 'PostgreSQL') {
      const tables = Object.fromEntries(runtime.describeDatabase().tables.map((table) => [table.name, table]));
      for (const path of ['meta', 'metas', 'outer__meta']) {
        const table = tables[`${Owner.name}__${path}`];
        expect(table.columns.map((column) => column.name)).toContain('targetId');
        expect(table.foreignKeys).toContainEqual(expect.objectContaining({ columns: ['targetId'], targetTable: `${prefix}PlainTarget` }));
      }
    } else {
      const { schema } = runtime.getModel(Owner);
      for (const path of ['meta.targetId', 'metas.targetId', 'outer.meta.targetId']) {
        expect(schema.path(path)?.instance).toBe('ObjectId');
      }
    }
  });
});

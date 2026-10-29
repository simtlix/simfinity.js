import { afterEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLBoolean, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { describeModels } from '../packages/core/src/metadata.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createMongoModel } from '../packages/mongodb/src/mongo/models.js';
import { createPostgres, describeDatabase } from '../packages/postgres/src/index.js';

const names = [];
let counter = 0;
const object = (label, fields, extensions) => new GraphQLObjectType({ name: `LintStorage${counter++}${label}`, fields, extensions });
const scalar = { type: GraphQLString };
const relation = (type, connectionField, extra = {}) => ({ type, extensions: { relation: { connectionField }, ...extra } });
const embedded = (type, extra = {}) => ({ type, extensions: { relation: { embedded: true }, ...extra } });
const generated = (type) => {
  const model = createMongoModel(type, null, { createCollection: false });
  names.push(model.modelName);
  return model;
};
const supplied = (type) => {
  const model = mongoose.model(type.name, new mongoose.Schema({ label: String }));
  names.push(model.modelName);
  return model;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of names.splice(0)) mongoose.deleteModel(name);
});

describe('ESLint modeling storage contract evidence', () => {
  it.each(['postgres', 'transactional'])('requires links even with readOnly and own resolver on %s', (engine) => {
    const runtime = engine === 'postgres'
      ? createPostgres({ pool: { connect: vi.fn(), query: vi.fn() } })
      : createRuntime(createMongoAdapter({ referentialIntegrity: engine }));
    runtime.preventCreatingCollection(true);
    const Child = object('Child', { label: scalar });
    const Root = object('Root', { label: scalar, children: { ...relation(new GraphQLList(Child), undefined, { readOnly: true }), resolve: () => [] } });
    runtime.connect(null, Root, 'root', 'roots');
    runtime.addNoEndpointType(Child);
    expect(() => runtime.createSchema()).toThrow(/requires a child connectionField/);
  });

  it('infers a singular ID inverse and synthesizes a private inverse', () => {
    const Child = object('Child', { ownerId: { type: GraphQLID }, label: scalar });
    const Private = object('Private', { label: scalar });
    const Root = object('Root', { label: scalar, children: relation(new GraphQLList(Child), 'ownerId'), private: relation(new GraphQLList(Private), 'ownerId') });
    const { entities } = describeModels([{ gqltype: Root }]);
    expect(entities.find((type) => type.name === Child.name).fields.find((field) => field.name === 'ownerId'))
      .toMatchObject({ kind: 'reference', target: Root.name, inferred: true });
    expect(entities.find((type) => type.name === Private.name).fields.find((field) => field.name === 'ownerId'))
      .toMatchObject({ kind: 'reference', target: Root.name, private: true });
  });

  it('rejects distinct parents claiming one inferred inverse', () => {
    const Child = object('Child', { ownerId: { type: GraphQLID }, label: scalar });
    const A = object('A', { children: relation(new GraphQLList(Child), 'ownerId') });
    const B = object('B', { children: relation(new GraphQLList(Child), 'ownerId') });
    expect(() => describeModels([{ gqltype: A }, { gqltype: B }])).toThrow(/Conflicting inverse relation/);
  });

  it('rejects nonreciprocal collection links in metadata', () => {
    const Child = object('Child', () => ({ label: scalar, ownerId: relation(new GraphQLList(Root), 'otherId') }));
    const Root = object('Root', { children: relation(new GraphQLList(Child), 'ownerId') });
    expect(() => describeModels([{ gqltype: Root }])).toThrow(/Implicit many-to-many/);
  });

  it('rejects storage aliases that collide but accepts independent embedded levels', () => {
    const Child = object('Child', { ownerId: scalar });
    const Root = object('Root', { ownerId: scalar, owner: relation(Child, 'ownerId') });
    expect(() => describeModels([{ gqltype: Root }])).toThrow(/Storage collision/);
    const Good = object('Good', { ownerId: scalar, value: embedded(Child) });
    expect(() => describeModels([{ gqltype: Good }])).not.toThrow();
  });

  it('allows supplied Mongo models with a readOnly input-cycle break', () => {
    const Child = object('Child', () => ({ label: scalar, back: embedded(Root, { readOnly: true }) }));
    const Root = object('Root', { label: scalar, child: embedded(Child) });
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(supplied(Root), Root, 'root', 'roots');
    runtime.connect(supplied(Child), Child, 'child', 'children');
    expect(() => runtime.createSchema()).not.toThrow();
    expect(() => describeModels([{ gqltype: Root }])).toThrow(/Embedded cycle/);
  });

  it('rejects embedded collections but permits singular embedded references', () => {
    const Child = object('Child', () => ({ label: scalar, children: relation(new GraphQLList(Root), 'ownerId') }));
    const Root = object('Root', { value: embedded(Child) });
    expect(() => describeModels([{ gqltype: Root }])).toThrow(/Non-embedded collections inside embedded objects/);
    const Target = object('Target', { label: scalar });
    const Value = object('Value', { owner: relation(Target, 'ownerId') });
    const Good = object('Good', { value: embedded(Value) });
    expect(describeDatabase([{ gqltype: Good }]).tables.some((table) => table.ownership)).toBe(true);
  });

  it('validates SQL index fields and resolves storage aliases', () => {
    const Bad = object('Bad', { label: scalar }, { indexes: [{ fields: ['label', 'label'] }] });
    expect(() => describeDatabase([{ gqltype: Bad }])).toThrow(/nonempty list of distinct/);
    const Lists = object('Lists', { tags: { type: new GraphQLList(GraphQLString) } }, { indexes: [{ fields: ['tags'] }] });
    expect(() => describeDatabase([{ gqltype: Lists }])).toThrow(/stored scalar or reference/);
    const Target = object('Target', { label: scalar });
    const Good = object('Good', { owner: relation(Target, 'ownerId'), label: scalar }, { indexes: [{ fields: ['ownerId', 'label'] }] });
    expect(describeDatabase([{ gqltype: Good }]).tables.find((table) => table.name === Good.name).indexes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ columns: ['ownerId', 'label'] })]));
  });

  it('distinguishes SQL entity IDs, embedded IDs, JSON keys and physical private columns', () => {
    const Bad = object('Bad', { id: { type: GraphQLInt }, label: scalar });
    expect(() => describeDatabase([{ gqltype: Bad }])).toThrow(/Reserved identity/);
    const Value = object('Value', { id: { type: GraphQLInt }, __note: scalar });
    const Good = object('Good', { value: embedded(Value) });
    expect(() => describeDatabase([{ gqltype: Good }])).not.toThrow();
    const Target = object('Target', { label: scalar });
    const Owned = object('Owned', { id: { type: GraphQLInt }, owner: relation(Target, 'ownerId') });
    const Owner = object('Owner', { value: embedded(Owned) });
    expect(() => describeDatabase([{ gqltype: Owner }])).not.toThrow();
    const Private = object('Private', { owner: relation(Target, '__owner') });
    expect(() => describeDatabase([{ gqltype: Private }])).toThrow(/Reserved private column/);
  });

  it('rejects Mongo constructor storage but permits an aliased reference and other prototype scalars', () => {
    const Bad = object('Bad', { constructor: scalar });
    expect(() => generated(Bad)).toThrow(/Mongoose drops a stored path named constructor/);
    const Target = object('Target', { label: scalar });
    const Good = object('Good', { constructor: relation(Target, 'makerId'), toString: scalar });
    const model = generated(Good);
    expect(model.schema.path('makerId').instance).toBe('ObjectId');
    expect(model.schema.path('toString').instance).toBe('String');
  });

  it('demonstrates Mongo ignored unique versus SQL supported list uniqueness', () => {
    const Type = object('Unique', {
      key: { type: GraphQLID, extensions: { unique: true } },
      flag: { type: GraphQLBoolean, extensions: { unique: true } },
      tags: { type: new GraphQLList(GraphQLString), extensions: { unique: true } },
      label: { type: GraphQLString, extensions: { unique: true } },
    });
    const model = generated(Type);
    expect(model.schema.path('key').options.unique).toBeUndefined();
    expect(model.schema.path('flag').options.unique).toBeUndefined();
    expect(model.schema.path('tags').options.unique).toBeUndefined();
    expect(model.schema.path('label').options.unique).toBe(true);
    expect(describeDatabase([{ gqltype: Type }]).tables.some((table) => table.uniqueKeys)).toBe(true);
    const Whole = object('Whole', { value: embedded(Type, { unique: true }) });
    expect(() => describeDatabase([{ gqltype: Whole }])).toThrow(/Whole embedded-object uniqueness/);
  });

  it('installs the entity id resolver on a shared embedded type and preserves own resolvers', () => {
    const Part = object('Part', { id: { type: GraphQLID }, label: scalar });
    const own = (row) => row.id;
    const Custom = object('Custom', { id: { type: GraphQLID, resolve: own }, label: scalar });
    const Root = object('Root', { label: scalar, value: embedded(Part), custom: embedded(Custom) });
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    for (const type of [Root, Part, Custom]) runtime.connect(supplied(type), type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
    runtime.createSchema();
    expect(Part.getFields().id.resolve({ _id: 'stored', id: 'declared' })).toBe('stored');
    expect(Custom.getFields().id.resolve).toBe(own);
  });
});

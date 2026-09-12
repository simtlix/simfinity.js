import { describe, it, expect } from 'vitest';
import {
  GraphQLObjectType, GraphQLString, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLEnumType,
} from 'graphql';
import { describeModels } from '../packages/core/src/metadata.js';

const relation = (connectionField, embedded = false) => ({ relation: { connectionField, embedded } });

describe('driver-free model metadata', () => {
  it('normalizes reciprocal, inverse-only, linked and embedded references', () => {
    const Tag = new GraphQLObjectType({ name: 'Tag', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Address = new GraphQLObjectType({ name: 'Address', fields: {
      city: { type: GraphQLString }, tag: { type: Tag, extensions: relation('tag_id') },
    } });
    const Parent = new GraphQLObjectType({ name: 'Parent', fields: () => ({
      id: { type: GraphQLID },
      children: { type: new GraphQLList(Child), extensions: relation('parent_id') },
      notes: { type: new GraphQLList(Note), extensions: relation('parent_id') },
      addresses: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Address))), extensions: relation(undefined, true) },
    }) });
    const Child = new GraphQLObjectType({ name: 'Child', fields: () => ({
      parent: { type: new GraphQLNonNull(Parent), extensions: relation('parent_id') },
      tag: { type: Tag, extensions: relation() },
      ranks: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)), extensions: { readOnly: true } },
    }) });
    const Note = new GraphQLObjectType({ name: 'Note', fields: { text: { type: GraphQLString } } });
    const { entities } = describeModels([{ gqltype: Parent }, { gqltype: Tag, endpoint: false }, { gqltype: Address, endpoint: false }]);
    expect(entities.map((e) => e.name)).toEqual(['Child', 'Note', 'Parent', 'Tag']);
    const child = entities.find((e) => e.name === 'Child');
    expect(child.fields.filter((f) => f.storageName === 'parent_id')).toEqual([
      expect.objectContaining({ name: 'parent', kind: 'reference', target: 'Parent', required: true }),
    ]);
    expect(child.fields.find((f) => f.name === 'tag')).toMatchObject({ storageName: 'tag', target: 'Tag' });
    expect(child.fields.find((f) => f.name === 'ranks')).toMatchObject({ scalar: 'Int', list: true, itemRequired: true, required: false, readOnly: true });
    expect(entities.find((e) => e.name === 'Note').fields).toContainEqual(expect.objectContaining({ storageName: 'parent_id', target: 'Parent', private: true }));
    expect(entities.find((e) => e.name === 'Parent').fields.find((f) => f.name === 'addresses')).toMatchObject({ kind: 'embedded', required: true, list: true, itemRequired: true, fields: expect.arrayContaining([expect.objectContaining({ target: 'Tag' })]) });
  });

  it('does not guess targets for scalar IDs and retains declarative indexes', () => {
    const Entry = new GraphQLObjectType({ name: 'Entry', extensions: { indexes: [{ fields: ['tenant', 'code'], unique: true }] }, fields: {
      tenant: { type: GraphQLID }, code: { type: GraphQLString, extensions: { unique: true } },
    } });
    const [entry] = describeModels([{ gqltype: Entry }]).entities;
    expect(entry.fields[0]).toMatchObject({ kind: 'scalar', scalar: 'ID' });
    expect(entry.indexes).toEqual([{ fields: ['tenant', 'code'], unique: true }]);
  });

  it('rejects conflicting inverse targets and storage collisions', () => {
    const Other = new GraphQLObjectType({ name: 'Other', fields: { name: { type: GraphQLString } } });
    const Child = new GraphQLObjectType({ name: 'Child', fields: { parent: { type: Other, extensions: relation('parent_id') } } });
    const Parent = new GraphQLObjectType({ name: 'Parent', fields: { children: { type: new GraphQLList(Child), extensions: relation('parent_id') } } });
    expect(() => describeModels([{ gqltype: Parent }])).toThrow(/conflict/i);
    const Collision = new GraphQLObjectType({ name: 'Collision', fields: {
      other_id: { type: GraphQLString }, other: { type: Other, extensions: relation('other_id') },
    } });
    expect(() => describeModels([{ gqltype: Collision }])).toThrow(/collision/i);
  });

  it('rejects embedded cycles, ambiguous collections and unannotated objects', () => {
    const Loop = new GraphQLObjectType({ name: 'Loop', fields: () => ({ loop: { type: Loop, extensions: relation(undefined, true) } }) });
    expect(() => describeModels([{ gqltype: Loop }])).toThrow(/embedded cycle/i);
    const Leaf = new GraphQLObjectType({ name: 'Leaf', fields: { value: { type: GraphQLString } } });
    const Bad = new GraphQLObjectType({ name: 'Bad', fields: { leaves: { type: new GraphQLList(Leaf), extensions: relation() } } });
    expect(() => describeModels([{ gqltype: Bad }])).toThrow(/connectionField/);
    const Missing = new GraphQLObjectType({ name: 'Missing', fields: { leaf: { type: Leaf } } });
    expect(() => describeModels([{ gqltype: Missing }])).toThrow(/extensions.relation/);
  });

  it('rejects implicit many-to-many collections instead of inventing opposite foreign keys', () => {
    const User = new GraphQLObjectType({ name: 'User', fields: () => ({ groups: { type: new GraphQLList(Group), extensions: relation('users') } }) });
    const Group = new GraphQLObjectType({ name: 'Group', fields: () => ({ users: { type: new GraphQLList(User), extensions: relation('groups') } }) });
    expect(() => describeModels([{ gqltype: User }])).toThrow(/link entity/i);
  });

  it('rejects enum internal values that collide in text storage', () => {
    const State = new GraphQLEnumType({ name: 'CollisionState', values: { NUMBER: { value: 1 }, STRING: { value: '1' } } });
    const Entry = new GraphQLObjectType({ name: 'EnumEntry', fields: { state: { type: State } } });
    expect(() => describeModels([{ gqltype: Entry }])).toThrow(/enum.*collision/i);
  });
});

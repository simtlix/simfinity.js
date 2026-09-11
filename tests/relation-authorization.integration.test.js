import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import { graphql } from 'graphql';
import * as simfinity from '../src/index.js';
import { createRelationFixture } from './fixtures/relation-authorization.js';

const mongoUri = process.env.SIMFINITY_TEST_MONGODB_URI;

describe.skipIf(!mongoUri)('Relation authorization with MongoDB transactions', () => {
  let schema;
  let Parent;
  let Child;
  let StringParent;
  let StringChild;
  const parentA = new mongoose.Types.ObjectId('507f1f77bcf86cd799439021');
  const parentB = new mongoose.Types.ObjectId('507f1f77bcf86cd799439022');
  const childA = new mongoose.Types.ObjectId('507f1f77bcf86cd799439031');
  const childB = new mongoose.Types.ObjectId('507f1f77bcf86cd799439032');
  const childForeign = new mongoose.Types.ObjectId('507f1f77bcf86cd799439033');
  const missing = new mongoose.Types.ObjectId('507f1f77bcf86cd799439099');
  const execute = (source, context = {}) => graphql({
    schema, source, contextValue: { tenant: 'A', ...context },
  });
  const update = (children, context) => execute(`mutation {
    updaterelationdbparent(input: {id: "${parentA}", name: "Changed parent", children: {${children}}}) {id}
  }`, context);
  const snapshot = async () => JSON.stringify({
    parents: await Parent.find().sort({ _id: 1 }).lean(),
    children: await Child.find().sort({ _id: 1 }).lean(),
  });

  beforeAll(async () => {
    simfinity.preventCreatingCollection(true);
    await mongoose.connect(mongoUri);
    const fixture = createRelationFixture('RelationDB');
    Parent = mongoose.model(fixture.parent.name);
    Child = mongoose.model(fixture.child.name);
    const stringFixture = createRelationFixture('RelationString', true, 'parent');
    schema = stringFixture.schema;
    StringParent = mongoose.model(stringFixture.parent.name);
    StringChild = mongoose.model(stringFixture.child.name);
    await Promise.all([Parent, Child, StringParent, StringChild].map((model) => model.createCollection()));
  });
  beforeEach(async () => {
    await Promise.all([Parent, Child, StringParent, StringChild].map((model) => model.deleteMany({})));
    await Parent.create([
      { _id: parentA, name: 'Parent A', child_id: childB },
      { _id: parentB, name: 'Parent B' },
    ]);
    await Child.create([
      { _id: childA, name: 'Visible child', tenant: 'A', parent_id: parentA },
      { _id: childB, name: 'Private child', tenant: 'B', parent_id: parentA },
      { _id: childForeign, name: 'Foreign child', tenant: 'A', parent_id: parentB },
    ]);
  });
  afterAll(async () => {
    await Promise.all([Parent, Child, StringParent, StringChild].map((model) => model.deleteMany({})));
    await mongoose.disconnect();
  });

  test('nested single and list reads enforce the same target tenant scopes as direct reads', async () => {
    const result = await execute(`{
      relationdbchild(id: "${childB}") {name}
      relationdbchildren {name}
      relationdbparent(id: "${parentA}") {child {name} children {name}}
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.relationdbchild).toBeNull();
    expect(result.data.relationdbchildren.map((child) => child.name).sort()).toEqual(['Foreign child', 'Visible child']);
    expect(result.data.relationdbparent).toEqual({ child: null, children: [{ name: 'Visible child' }] });
  });

  test('preserves custom string IDs and an aliased parent field on supplied Mongoose models', async () => {
    await StringParent.create({ _id: 'parent-one', child_id: 'child-one' });
    await StringChild.create({ _id: 'child-one', name: 'String child', parent_id: 'parent-one' });
    const result = await execute('{relationstringparent(id: "parent-one") {child {name} children {name}}}');
    expect(result.errors).toBeUndefined();
    expect(result.data.relationstringparent).toEqual({
      child: { name: 'String child' }, children: [{ name: 'String child' }],
    });
  });

  test('does not ignore a middleware ID restriction when the related type has no scope', async () => {
    await StringParent.create({ _id: 'parent-one', child_id: 'private-child' });
    await StringChild.create([
      { _id: 'private-child', name: 'Private child', parent_id: 'parent-one' },
      { _id: 'allowed-child', name: 'Allowed child', parent_id: 'parent-one' },
    ]);
    const result = await execute('{relationstringparent(id: "parent-one") {child {name}}}', {
      redirectReadId: 'allowed-child',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data.relationstringparent.child).toBeNull();
  });

  test('isolates concurrent request contexts and applies scope before pagination', async () => {
    const query = `{relationdbparent(id: "${parentA}") {child {name}
      children(sort: {terms: [{field: "name", order: ASC}]}, pagination: {page: 1, size: 1}) {name}}}`;
    const [tenantA, tenantB] = await Promise.all([execute(query), execute(query, { tenant: 'B' })]);
    expect(tenantA.errors).toBeUndefined();
    expect(tenantB.errors).toBeUndefined();
    expect(tenantA.data.relationdbparent).toEqual({ child: null, children: [{ name: 'Visible child' }] });
    expect(tenantB.data.relationdbparent).toEqual({ child: { name: 'Private child' }, children: [{ name: 'Private child' }] });
  });

  test('keeps the parent constraint when scope or OR filters request a different parent', async () => {
    const result = await execute(`{relationdbparent(id: "${parentA}") {
      children(OR: [{conditions: [{field: "name", value: "Foreign child"}]}]) {name}
    }}`, { redirectParent: `${parentB}` });
    expect(result.errors).toBeUndefined();
    expect(result.data.relationdbparent.children).toEqual([]);
  });

  test('keeps the referenced child ID when scope rewrites its ID filter', async () => {
    const result = await execute(`{relationdbparent(id: "${parentA}") {child {name}}}`, {
      redirectScopeId: `${childA}`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data.relationdbparent.child).toBeNull();
  });

  test('keeps a custom relation resolver and a missing reference working', async () => {
    const result = await execute(`{relationdbparent(id: "${parentB}") {child {name} customChild {name}}}`, {
      customName: 'Custom child', rejectOperation: 'get_by_id',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data.relationdbparent).toEqual({ child: null, customChild: { name: 'Custom child' } });
  });

  test('allows legitimate child creation, update and deletion using root operation argument shapes', async () => {
    const calls = [];
    const result = await update(`added: [{name: "New child", tenant: "A"}]
      updated: [{id: "${childA}", name: "Updated child"}] deleted: ["${childB}"]`, { calls });
    expect(result.errors).toBeUndefined();
    expect(await Child.findById(childA).lean()).toMatchObject({ name: 'Updated child', parent_id: parentA });
    expect(await Child.findById(childB)).toBeNull();
    expect(await Child.findOne({ name: 'New child' }).lean()).toMatchObject({ parent_id: parentA });
    expect(calls).toEqual([
      { operation: 'save', args: { input: { name: 'New child', tenant: 'A' } } },
      { operation: 'update', args: { input: { id: `${childA}`, name: 'Updated child' } } },
      { operation: 'delete', args: { id: `${childB}` } },
    ]);
  });

  test.each(['updated', 'deleted'])('rejects wrong-parent IDs in %s without committed changes', async (operation) => {
    const before = await snapshot();
    const item = operation === 'updated' ? `{id: "${childForeign}", name: "Stolen"}` : `"${childForeign}"`;
    const result = await update(`${operation}: [${item}]`);
    expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
  });

  test.each(['updated', 'deleted'])('rejects missing IDs in %s without committed changes', async (operation) => {
    const before = await snapshot();
    const item = operation === 'updated' ? `{id: "${missing}", name: "Missing"}` : `"${missing}"`;
    const result = await update(`${operation}: [${item}]`);
    expect(result.errors?.[0].extensions.code).toBe('NOT_VALID_ID');
    expect(await snapshot()).toBe(before);
  });

  test.each([
    ['save', 'added: [{name: "Blocked child", tenant: "A"}]'],
    ['update', `updated: [{id: "${childA}", name: "Blocked child"}]`],
    ['delete', `deleted: ["${childA}"]`],
  ])('enforces async child %s middleware before committing changes', async (operation, input) => {
    const before = await snapshot();
    const result = await update(input, { rejectOperation: operation });
    expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
  });

  test.each(['updated', 'deleted'])('rechecks ownership after middleware changes the %s ID', async (operation) => {
    const before = await snapshot();
    const item = operation === 'updated' ? `{id: "${childA}", name: "Stolen"}` : `"${childA}"`;
    const result = await update(`${operation}: [${item}]`, { redirectMutationId: `${childForeign}` });
    expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
  });

  test('rolls back previously added and updated children when a later deletion is forbidden', async () => {
    const before = await snapshot();
    const result = await update(`added: [{name: "Rolled back child", tenant: "A"}]
      updated: [{id: "${childA}", name: "Rolled back update"}] deleted: ["${childForeign}"]`);
    expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
  });

  test('preserves the required parent when child lifecycle hooks change it', async () => {
    const result = await update(`added: [{name: "New child", tenant: "A"}]
      updated: [{id: "${childA}", name: "Updated child"}]`, { hookParent: parentB });
    expect(result.errors).toBeUndefined();
    expect(await Child.findById(childA).lean()).toMatchObject({ parent_id: parentA });
    expect(await Child.findOne({ name: 'New child' }).lean()).toMatchObject({ parent_id: parentA });
  });

  test.each([
    { hookUnsetParent: true },
    { hookSetParent: parentB },
  ])('preserves the parent against conflicting child update operators: %j', async (context) => {
    const result = await update(`updated: [{id: "${childA}", name: "Updated child"}]`, context);
    expect(result.errors).toBeUndefined();
    expect(await Child.findById(childA).lean()).toMatchObject({ name: 'Updated child', parent_id: parentA });
  });

  test('rechecks ownership after a concurrent reparent causes a transaction retry', async () => {
    let moved = false;
    const result = await update(`updated: [{id: "${childA}", name: "Blocked update"}]`, {
      beforeChildUpdate: async () => {
        if (!moved) {
          moved = true;
          await Child.updateOne({ _id: childA }, { parent_id: parentB });
        }
      },
    });
    expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(await Child.findById(childA).lean()).toMatchObject({ name: 'Visible child', parent_id: parentB });
    expect(await Parent.findById(parentA).lean()).toMatchObject({ name: 'Parent A' });
  });

  test('rejects child creation middleware during parent creation without leaving a parent', async () => {
    const before = await snapshot();
    const result = await execute(`mutation {addrelationdbparent(input: {name: "Blocked parent",
      children: {added: [{name: "Blocked child", tenant: "A"}]}}) {id}}`, { rejectOperation: 'save' });
    expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
  });
});

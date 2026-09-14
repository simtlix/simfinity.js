import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import { graphql, validateSchema } from 'graphql';
import mongoose from 'mongoose';
import * as simfinity from '../packages/mongodb/src/index.js';
import { buildMaterializationTypes, parentInput } from './fixtures/materialization-types.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;

describe.skipIf(!uri)('Materialization against MongoDB (dedicated test collections)', () => {
  let schema;
  let parentModel;
  let childModel;
  const selection = `id title tags strictTags nullableTags nonNullItems statuses scores ids dates
    detail { text } embedded { text } strictEmbedded { text }
    optionalEmbedded { text } optionalStrictEmbedded { text } children { id text }
    requiredNullableChildren { text }`;
  const run = (action, input, fields = selection) => graphql({
    schema,
    source: `mutation($input: MaterialParentInput${action === 'update' ? 'ForUpdate' : ''}!) {
      ${action}materialparent(input: $input) { ${fields} }
    }`,
    variableValues: { input },
  });
  const create = async (input = parentInput()) => {
    const result = await run('add', input);
    expect(result.errors).toBeUndefined();
    return result.data.addmaterialparent;
  };

  beforeAll(async () => {
    const types = buildMaterializationTypes();
    schema = types.schema;
    expect(validateSchema(schema)).toEqual([]);
    parentModel = simfinity.getModel(types.Parent);
    childModel = simfinity.getModel(types.Child);
    await mongoose.connect(uri);
    await parentModel.createCollection();
    await childModel.createCollection();
  });

  beforeEach(async () => {
    await parentModel.deleteMany({});
    await childModel.deleteMany({});
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await parentModel.collection.drop();
      await childModel.collection.drop();
      await mongoose.disconnect();
    }
  });

  test('returns and persists scalar, enum, custom scalar and embedded list values, including empty strings and null items', async () => {
    const added = await create();
    expect(added).toMatchObject({ ...parentInput(), children: [{ text: '' }], requiredNullableChildren: [] });
    const stored = await parentModel.collection.findOne({ _id: new mongoose.Types.ObjectId(added.id) });
    expect(stored).toMatchObject({
      title: '', tags: ['', null, 'tag'], statuses: ['OPEN'], scores: [0, 2],
      embedded: [null, { text: '' }], strictEmbedded: [{ text: 'strict' }],
    });
    expect(stored.ids[0]).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(stored.dates[0]).toBeInstanceOf(Date);
    const child = await childModel.collection.findOne({ parent: stored._id });
    expect(child.text).toBe('');
    expect(child.parent.toString()).toBe(added.id);
  });

  test('updates and clears lists while leaving omitted fields intact', async () => {
    const added = await create();
    const result = await run('update', {
      id: added.id, title: 'changed', tags: [], strictTags: [''], statuses: ['CLOSED'], scores: [0],
      ids: [], dates: [], embedded: [], strictEmbedded: [{ text: '' }], optionalEmbedded: null,
      children: { updated: [{ id: added.children[0].id, text: 'updated' }], added: [{ text: 'added' }] },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data.updatematerialparent).toMatchObject({
      title: 'changed', tags: [], strictTags: [''], statuses: ['CLOSED'], scores: [0], ids: [], dates: [],
      embedded: [], strictEmbedded: [{ text: '' }], nullableTags: [null, 'nullable'],
    });
    const stored = await parentModel.collection.findOne({ _id: new mongoose.Types.ObjectId(added.id) });
    expect(stored).not.toHaveProperty('optionalEmbedded');
    expect(stored.tags).toEqual([]);
    expect(stored.nullableTags).toEqual([null, 'nullable']);
    expect((await childModel.find({ parent: stored._id }).lean()).map((child) => child.text).sort()).toEqual(['added', 'updated']);
    const deleted = await run('update', { id: added.id, children: { deleted: [added.children[0].id] } });
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.updatematerialparent.children).toHaveLength(1);
  });

  test('rejects missing required create lists and null items in non-null item positions before writing', async () => {
    const input = parentInput();
    delete input.tags;
    for (const invalid of [input, { ...parentInput(), strictTags: [null] }, { ...parentInput(), strictEmbedded: [null] }, { ...parentInput(), children: { added: [null] } }, { ...parentInput(), scores: [-1] }]) {
      const result = await run('add', invalid);
      expect(result.errors?.length).toBeGreaterThan(0);
    }
    expect(await parentModel.countDocuments()).toBe(0);
    expect(await childModel.countDocuments()).toBe(0);
  });

  test('allows omitted required update fields and preserves their values on explicit null', async () => {
    const added = await create();
    const result = await run('update', { id: added.id, tags: null, strictEmbedded: null, detail: null });
    expect(result.errors).toBeUndefined();
    expect(result.data.updatematerialparent.tags).toEqual(added.tags);
    expect(result.data.updatematerialparent.strictEmbedded).toEqual(added.strictEmbedded);
    const stored = await parentModel.findById(added.id).lean();
    expect(stored.tags).toEqual(added.tags);
  });

  test('handles nullable collection operation items and queries required scalar and relation lists', async () => {
    const added = await create({
      ...parentInput(), nullableChildren: { added: [null, { text: 'nullable' }] },
      requiredNullableChildren: { added: [null, { text: 'required nullable' }] },
      strictChildren: { added: [{ text: 'strict' }] },
    });
    const result = await graphql({
      schema,
      source: '{ materialparents(tags: { operator: EQ, value: "tag" }, children: { terms: [{ path: "text", operator: EQ, value: "" }] }) { id children { text } nullableChildren { text } strictChildren { text } requiredNullableChildren { text } } }',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data.materialparents).toHaveLength(1);
    expect(result.data.materialparents[0].id).toBe(added.id);
    expect(result.data.materialparents[0].children.map((child) => child.text)).toEqual(['']);
    expect(result.data.materialparents[0].nullableChildren.map((child) => child.text)).toEqual(['nullable']);
    expect(result.data.materialparents[0].strictChildren.map((child) => child.text)).toEqual(['strict']);
    expect(result.data.materialparents[0].requiredNullableChildren.map((child) => child.text)).toEqual(['required nullable']);
  });

  test('persists default and renamed references, updates them, then unsets every stored field on explicit null', async () => {
    const first = await childModel.create({ text: 'first' });
    const second = await childModel.create({ text: 'second' });
    const ref = { id: first._id.toString() };
    const result = await run('add', { ...parentInput(), owner: ref, editor: ref, reviewer: ref }, 'id title owner { text } editor { text } reviewer { text }');
    expect(result.errors).toBeUndefined();
    const added = result.data.addmaterialparent;
    expect(added.owner.text).toBe('first');
    expect(added.editor.text).toBe('first');
    const stored = await parentModel.collection.findOne({ _id: new mongoose.Types.ObjectId(added.id) });
    for (const field of ['owner', 'editorId', 'reviewerId']) expect(stored[field].toString()).toBe(first._id.toString());
    expect(stored).not.toHaveProperty('undefined');
    const updated = await run('update', { id: added.id, owner: { id: second._id.toString() }, editor: { id: second._id.toString() } }, 'owner { text } editor { text }');
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updatematerialparent).toMatchObject({ owner: { text: 'second' }, editor: { text: 'second' } });
    const updatedStored = await parentModel.collection.findOne({ _id: stored._id });
    expect(updatedStored.owner.toString()).toBe(second._id.toString());
    expect(updatedStored.editorId.toString()).toBe(second._id.toString());
    const cleared = await run('update', { id: added.id, title: null, owner: null, editor: null, reviewer: null }, 'title owner { text } editor { text } reviewer { text }');
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data.updatematerialparent).toEqual({ title: null, owner: null, editor: null, reviewer: null });
    const clearedStored = await parentModel.collection.findOne({ _id: stored._id });
    for (const field of ['title', 'owner', 'editorId', 'reviewerId']) expect(clearedStored).not.toHaveProperty(field);
  });
});

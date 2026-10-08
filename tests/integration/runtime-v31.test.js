import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  graphql, GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { auth, createRuntime, SimfinityError } from '../../packages/core/src/index.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createRelationFixture } from '../fixtures/relation-authorization.js';

for (const backend of ['mongo', 'postgres']) {
  const uri = process.env[backend === 'mongo' ? 'SIMFINITY_MONGODB_URI' : 'SIMFINITY_POSTGRES_URI'];
  describe.skipIf(!uri)(`${backend} v3.1 runtime contract`, () => {
    const namespace = `runtime31_${randomUUID().replaceAll('-', '')}`;
    let api; let pool; let fixture; let Parent; let Child; let a; let b; let visible; let hidden; let foreign;
    const execute = (source, context = {}) => graphql({ schema: fixture.schema, source, contextValue: { tenant: 'A', ...context } });
    const read = (context = {}, fields = 'child {name} children {name}') => execute(`{v31parent(id:"${a._id}"){${fields}}}`, context);
    const update = (items, context) => execute(`mutation {updatev31parent(input:{id:"${a._id}",name:"Changed",children:{${items}}}){id}}`, context);
    // Parent A's ID in uppercase: an ObjectId hex string or UUID spelling the backend accepts but does not store.
    const upperA = () => String(a._id).toUpperCase();
    const updateAs = (id, items) => execute(`mutation {updatev31parent(input:{id:"${id}",name:"Changed",children:{${items}}}){id}}`);
    const get = async (model, id) => backend === 'mongo' ? model.findById(id).lean() : model.findById(id);
    const create = (model, data) => model.create(data);
    beforeAll(async () => {
      if (backend === 'mongo') {
        await mongoose.connect(uri, { dbName: namespace });
        api = createRuntime(createMongoAdapter());
        api.preventCreatingCollection(true);
      } else {
        pool = new pg.Pool({ connectionString: uri });
        api = createPostgres({ pool, schema: namespace });
      }
      fixture = createRelationFixture('V31', false, 'parent', { ...api, SimfinityError }, 'custom_child_id');
      Parent = api.getModel(fixture.parent); Child = api.getModel(fixture.child);
      if (backend === 'mongo') await Promise.all([Parent.createCollection(), Child.createCollection()]);
      else await api.initializeDatabase();
    });
    beforeEach(async () => {
      api.configureQueryLimits();
      if (backend === 'mongo') { await Parent.deleteMany({}); await Child.deleteMany({}); }
      else await pool.query(`TRUNCATE "${namespace}"."V31Parent", "${namespace}"."V31Child" CASCADE`);
      a = await create(Parent, { name: 'Parent A' }); b = await create(Parent, { name: 'Parent B' });
      visible = await create(Child, { name: 'Visible', tenant: 'A', parent_id: a._id });
      hidden = await create(Child, { name: 'Hidden', tenant: 'B', parent_id: a._id });
      foreign = await create(Child, { name: 'Foreign', tenant: 'A', parent_id: b._id });
      if (backend === 'mongo') await Parent.findByIdAndUpdate(a._id, { child_id: hidden._id });
      else await Parent.update(a._id, { child_id: hidden._id });
    });
    afterAll(async () => {
      api?.configureQueryLimits();
      if (backend === 'mongo') { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); mongoose.deleteModel(/^V31/); }
      else if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
    });
    test('scopes nested reads and keeps concurrent contexts isolated', async () => {
      const [first, second] = await Promise.all([read(), read({ tenant: 'B' })]);
      expect(first.errors).toBeUndefined(); expect(second.errors).toBeUndefined();
      expect(first.data.v31parent).toEqual({ child: null, children: [{ name: 'Visible' }] });
      expect(second.data.v31parent).toEqual({ child: { name: 'Hidden' }, children: [{ name: 'Hidden' }] });
    });
    test('keeps required relation identities outside mutable scope filters', async () => {
      const result = await read({ redirectScopeId: String(visible._id), redirectParent: String(b._id) });
      expect(result.errors).toBeUndefined();
      expect(result.data.v31parent).toEqual({ child: null, children: [] });
    });
    test('keeps required relation identity when middleware redirects an unscoped read', async () => {
      const scope = fixture.child.extensions.scope;
      fixture.child.extensions.scope = {};
      try {
        const result = await read({ redirectReadId: String(visible._id) }, 'child {name}');
        expect(result.errors).toBeUndefined(); expect(result.data.v31parent.child).toBeNull();
      } finally { fixture.child.extensions.scope = scope; }
    });
    test.each(['updated', 'deleted'])('checks %s ownership after middleware chooses an effective ID', async (operation) => {
      const item = operation === 'updated' ? `{id:"${visible._id}",name:"Stolen"}` : `"${visible._id}"`;
      const result = await update(`${operation}:[${item}]`, { redirectMutationId: String(foreign._id) });
      expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
      expect(result.errors[0].message).toBe('Child does not belong to this parent');
      expect(result.errors[0].originalError).toBeInstanceOf(auth.ForbiddenError);
      expect((await get(Parent, a._id)).name).toBe('Parent A');
      expect((await get(Child, foreign._id)).name).toBe('Foreign');
    });
    test.each(['updated', 'deleted'])('accepts %s for its own children when the parent ID is sent in another case', async (operation) => {
      const item = operation === 'updated' ? `{id:"${visible._id}",name:"Renamed"}` : `"${visible._id}"`;
      const result = await updateAs(upperA(), `${operation}:[${item}]`);
      expect(result.errors).toBeUndefined();
      expect((await get(Parent, a._id)).name).toBe('Changed');
      const child = await get(Child, visible._id);
      if (operation === 'deleted') {
        expect(child).toBeNull();
      } else {
        expect(child.name).toBe('Renamed');
        expect(String(child.parent_id)).toBe(String(a._id));
      }
    });
    test('keeps foreign children FORBIDDEN when the parent ID is sent in another case', async () => {
      for (const items of [`deleted:["${foreign._id}"]`, `updated:[{id:"${foreign._id}",name:"Stolen"}]`]) {
        const result = await updateAs(upperA(), items);
        expect(result.errors?.[0].extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
        expect((await get(Parent, a._id)).name).toBe('Parent A');
        const child = await get(Child, foreign._id);
        expect(child.name).toBe('Foreign');
        expect(String(child.parent_id)).toBe(String(b._id));
      }
    });
    test('lists children added with a parent ID sent in another case', async () => {
      const result = await updateAs(upperA(), 'added:[{name:"New",tenant:"A"}]');
      expect(result.errors).toBeUndefined();
      const children = await read();
      expect(children.errors).toBeUndefined();
      expect(children.data.v31parent.children.map((child) => child.name).sort()).toEqual(['New', 'Visible']);
    });
    // A supplied child model whose link path is a String does not cast the parent ID, so the stored
    // link is whatever the runtime writes.
    if (backend === 'mongo') describe('with a supplied child model that stores the parent link as a String', () => {
      let schema; let StrParent; let StrChild; let parent;
      // The parent link each child onSaving hook receives.
      const savingLinks = [];
      const run = (source) => graphql({ schema, source, contextValue: {} });
      const upperParent = () => String(parent._id).toUpperCase();
      const childNames = async () => {
        const result = await run(`{v31strparent(id:"${parent._id}"){children{name}}}`);
        expect(result.errors).toBeUndefined();
        return result.data.v31strparent.children.map((child) => child.name).sort();
      };
      beforeAll(async () => {
        const strApi = createRuntime(createMongoAdapter());
        strApi.preventCreatingCollection(true);
        const childType = new GraphQLObjectType({
          name: 'V31StrChild',
          fields: () => ({
            id: { type: GraphQLID },
            name: { type: GraphQLString },
            parent: { type: parentType, extensions: { relation: { connectionField: 'parent_id' } } },
          }),
        });
        const parentType = new GraphQLObjectType({
          name: 'V31StrParent',
          fields: () => ({
            id: { type: GraphQLID },
            name: { type: GraphQLString },
            children: { type: new GraphQLList(childType), extensions: { relation: { connectionField: 'parent_id' } } },
          }),
        });
        const childModel = mongoose.model('V31StrChild', new mongoose.Schema({ name: String, parent_id: String }));
        strApi.connect(childModel, childType, 'v31strchild', 'v31strchildren', {
          onSaving: (record) => { savingLinks.push(record.parent_id); },
        });
        strApi.connect(null, parentType, 'v31strparent', 'v31strparents');
        schema = strApi.createSchema();
        StrParent = strApi.getModel(parentType); StrChild = strApi.getModel(childType);
        await Promise.all([StrParent.createCollection(), StrChild.createCollection()]);
      });
      beforeEach(async () => {
        await StrParent.deleteMany({}); await StrChild.deleteMany({});
        parent = await StrParent.create({ name: 'P' });
        savingLinks.length = 0;
      });
      test('stores the parent key for children added with an uppercase parent ID', async () => {
        const result = await run(`mutation {updatev31strparent(input:{id:"${upperParent()}",children:{added:[{name:"New"}]}}){id}}`);
        expect(result.errors).toBeUndefined();
        const [child] = await StrChild.find({ name: 'New' }).lean();
        expect(child.parent_id).toBe(String(parent._id));
        expect(await childNames()).toEqual(['New']);
        // onSaving receives the Mongoose document, whose String path holds the parent's lowercase hex.
        expect(savingLinks).toEqual([String(parent._id)]);
      });
      test.each(['updated', 'deleted'])('accepts %s for a listed child with an uppercase parent ID', async (operation) => {
        const child = await StrChild.create({ name: 'Own', parent_id: String(parent._id) });
        const item = operation === 'updated' ? `{id:"${child._id}",name:"Renamed"}` : `"${child._id}"`;
        const result = await run(`mutation {updatev31strparent(input:{id:"${upperParent()}",children:{${operation}:[${item}]}}){id}}`);
        expect(result.errors).toBeUndefined();
        const stored = await StrChild.findById(child._id).lean();
        if (operation === 'deleted') {
          expect(stored).toBeNull();
        } else {
          expect(stored).toMatchObject({ name: 'Renamed', parent_id: String(parent._id) });
        }
      });
      test('owns a child stored with another spelling of the parent ID only once its link is canonical', async () => {
        // Such links were written by earlier versions for updates sent with an uppercase parent ID.
        const legacy = await StrChild.create({ name: 'Legacy', parent_id: upperParent() });
        const remove = () => run(`mutation {updatev31strparent(input:{id:"${upperParent()}",children:{deleted:["${legacy._id}"]}}){id}}`);
        const denied = await remove();
        expect(denied.errors?.[0].extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
        expect(await childNames()).toEqual([]);
        // The remediation documented in the upgrade notes.
        await StrChild.collection.updateMany({ parent_id: { $regex: '[A-F]' } }, [{ $set: { parent_id: { $toLower: '$parent_id' } } }]);
        expect(await childNames()).toEqual(['Legacy']);
        const removed = await remove();
        expect(removed.errors).toBeUndefined();
        expect(await StrChild.findById(legacy._id).lean()).toBeNull();
      });
    });
    test.each(['save', 'update', 'delete'])('awaits child %s middleware and rolls back parent writes', async (operation) => {
      const inputs = { save: 'added:[{name:"Blocked",tenant:"A"}]', update: `updated:[{id:"${visible._id}",name:"Blocked"}]`, delete: `deleted:["${visible._id}"]` };
      const calls = [];
      const result = await update(inputs[operation], { calls, rejectOperation: operation });
      expect(result.errors?.[0].extensions.code).toBe('FORBIDDEN');
      expect(calls[0].operation).toBe(operation);
      expect(calls[0].args).toHaveProperty(operation === 'delete' ? 'id' : 'input');
      expect((await get(Parent, a._id)).name).toBe('Parent A');
      expect((await get(Child, visible._id)).name).toBe('Visible');
    });
    test('reapplies parent ownership after child hooks', async () => {
      const result = await update(`added:[{name:"New",tenant:"A"}],updated:[{id:"${visible._id}",name:"Updated"}]`, { hookParent: b._id, hookSetParent: b._id });
      expect(result.errors).toBeUndefined();
      expect(String((await get(Child, visible._id)).parent_id)).toBe(String(a._id));
      const children = await read();
      expect(children.errors).toBeUndefined();
      expect(children.data.v31parent.children.map((child) => child.name).sort()).toEqual(['New', 'Updated']);
    });
    test('preserves empty strings in standalone saves and updates', async () => {
      const saved = await api.saveObject(fixture.child.name, { name: '', tenant: 'A', parent: { id: String(a._id) } }, undefined, {});
      expect((await get(Child, saved._id)).name).toBe('');
      const result = await update(`updated:[{id:"${visible._id}",name:""}]`, {});
      expect(result.errors).toBeUndefined(); expect((await get(Child, visible._id)).name).toBe('');
    });
    test('rolls back the entire standalone save workflow on child middleware failure', async () => {
      await expect(api.saveObject(fixture.parent.name, { name: 'Standalone', children: { added: [{ name: 'Blocked', tenant: 'A' }] } }, undefined, { rejectOperation: 'save' }))
        .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      const result = await execute('{v31parents(name:{value:"Standalone"}){id}}');
      expect(result.errors).toBeUndefined(); expect(result.data.v31parents).toEqual([]);
    });
    test('bounds default lists and rejects oversized pages and unsafe sort paths', async () => {
      api.configureQueryLimits({ maxPageSize: 1 });
      const result = await execute('{v31parents{id}}');
      expect(result.errors).toBeUndefined(); expect(result.data.v31parents).toHaveLength(1);
      const oversized = await execute('{v31parents(pagination:{page:1,size:2}){id}}');
      expect(oversized.errors?.[0].extensions.code).toBe('INVALID_PAGINATION');
      for (const path of ['missing', 'name.invalid', 'child']) {
        const sorted = await execute(`{v31parents(sort:{terms:[{field:"${path}",order:ASC}]}){id}}`);
        expect(['INVALID_FILTER_FIELD', 'INVALID_FILTER_PATH']).toContain(sorted.errors?.[0].extensions.code);
      }
    });
  });
}

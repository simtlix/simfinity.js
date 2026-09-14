import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime, SimfinityError } from '../../packages/core/src/index.js';
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
      expect((await get(Parent, a._id)).name).toBe('Parent A');
      expect((await get(Child, foreign._id)).name).toBe('Foreign');
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

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { graphql, printSchema } from 'graphql';
import pg from 'pg';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!uri)('PostgreSQL GraphQL runtime contract', () => {
  let pool; let api; let schema; let fixture;
  const namespace = `runtime_${randomUUID().replaceAll('-', '')}`;
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  const add = (input, context = {}) => execute('mutation($input:ContractSerieInput!){addcontractserie(input:$input){id title tenant label{name} director{name country} categories seasons{id number year} credits{role star{id name}}}}', { input }, context);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace });
    fixture = createContractModelFixtures();
    for (const registration of fixture.registrations) {
      if (registration.endpoint) api.connect(null, registration.gqltype, registration.simpleEntityEndpointName, registration.listEntitiesEndpointName, registration.controller);
      else api.addNoEndpointType(registration.gqltype);
    }
    schema = api.createSchema();
    const beforeReady = await execute('{contractseries{title}}');
    expect(beforeReady.errors?.[0].extensions.code).toBe('DATABASE_NOT_INITIALIZED');
    await api.initializeDatabase();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${api.describeDatabase().tables.map((table) => `"${namespace}"."${table.name}"`).join(', ')} CASCADE`);
    fixture.hookEvents.length = 0;
  });
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it('preserves generated schema names and executes nested CRUD, embedded patches and hooks', async () => {
    expect(printSchema(schema)).toContain('input ContractSerieInputForUpdate');
    const label = await api.getModel(fixture.types.ContractLabel).create({ name: 'Premium' });
    const context = { tenant: 'tenant-a', requestId: 'same-context' };
    const added = await add({ tenant: 'tenant-a', title: 'Original', label: { id: label._id }, director: { name: 'Director', country: 'AR' }, categories: ['Drama', 'Drama'], seasons: { added: [{ number: 1, year: 2026 }] } }, context);
    expect(added.errors).toBeUndefined();
    expect(added.data.addcontractserie).toMatchObject({ title: 'Original', label: { name: 'Premium' }, categories: ['Drama', 'Drama'], director: { name: 'Director', country: 'AR' } });
    const id = added.data.addcontractserie.id;
    const season = added.data.addcontractserie.seasons[0].id;
    const updated = await execute('mutation($input:ContractSerieInputForUpdate!){updatecontractserie(input:$input){id title label{name} director{name country} seasons{id number year}}}', { input: { id, title: 'Updated', label: null, director: { country: 'UY' }, seasons: { updated: [{ id: season, number: 2 }] } } }, context);
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updatecontractserie).toMatchObject({ title: 'Updated', label: null, director: { name: 'Director', country: 'UY' }, seasons: [{ id: season, number: 2, year: 2026 }] });
    const removed = await execute('mutation($input:ContractSerieInputForUpdate!){updatecontractserie(input:$input){seasons{id}}}', { input: { id, seasons: { deleted: [season] } } });
    expect(removed.errors).toBeUndefined();
    expect(removed.data.updatecontractserie.seasons).toEqual([]);
    const deleted = await execute('mutation($id:ID!){deletecontractserie(id:$id){id title}}', { id });
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deletecontractserie.title).toBe('Updated');
    expect(await api.getModel(fixture.types.ContractSerie).findById(id)).toBeNull();
    expect(fixture.hookEvents).toContainEqual(expect.objectContaining({ hook: 'onUpdated', title: 'Updated', context, inTransaction: true }));
  });

  it('enforces scopes outside OR and retains relation multiplicity and pre-pagination count', async () => {
    const first = await add({ tenant: 'a', title: 'Alpha', seasons: { added: [{ number: 1, year: 2030 }, { number: 2, year: 2030 }] } });
    expect(first.errors).toBeUndefined();
    expect((await add({ tenant: 'b', title: 'Alpha' })).errors).toBeUndefined();
    const context = { tenant: 'a' };
    const result = await execute('{contractseries(OR:[{conditions:[{field:"title",value:"Alpha"}]},{conditions:[{field:"title",value:"Beta"}]}],seasons:{terms:[{path:"year",value:2030}]},pagination:{page:1,size:1,count:true}){id tenant}}', undefined, context);
    expect(result.errors).toBeUndefined();
    expect(result.data.contractseries).toEqual([{ id: first.data.addcontractserie.id, tenant: 'a' }]);
    expect(context.count).toBe(2);
    const excluded = await execute('query($id:ID){contractserie(id:$id){id}}', { id: first.data.addcontractserie.id }, { tenant: 'b' });
    expect(excluded.errors).toBeUndefined();
    expect(excluded.data.contractserie).toBeNull();
  });

  it('stores and reassembles embedded reference arrays preserving duplicates and order', async () => {
    const star = await api.getModel(fixture.types.ContractStar).create({ name: 'Lead' });
    const added = await add({ tenant: 'a', title: 'Credits', credits: [{ role: 'First', star: { id: star._id } }, { role: 'Second', star: { id: star._id } }] });
    expect(added.errors).toBeUndefined();
    expect(added.data.addcontractserie.credits).toEqual([{ role: 'First', star: { id: star._id, name: 'Lead' } }, { role: 'Second', star: { id: star._id, name: 'Lead' } }]);
    const id = added.data.addcontractserie.id;
    const replaced = await execute('mutation($input:ContractSerieInputForUpdate!){updatecontractserie(input:$input){credits{role star{name}}}}', { input: { id, credits: [{ role: 'Only', star: { id: star._id } }] } });
    expect(replaced.errors).toBeUndefined();
    expect(replaced.data.updatecontractserie.credits).toEqual([{ role: 'Only', star: { name: 'Lead' } }]);
    const blocked = await execute('mutation($id:ID!){deletecontractstar(id:$id){id}}', { id: star._id });
    expect(blocked.errors?.[0].extensions.code).toBe('REFERENCE_CONSTRAINT_VIOLATION');
    expect((await execute('mutation($id:ID!){deletecontractserie(id:$id){id}}', { id })).errors).toBeUndefined();
    expect(await api.getModel(fixture.types.ContractStar).findById(star._id)).not.toBeNull();
  });

  it('rolls back parent writes on nested validation and FK failure', async () => {
    const invalid = await add({ tenant: 'a', title: 'Invalid', seasons: { added: [{ number: 999 }] } });
    expect(invalid.errors?.[0].message).toContain('Season number 999');
    const dangling = await add({ tenant: 'a', title: 'Dangling', credits: [{ role: 'Bad', star: { id: randomUUID() } }] });
    expect(dangling.errors?.[0].extensions.code).toBe('REFERENCE_CONSTRAINT_VIOLATION');
    expect((await execute('{contractseries{title}}')).data.contractseries).toEqual([]);
  });

  it('keeps each owner and its embeddeds atomic even for standalone saveObject', async () => {
    await expect(api.saveObject(fixture.types.ContractSerie.name, { tenant: 'a', title: 'Standalone', credits: [{ role: 'Bad', star: { id: randomUUID() } }] })).rejects.toMatchObject({ extensions: { code: 'REFERENCE_CONSTRAINT_VIOLATION' } });
    expect(await api.getModel(fixture.types.ContractSerie).find()).toEqual([]);
    expect(fixture.hookEvents.find((event) => event.hook === 'onSaving').session.inTransaction()).toBe(false);
    expect(fixture.hookEvents.find((event) => event.hook === 'onSaving').inTransaction).toBe(true);
  });

  it('retains null embedded items and restores a reference-bearing array after clearing it', async () => {
    const star = await api.getModel(fixture.types.ContractStar).create({ name: 'Nullable' });
    const added = await add({ tenant: 'a', title: 'Nullable credits', credits: [null, { role: 'Present', star: { id: star.id } }, null] });
    expect(added.errors).toBeUndefined();
    const id = added.data.addcontractserie.id;
    expect(added.data.addcontractserie.credits).toEqual([null, { role: 'Present', star: { id: star.id, name: 'Nullable' } }, null]);
    const mutation = 'mutation($input:ContractSerieInputForUpdate!){updatecontractserie(input:$input){credits{role star{name}}}}';
    expect((await execute(mutation, { input: { id, credits: null } })).errors).toBeUndefined();
    const restored = await execute(mutation, { input: { id, credits: [{ role: 'Restored', star: { id: star.id } }] } });
    expect(restored.errors).toBeUndefined();
    expect(restored.data.updatecontractserie.credits).toEqual([{ role: 'Restored', star: { name: 'Nullable' } }]);
  });

  it('executes inverse scalar-ID relations and explicit many-to-many links', async () => {
    const star = await api.getModel(fixture.types.ContractStar).create({ name: 'Link target' });
    const added = await add({ tenant: 'a', title: 'Linked', assignments: { added: [{ star: { id: star.id }, billingOrder: 1 }, { star: { id: star.id }, billingOrder: 2 }] }, notes: { added: [{ text: 'Private inverse' }] } });
    expect(added.errors).toBeUndefined();
    const id = added.data.addcontractserie.id;
    const read = await execute('query($id:ID){contractserie(id:$id){notes{text} assignments(sort:{terms:[{field:"billingOrder",order:ASC}]}){id billingOrder star{name}}}}', { id });
    expect(read.errors).toBeUndefined();
    expect(read.data.contractserie.notes).toEqual([{ text: 'Private inverse' }]);
    expect(read.data.contractserie.assignments.map(({ billingOrder }) => billingOrder)).toEqual([1, 2]);
    const link = read.data.contractserie.assignments[0].id;
    const removed = await execute('mutation($id:ID!){deletecontractassignment(id:$id){billingOrder}}', { id: link });
    expect(removed.errors).toBeUndefined();
    expect(await api.getModel(fixture.types.ContractSerie).findById(id)).not.toBeNull();
    expect(await api.getModel(fixture.types.ContractStar).findById(star.id)).not.toBeNull();
  });

  it('loads an owner and its normalized embeddeds from one snapshot during a concurrent replacement', async () => {
    const star = await api.getModel(fixture.types.ContractStar).create({ name: 'Snapshot' });
    const model = api.getModel(fixture.types.ContractSerie);
    const owner = await model.create({ tenant: 'a', title: 'v1', credits: [{ role: 'v1', star: star.id }] });
    const connect = pool.connect.bind(pool);
    let intercept = true;
    const spy = vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await connect();
      return {
        release: () => client.release(),
        async query(text, values) {
          const result = await client.query(text, values);
          if (intercept && text.startsWith(`SELECT * FROM "${namespace}"."ContractSerie"`)) {
            intercept = false;
            await model.update(owner.id, { title: 'v2', credits: [{ role: 'v2', star: star.id }] });
          }
          return result;
        },
      };
    });
    try {
      const read = await model.findById(owner.id);
      expect(read).toMatchObject({ title: 'v1', credits: [{ role: 'v1' }] });
      expect((await model.findById(owner.id))).toMatchObject({ title: 'v2', credits: [{ role: 'v2' }] });
    } finally { spy.mockRestore(); }
  });
});

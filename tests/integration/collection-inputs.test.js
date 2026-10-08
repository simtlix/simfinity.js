// Nested writes through generated collection inputs on real databases: self-referencing collections
// that share a field name (#43), cycles of writable collections across types (#44) and `deleted`
// IDs of collections with non-null items (#96). Each test builds its own schema, so each fails for
// its own cause on versions without the fix.
import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const ref = (connectionField) => ({
  relation: { embedded: false, ...(connectionField ? { connectionField } : {}) },
});
const treeType = (name) => {
  const T = new GraphQLObjectType({
    name,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      parent: { type: T, extensions: ref('parent') },
      children: { type: new GraphQLList(T), extensions: ref('parent') },
    }),
  });
  return T;
};

const backends = [
  {
    name: 'mongodb',
    prefix: 'Cim',
    uri: process.env.SIMFINITY_MONGODB_URI,
    async open(namespace) {
      await mongoose.connect(this.uri, { dbName: namespace });
    },
    create() {
      const api = createRuntime(createMongoAdapter());
      api.preventCreatingCollection(true);
      return api;
    },
    async initialize(api) {
      for (const { model } of api.getRegistrations()) if (model) await model.createCollection();
    },
    async close() {
      if (mongoose.connection.readyState) {
        await mongoose.connection.db.dropDatabase();
        await mongoose.disconnect();
      }
    },
  },
  {
    name: 'postgres',
    prefix: 'Cip',
    uri: process.env.SIMFINITY_POSTGRES_URI,
    schemas: [],
    async open(namespace) {
      this.namespace = namespace;
      this.pool = new pg.Pool({ connectionString: this.uri });
    },
    create() {
      const schema = `${this.namespace}_${this.schemas.length}`;
      this.schemas.push(schema);
      return createPostgres({ pool: this.pool, schema });
    },
    initialize: (api) => api.initializeDatabase(),
    async close() {
      if (!this.pool) return;
      for (const schema of this.schemas) await this.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await this.pool.end();
    },
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.uri)(`collection inputs on ${backend.name}`, () => {
    const { prefix } = backend;
    const endpoint = (T) => T.name.toLowerCase();
    const build = async (types) => {
      const api = backend.create();
      for (const T of types) api.connect(null, T, endpoint(T), `${endpoint(T)}s`);
      const schema = api.createSchema();
      await backend.initialize(api);
      return (source, variableValues) => graphql({ schema, source, variableValues });
    };
    const ok = async (pending) => {
      const result = await pending;
      expect(result.errors).toBeUndefined();
      return result.data;
    };

    beforeAll(() => backend.open(`collection_inputs_${randomUUID().replaceAll('-', '')}`), 30000);
    afterAll(() => backend.close());

    test('#43 writes trees of two types whose self-referencing collections share a name', async () => {
      const Category = treeType(`${prefix}TreeCategory`);
      const Comment = treeType(`${prefix}TreeComment`);
      const run = await build([Category, Comment]);

      const category = (await ok(run(`mutation { add${endpoint(Category)}(input: { name: "root",
        children: { added: [{ name: "a" }, { name: "b" }] } }) { id children { name parent { id } } } }`)))[`add${endpoint(Category)}`];
      expect(category.children.map((child) => child.name).sort()).toEqual(['a', 'b']);
      expect(category.children.every((child) => child.parent.id === category.id)).toBe(true);

      const comment = (await ok(run(`mutation($children: OneToMany${prefix}TreeCommentAchildren) {
        add${endpoint(Comment)}(input: { name: "c", children: $children }) { id children { id name children { name } } } }`, {
        children: { added: [{ name: 'r1', children: { added: [{ name: 'r11' }] } }, { name: 'r2' }] },
      })))[`add${endpoint(Comment)}`];
      const r1 = comment.children.find((child) => child.name === 'r1');
      expect(r1.children).toEqual([{ name: 'r11' }]);

      const updated = (await ok(run(`mutation($id: ID!, $children: OneToMany${prefix}TreeCommentUchildren) {
        update${endpoint(Comment)}(input: { id: $id, children: $children }) { children { name } } }`, {
        id: comment.id, children: { updated: [{ id: r1.id, name: 'r1b' }] },
      })))[`update${endpoint(Comment)}`];
      expect(updated.children.map((child) => child.name).sort()).toEqual(['r1b', 'r2']);
    });

    test('#43 creates a tree of one type more than one level deep in one add mutation', async () => {
      const Tree = treeType(`${prefix}DepthTree`);
      const run = await build([Tree]);
      const root = (await ok(run(`mutation { add${endpoint(Tree)}(input: { name: "root", children: { added: [
        { name: "a", children: { added: [{ name: "a1", children: { added: [{ name: "a11" }] } }] } }] } }) {
        id children { id name parent { id } children { id name parent { id } children { name parent { id } } } } } }`)))[`add${endpoint(Tree)}`];
      const [a] = root.children;
      const [a1] = a.children;
      expect([a.name, a1.name, a1.children[0].name]).toEqual(['a', 'a1', 'a11']);
      expect(a.parent.id).toBe(root.id);
      expect(a1.parent.id).toBe(a.id);
      expect(a1.children[0].parent.id).toBe(a1.id);
    });

    test('#43 adds children through two collections that share the child connectionField', async () => {
      const Serie = new GraphQLObjectType({
        name: `${prefix}SibSerie`,
        fields: () => ({
          id: { type: GraphQLID },
          title: { type: GraphQLString },
          episodes: { type: new GraphQLList(Episode), extensions: ref('serie') },
          featured: { type: new GraphQLList(Episode), extensions: ref('serie') },
        }),
      });
      const Episode = new GraphQLObjectType({
        name: `${prefix}SibEpisode`,
        fields: () => ({
          id: { type: GraphQLID }, name: { type: GraphQLString }, serie: { type: Serie, extensions: ref('serie') },
        }),
      });
      const run = await build([Serie, Episode]);
      const serie = (await ok(run(`mutation { add${endpoint(Serie)}(input: { title: "s", episodes: { added: [{ name: "e1" }] },
        featured: { added: [{ name: "f1" }] } }) { id episodes { name serie { id } } featured { name } } }`)))[`add${endpoint(Serie)}`];
      // Both collections read every child linked through `serie`.
      expect(serie.episodes.map((episode) => episode.name).sort()).toEqual(['e1', 'f1']);
      expect(serie.featured.map((episode) => episode.name).sort()).toEqual(['e1', 'f1']);
      expect(serie.episodes.every((episode) => episode.serie.id === serie.id)).toBe(true);
    });

    test('#44 writes through a cycle of collections across types', async () => {
      const Department = new GraphQLObjectType({
        name: `${prefix}CycDepartment`,
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          manager: { type: Employee, extensions: ref('manager') },
          employees: { type: new GraphQLList(Employee), extensions: ref('department') },
        }),
      });
      const Employee = new GraphQLObjectType({
        name: `${prefix}CycEmployee`,
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          department: { type: Department, extensions: ref('department') },
          managedDepartments: { type: new GraphQLList(Department), extensions: ref('manager') },
        }),
      });
      const run = await build([Department, Employee]);
      const d1 = (await ok(run(`mutation { add${endpoint(Department)}(input: { name: "D1", employees: { added: [{ name: "E1",
        managedDepartments: { added: [{ name: "D2", employees: { added: [{ name: "E2" }] } }] } }] } }) {
        id employees { id name department { id } managedDepartments { id name manager { id }
        employees { name department { name } } } } } }`)))[`add${endpoint(Department)}`];
      const [e1] = d1.employees;
      const [d2] = e1.managedDepartments;
      expect(e1.department.id).toBe(d1.id);
      expect(d2.manager.id).toBe(e1.id);
      expect(d2.employees).toEqual([{ name: 'E2', department: { name: 'D2' } }]);

      const updated = (await ok(run(`mutation($id: ID!, $d2: ID!) { update${endpoint(Employee)}(input: { id: $id,
        managedDepartments: { updated: [{ id: $d2, name: "D2b", employees: { added: [{ name: "E3" }] } }] } }) {
        managedDepartments { name employees { name } } } }`, { id: e1.id, d2: d2.id })))[`update${endpoint(Employee)}`];
      expect(updated.managedDepartments).toHaveLength(1);
      expect(updated.managedDepartments[0].name).toBe('D2b');
      expect(updated.managedDepartments[0].employees.map((employee) => employee.name).sort()).toEqual(['E2', 'E3']);
    });

    test('#96 deletes children of a collection with non-null items through an [ID] variable with null entries', async () => {
      const Department = new GraphQLObjectType({
        name: `${prefix}DelDepartment`,
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          employees: { type: new GraphQLList(new GraphQLNonNull(Employee)), extensions: ref('department') },
        }),
      });
      const Employee = new GraphQLObjectType({
        name: `${prefix}DelEmployee`,
        fields: () => ({
          id: { type: GraphQLID }, name: { type: GraphQLString }, department: { type: Department, extensions: ref('department') },
        }),
      });
      const run = await build([Department, Employee]);
      const department = (await ok(run(`mutation { add${endpoint(Department)}(input: { name: "D",
        employees: { added: [{ name: "E1" }, { name: "E2" }] } }) { id employees { id name } } }`)))[`add${endpoint(Department)}`];
      const e1 = department.employees.find((employee) => employee.name === 'E1');
      const e2 = department.employees.find((employee) => employee.name === 'E2');

      const updated = (await ok(run(`mutation($id: ID!, $ids: [ID]) { update${endpoint(Department)}(input: { id: $id,
        employees: { deleted: $ids } }) { employees { id name } } }`, { id: department.id, ids: [e2.id, null] })))[`update${endpoint(Department)}`];
      expect(updated.employees).toEqual([{ id: e1.id, name: 'E1' }]);
      const remaining = await ok(run(`{ ${endpoint(Employee)}s { name } }`));
      expect(remaining[`${endpoint(Employee)}s`]).toEqual([{ name: 'E1' }]);
    });
  });
}

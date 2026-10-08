// Generated inputs of referenced collections: self-referencing collections that share a field name
// (#43), cycles of writable collections across types (#44) and `deleted` IDs (#96).
import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString,
  graphql, parse, validate, validateSchema,
} from 'graphql';
import mongoose from 'mongoose';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../packages/postgres/src/index.js';

const createMemoryAdapter = () => {
  const records = new Map();
  let nextId = 1;
  return {
    prepare: vi.fn(),
    createModel: vi.fn((gqltype) => ({ name: gqltype.name })),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    newRecord: (Model, data) => ({ ...data, _id: String(nextId++), Model: Model.name }),
    async saveRecord(Model, record) {
      records.set(record._id, record);
      return record;
    },
    toObject: (record) => ({ ...record }),
    async getById(Model, id) { return records.get(String(id)) || null; },
    prepareUpdate: (set, unset) => ({ set, unset }),
    async update(Model, id, update) {
      const current = records.get(String(id));
      Object.assign(current, update.set);
      return current;
    },
    async delete(Model, id) {
      const record = records.get(String(id));
      records.delete(String(id));
      return record;
    },
    rows: (name) => [...records.values()].filter((record) => record.Model === name),
  };
};

let schemaSeq = 0;
const backends = {
  core: () => createRuntime(createMemoryAdapter()),
  mongodb: () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    return runtime;
  },
  postgres: () => createPostgres({
    pool: { connect: vi.fn(), query: vi.fn() },
    schema: `collection_inputs_${schemaSeq++}`,
  }),
};

const ref = (connectionField) => ({
  relation: { embedded: false, ...(connectionField ? { connectionField } : {}) },
});
const treeType = (name, {
  field = 'children', connection = 'parent', list = (T) => new GraphQLList(T), description,
} = {}) => {
  const T = new GraphQLObjectType({
    name,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      [connection]: { type: T, extensions: ref() },
      [field]: { type: list(T), extensions: ref(connection), description },
    }),
  });
  return T;
};

const endpoint = (T) => T.name.toLowerCase();
const connectAll = (runtime, types) => {
  for (const T of types) runtime.connect(null, T, endpoint(T), `${endpoint(T)}s`);
};
// The MongoDB adapter registers a mongoose model per type name.
const createdTypes = [];
const track = (...types) => {
  createdTypes.push(...types);
  return types;
};
afterEach(() => {
  for (const T of createdTypes.splice(0)) if (mongoose.models[T.name]) mongoose.deleteModel(T.name);
  vi.restoreAllMocks();
});

const fieldOf = (schema, typeName, fieldName) => schema.getType(typeName).getFields()[fieldName];
const fieldType = (schema, typeName, fieldName) => String(fieldOf(schema, typeName, fieldName).type);
const addedItem = (schema, name) => schema.getType(name).getFields().added.type.ofType;
const isValid = (schema, source) => validate(schema, parse(source));

describe.each(Object.keys(backends))('collection inputs on %s', (backend) => {
  const prefix = { core: 'Ci', mongodb: 'Cim', postgres: 'Cip' }[backend];
  const build = (types, { included } = {}) => {
    const runtime = backends[backend]();
    connectAll(runtime, track(...types));
    return runtime.createSchema(undefined, included);
  };

  test('names a second self-referencing collection with the same field name after its type', () => {
    const schema = build([treeType(`${prefix}Category`), treeType(`${prefix}Comment`)]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}CategoryInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}CategoryInputForUpdate`, 'children')).toBe('OneToManyUchildren');
    expect(fieldType(schema, `${prefix}CommentInput`, 'children')).toBe(`OneToMany${prefix}CommentAchildren`);
    expect(fieldType(schema, `${prefix}CommentInputForUpdate`, 'children')).toBe(`OneToMany${prefix}CommentUchildren`);
    // The qualified collections keep their own item inputs.
    expect(addedItem(schema, `OneToMany${prefix}CommentAchildren`).name).toBe(`A${prefix}CommentInputForParent`);
    expect(addedItem(schema, `OneToMany${prefix}CommentUchildren`).name).toBe(`U${prefix}CommentInputForParent`);
    expect(fieldType(schema, `A${prefix}CommentInputForParent`, 'children')).toBe(`OneToMany${prefix}CommentAchildren`);
  });

  test('gives the unqualified names to the first registered type that the generated mutations reach', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Comment = new GraphQLObjectType({
      name: `${prefix}ReachComment`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        folder: { type: Folder, extensions: ref() },
        parent: { type: Comment, extensions: ref() },
        children: { type: new GraphQLList(Comment), extensions: ref('parent') },
      }),
    });
    const Category = treeType(`${prefix}ReachCategory`);
    const Folder = new GraphQLObjectType({
      name: `${prefix}ReachFolder`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        // Makes the earlier registered, endpoint-less Comment reachable from the Folder mutations.
        comments: { type: new GraphQLList(Comment), extensions: ref('folder') },
      }),
    });
    track(Comment, Category, Folder);
    runtime.addNoEndpointType(Comment);
    connectAll(runtime, [Category, Folder]);
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}ReachFolderA${prefix}ReachCommentInputForFolder`, 'children'))
      .toBe('OneToManyAchildren');
    expect(addedItem(schema, 'OneToManyAchildren').name).toBe(`A${prefix}ReachCommentInputForParent`);
    expect(fieldType(schema, `${prefix}ReachCategoryInput`, 'children')).toBe(`OneToMany${prefix}ReachCategoryAchildren`);
  });

  test('qualifies self-referencing collections that differ only in their connectionField', () => {
    const schema = build([treeType(`${prefix}Folder`, { connection: 'parentFolder' }), treeType(`${prefix}Section`)]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}FolderInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}SectionInput`, 'children')).toBe(`OneToMany${prefix}SectionAchildren`);
    expect(addedItem(schema, 'OneToManyAchildren').name).toBe(`A${prefix}FolderInputForParentFolder`);
  });

  test('shares the added item input of collections that reach one child through one connectionField', () => {
    const Serie = new GraphQLObjectType({
      name: `${prefix}Serie`,
      fields: () => ({
        id: { type: GraphQLID },
        episodes: { type: new GraphQLList(Episode), extensions: ref('serie') },
        featured: { type: new GraphQLList(Episode), extensions: ref('serie') },
      }),
    });
    const Episode = new GraphQLObjectType({
      name: `${prefix}Episode`,
      fields: () => ({
        id: { type: GraphQLID }, name: { type: GraphQLString }, serie: { type: Serie, extensions: ref() },
      }),
    });
    const Node = new GraphQLObjectType({
      name: `${prefix}Node`,
      fields: () => ({
        id: { type: GraphQLID },
        parent: { type: Node, extensions: ref() },
        children: { type: new GraphQLList(Node), extensions: ref('parent') },
        subnodes: { type: new GraphQLList(Node), extensions: ref('parent') },
      }),
    });
    const schema = build([Serie, Episode, Node]);
    expect(validateSchema(schema)).toEqual([]);
    expect(addedItem(schema, `OneToMany${prefix}SerieAepisodes`)).toBe(addedItem(schema, `OneToMany${prefix}SerieAfeatured`));
    expect(addedItem(schema, `OneToMany${prefix}SerieAepisodes`).name).toBe(`${prefix}SerieA${prefix}EpisodeInputForSerie`);
    expect(addedItem(schema, `OneToMany${prefix}SerieUepisodes`)).toBe(addedItem(schema, `OneToMany${prefix}SerieUfeatured`));
    expect(addedItem(schema, 'OneToManyAchildren')).toBe(addedItem(schema, 'OneToManyAsubnodes'));
    expect(addedItem(schema, 'OneToManyAchildren').name).toBe(`A${prefix}NodeInputForParent`);
    expect(addedItem(schema, 'OneToManyUchildren')).toBe(addedItem(schema, 'OneToManyUsubnodes'));
  });

  test('builds inputs for cycles of writable collections across types', () => {
    const Department = new GraphQLObjectType({
      name: `${prefix}Department`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        manager: { type: Employee, extensions: ref('manager') },
        employees: { type: new GraphQLList(Employee), extensions: ref('department') },
      }),
    });
    const Employee = new GraphQLObjectType({
      name: `${prefix}Employee`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        department: { type: Department, extensions: ref('department') },
        managedDepartments: { type: new GraphQLList(Department), extensions: ref('manager') },
      }),
    });
    const schema = build([Department, Employee]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}DepartmentInput`, 'employees')).toBe(`OneToMany${prefix}DepartmentAemployees`);
    expect(addedItem(schema, `OneToMany${prefix}EmployeeAmanagedDepartments`).name)
      .toBe(`${prefix}EmployeeA${prefix}DepartmentInputForManager`);
    expect(isValid(schema, `mutation { add${endpoint(Department)}(input: { name: "D1", employees: { added: [{ name: "E1",
      managedDepartments: { added: [{ name: "D2", employees: { added: [{ name: "E2" }] } }] } }] } }) { id } }`)).toEqual([]);
    expect(isValid(schema, `mutation { update${endpoint(Employee)}(input: { id: "1", managedDepartments: {
      updated: [{ id: "2", employees: { added: [{ name: "E3" }] } }] } }) { id } }`)).toEqual([]);
  });

  test('builds inputs for a cycle of three types with required collections and a self collection', () => {
    const A = new GraphQLObjectType({
      name: `${prefix}CycleA`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        c: { type: C, extensions: ref() },
        bs: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(B))), extensions: ref('a') },
      }),
    });
    const B = new GraphQLObjectType({
      name: `${prefix}CycleB`,
      fields: () => ({
        id: { type: GraphQLID },
        a: { type: A, extensions: ref() },
        cs: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(C))), extensions: ref('b') },
      }),
    });
    const C = new GraphQLObjectType({
      name: `${prefix}CycleC`,
      fields: () => ({
        id: { type: GraphQLID },
        b: { type: B, extensions: ref() },
        parent: { type: C, extensions: ref() },
        as: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(A))), extensions: ref('c') },
        children: { type: new GraphQLList(C), extensions: ref('parent') },
      }),
    });
    const schema = build([A, B, C]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}CycleAInput`, 'bs')).toBe(`OneToMany${prefix}CycleAAbs!`);
    expect(isValid(schema, `mutation { add${endpoint(A)}(input: { name: "a1", bs: { added: [{ cs: { added: [{
      as: { added: [{ name: "a2", bs: { added: [] } }] }, children: { added: [{ as: { added: [] } }] } }] } }] } }) { id } }`))
      .toEqual([]);
  });

  test('makes self-referencing collections optional only in the items an add mutation creates', () => {
    const Tree = treeType(`${prefix}Tree`, {
      list: (T) => new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(T))),
      description: 'Child nodes',
    });
    const schema = build([Tree]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}TreeInput`, 'children')).toBe('OneToManyAchildren!');
    expect(fieldType(schema, `${prefix}TreeInputForUpdate`, 'children')).toBe('OneToManyUchildren');
    // Additive: the item an add mutation creates keeps its name and gains an optional field.
    expect(fieldType(schema, `A${prefix}TreeInputForParent`, 'children')).toBe('OneToManyAchildren');
    // Items added through an update keep the field as the type declares it.
    expect(fieldType(schema, `U${prefix}TreeInputForParent`, 'children')).toBe('OneToManyAchildren!');
    for (const typeName of [`${prefix}TreeInput`, `${prefix}TreeInputForUpdate`, `A${prefix}TreeInputForParent`,
      `U${prefix}TreeInputForParent`]) {
      expect(fieldOf(schema, typeName, 'children').description).toBe('Child nodes');
    }
    const add = `add${endpoint(Tree)}`;
    expect(isValid(schema, `mutation { ${add}(input: { name: "root", children: { added: [{ name: "a" }] } }) { id } }`))
      .toEqual([]);
    expect(isValid(schema, `mutation { ${add}(input: { name: "root", children: { added: [
      { name: "a", children: { added: [{ name: "a1", children: { added: [{ name: "a11" }] } }] } }] } }) { id } }`))
      .toEqual([]);
    const update = `update${endpoint(Tree)}`;
    expect(isValid(schema, `mutation { ${update}(input: { id: "1", children: { added: [{ name: "a",
      children: { added: [{ name: "a1" }] } }] } }) { id } }`)).toEqual([]);
    expect(isValid(schema, `mutation { ${update}(input: { id: "1", children: { added: [{ name: "a" }] } }) { id } }`)
      .map((error) => error.message)).toEqual([
      `Field "U${prefix}TreeInputForParent.children" of required type "OneToManyAchildren!" was not provided.`,
    ]);
  });

  test('accepts nullable IDs in deleted for collections with non-null items', () => {
    const Author = new GraphQLObjectType({
      name: `${prefix}Author`,
      fields: () => ({
        id: { type: GraphQLID },
        books: { type: new GraphQLList(new GraphQLNonNull(Book)), extensions: ref('author') },
      }),
    });
    const Book = new GraphQLObjectType({
      name: `${prefix}Book`,
      fields: () => ({
        id: { type: GraphQLID }, title: { type: GraphQLString }, author: { type: Author, extensions: ref() },
      }),
    });
    const Shelf = treeType(`${prefix}Shelf`, { list: (T) => new GraphQLList(new GraphQLNonNull(T)) });
    const schema = build([Author, Book, Shelf]);
    for (const name of [`OneToMany${prefix}AuthorAbooks`, `OneToMany${prefix}AuthorUbooks`, 'OneToManyAchildren',
      'OneToManyUchildren']) {
      const fields = schema.getType(name).getFields();
      expect(String(fields.deleted.type)).toBe('[ID]');
      expect(String(fields.added.type)).toMatch(/!]$/);
      expect(String(fields.updated.type)).toMatch(/!]$/);
    }
    const update = `update${endpoint(Author)}`;
    for (const declaration of ['[ID]', '[ID!]', '[ID!]!']) {
      expect(isValid(schema, `mutation($ids: ${declaration}) { ${update}(input: { id: "1", books: { deleted: $ids } }) { id } }`))
        .toEqual([]);
    }
    expect(isValid(schema, `mutation { ${update}(input: { id: "1", books: { deleted: ["2", null] } }) { id } }`)).toEqual([]);
  });

  test('warns once when a self-referencing collection is named after its type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Category = treeType(`${prefix}WarnCategory`);
    const Comment = treeType(`${prefix}WarnComment`);
    connectAll(runtime, track(Category, Comment));
    runtime.createSchema();
    runtime.createSchema();
    const messages = warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('children'));
    expect(messages).toEqual([
      `Configuration issue: ${prefix}WarnComment.children and ${prefix}WarnCategory.children are self-referencing `
        + `collections with the same name, so the inputs of ${prefix}WarnComment.children are named `
        + `OneToMany${prefix}WarnCommentAchildren and OneToMany${prefix}WarnCommentUchildren, while `
        + `${prefix}WarnCategory.children keeps OneToManyAchildren and OneToManyUchildren. To choose which type keeps `
        + 'those names, register it first, or make the other type unreachable from the generated mutations.',
    ]);
  });

  test('keeps the unqualified names when the other type with the same field cannot be reached (guard)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Hidden = treeType(`${prefix}HiddenComment`);
    const Visible = treeType(`${prefix}VisibleCategory`);
    track(Hidden, Visible);
    runtime.addNoEndpointType(Hidden);
    runtime.connect(null, Visible, endpoint(Visible), `${endpoint(Visible)}s`);
    const schema = runtime.createSchema();
    expect(fieldType(schema, `${prefix}VisibleCategoryInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}VisibleCategoryInputForUpdate`, 'children')).toBe('OneToManyUchildren');

    const Excluded = treeType(`${prefix}ExcludedTree`);
    const Included = treeType(`${prefix}IncludedTree`);
    const partial = build([Excluded, Included], { included: [Included] });
    expect(fieldType(partial, `${prefix}IncludedTreeInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(partial, `${prefix}IncludedTreeInputForUpdate`, 'children')).toBe('OneToManyUchildren');
    expect(warn.mock.calls.filter(([message]) => String(message).includes('self-referencing'))).toEqual([]);
  });

  test('keeps the unqualified names for a type reached only through a readOnly field (guard)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    // Registered first, so it would keep the names if a readOnly field made its inputs reachable.
    const Shown = new GraphQLObjectType({
      name: `${prefix}RoShownComment`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        board: { type: Board, extensions: ref() },
        parent: { type: Shown, extensions: ref() },
        children: { type: new GraphQLList(Shown), extensions: ref('parent') },
      }),
    });
    const Board = new GraphQLObjectType({
      name: `${prefix}RoBoard`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        comments: { type: new GraphQLList(Shown), extensions: { ...ref('board'), readOnly: true } },
      }),
    });
    const Category = treeType(`${prefix}RoCategory`);
    track(Shown, Board, Category);
    runtime.addNoEndpointType(Shown);
    connectAll(runtime, [Board, Category]);
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}RoCategoryInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}RoCategoryInputForUpdate`, 'children')).toBe('OneToManyUchildren');
    expect(addedItem(schema, 'OneToManyAchildren').name).toBe(`A${prefix}RoCategoryInputForParent`);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('self-referencing'))).toEqual([]);
  });

  // PostgreSQL rejects referenced collections inside embedded objects (INVALID_MODEL).
  test.skipIf(backend === 'postgres')('gives the unqualified names to a type reached only through an embedded object field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Outline = treeType(`${prefix}EmbOutline`);
    const Document = new GraphQLObjectType({
      name: `${prefix}EmbDocument`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        outline: { type: Outline, extensions: { relation: { embedded: true } } },
      }),
    });
    const Category = treeType(`${prefix}EmbCategory`);
    track(Outline, Document, Category);
    runtime.addNoEndpointType(Outline);
    connectAll(runtime, [Document, Category]);
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}EmbDocumentInput`, 'outline')).toBe(`${prefix}EmbOutlineInput`);
    expect(fieldType(schema, `${prefix}EmbOutlineInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}EmbCategoryInput`, 'children')).toBe(`OneToMany${prefix}EmbCategoryAchildren`);
    expect(fieldType(schema, `${prefix}EmbCategoryInputForUpdate`, 'children'))
      .toBe(`OneToMany${prefix}EmbCategoryUchildren`);
    expect(warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('self-referencing')))
      .toHaveLength(1);
  });

  test('keeps the generated names of a single self-referencing collection (guard)', () => {
    const Tree = treeType(`${prefix}LegacyTree`);
    const schema = build([Tree]);
    expect(Object.keys(schema.getTypeMap())
      .filter((name) => name.startsWith('OneToMany') || name.includes('InputFor')).sort()).toEqual([
      `A${prefix}LegacyTreeInputForParent`, `${prefix}LegacyTreeInputForUpdate`, 'OneToManyAchildren',
      'OneToManyUchildren', `U${prefix}LegacyTreeInputForParent`,
    ]);
  });
});

// PostgreSQL rejects registration after createSchema(), so only core and MongoDB can register a type
// after a schema was built.
describe.each(['core', 'mongodb'])('self-referencing collections registered after a schema on %s', (backend) => {
  const prefix = { core: 'Cil', mongodb: 'Ciml' }[backend];
  const selfCollectionWarnings = (warn) => warn.mock.calls.map(([message]) => String(message))
    .filter((message) => message.includes('self-referencing'));

  test('keeps the unqualified names for a type registered again under the same name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const schemas = [];
    for (let build = 0; build < 2; build += 1) {
      // A new type object with the same name, as when an application reloads its types.
      const Category = treeType(`${prefix}ReRegCategory`);
      if (mongoose.models[Category.name]) mongoose.deleteModel(Category.name);
      connectAll(runtime, track(Category));
      schemas.push(runtime.createSchema());
    }
    for (const schema of schemas) {
      expect(validateSchema(schema)).toEqual([]);
      expect(fieldType(schema, `${prefix}ReRegCategoryInput`, 'children')).toBe('OneToManyAchildren');
      expect(fieldType(schema, `${prefix}ReRegCategoryInputForUpdate`, 'children')).toBe('OneToManyUchildren');
    }
    expect(selfCollectionWarnings(warn)).toEqual([]);
  });

  test('keeps the unqualified names for a type registered after a schema whose types it never meets', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Category = treeType(`${prefix}LateCategory`);
    const Comment = treeType(`${prefix}LateComment`);
    track(Category, Comment);
    connectAll(runtime, [Category]);
    runtime.createSchema(undefined, [Category]);
    connectAll(runtime, [Comment]);
    const schema = runtime.createSchema(undefined, [Comment]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}LateCommentInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}LateCommentInputForUpdate`, 'children')).toBe('OneToManyUchildren');
    expect(isValid(schema, `mutation($c: OneToManyAchildren) { add${endpoint(Comment)}(input: { name: "x",
      children: $c }) { id } }`)).toEqual([]);
    expect(selfCollectionWarnings(warn)).toEqual([]);
  });

  test('still names a type registered after a schema after itself when a later schema reaches both', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Category = treeType(`${prefix}BothCategory`);
    const Comment = treeType(`${prefix}BothComment`);
    track(Category, Comment);
    connectAll(runtime, [Category]);
    runtime.createSchema();
    connectAll(runtime, [Comment]);
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}BothCategoryInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}BothCommentInput`, 'children')).toBe(`OneToMany${prefix}BothCommentAchildren`);
    expect(fieldType(schema, `${prefix}BothCommentInputForUpdate`, 'children'))
      .toBe(`OneToMany${prefix}BothCommentUchildren`);
    expect(selfCollectionWarnings(warn)).toHaveLength(1);
  });

  test('names a later type after itself when its schema reaches any earlier type with the unqualified names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Category = treeType(`${prefix}HoldCategory`);
    const Comment = treeType(`${prefix}HoldComment`);
    const Folder = treeType(`${prefix}HoldFolder`);
    track(Category, Comment, Folder);
    connectAll(runtime, [Category]);
    runtime.createSchema(undefined, [Category]);
    // Comment never meets Category, so it also keeps the unqualified names.
    connectAll(runtime, [Comment]);
    runtime.createSchema(undefined, [Comment]);
    connectAll(runtime, [Folder]);
    const schema = runtime.createSchema(undefined, [Category, Folder]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}HoldCategoryInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}HoldFolderInput`, 'children')).toBe(`OneToMany${prefix}HoldFolderAchildren`);
    const warnings = selfCollectionWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${prefix}HoldCategory.children keeps OneToManyAchildren`);
  });

  test('names a later type after itself when its schema reaches a type built unreachable with the unqualified names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const Category = treeType(`${prefix}UnreachedCategory`);
    const Comment = treeType(`${prefix}UnreachedComment`);
    const Folder = treeType(`${prefix}UnreachedFolder`);
    track(Category, Comment, Folder);
    // Comment's inputs are built in the first schema, unqualified, although its mutations are left out.
    connectAll(runtime, [Category, Comment]);
    runtime.createSchema(undefined, [Category]);
    connectAll(runtime, [Folder]);
    const schema = runtime.createSchema(undefined, [Comment, Folder]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, `${prefix}UnreachedCommentInput`, 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, `${prefix}UnreachedFolderInput`, 'children'))
      .toBe(`OneToMany${prefix}UnreachedFolderAchildren`);
    const warnings = selfCollectionWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${prefix}UnreachedComment.children keeps OneToManyAchildren`);
  });
});

test('keeps the unqualified names for a type registered after a schema through the MongoDB entry point', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const simfinity = await import('../packages/mongodb/src/index.js');
  simfinity.preventCreatingCollection(true);
  const Category = treeType('CifLateCategory');
  const Comment = treeType('CifLateComment');
  track(Category, Comment);
  simfinity.connect(null, Category, endpoint(Category), `${endpoint(Category)}s`);
  simfinity.createSchema(undefined, [Category]);
  simfinity.connect(null, Comment, endpoint(Comment), `${endpoint(Comment)}s`);
  const schema = simfinity.createSchema(undefined, [Comment]);
  expect(isValid(schema, `mutation($c: OneToManyAchildren) { add${endpoint(Comment)}(input: { name: "x",
    children: $c }) { id } }`)).toEqual([]);
  expect(warn.mock.calls.filter(([message]) => String(message).includes('self-referencing'))).toEqual([]);
});

describe('collection inputs without a connectionField (MongoDB, own resolvers)', () => {
  const own = { extensions: ref(), resolve: () => [] };

  test('names a second self-referencing collection after its type and adds the item create input', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tree = (name) => {
      const T = new GraphQLObjectType({
        name,
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          children: { type: new GraphQLList(T), ...own },
        }),
      });
      return T;
    };
    const runtime = backends.mongodb();
    connectAll(runtime, track(tree('CimNcCategory'), tree('CimNcComment')));
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldType(schema, 'CimNcCategoryInput', 'children')).toBe('OneToManyAchildren');
    expect(fieldType(schema, 'CimNcCommentInput', 'children')).toBe('OneToManyCimNcCommentAchildren');
    expect(String(schema.getType('OneToManyAchildren').getFields().added.type)).toBe('[CimNcCategoryInput]');
    expect(String(schema.getType('OneToManyCimNcCommentAchildren').getFields().added.type)).toBe('[CimNcCommentInput]');
    expect(String(schema.getType('OneToManyCimNcCommentUchildren').getFields().updated.type))
      .toBe('[CimNcCommentInputForUpdate]');
  });

  test('builds the item inputs of own-resolver collections that form a cycle across types', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Department = new GraphQLObjectType({
      name: 'CimNcDepartment',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        employees: { type: new GraphQLList(Employee), ...own },
      }),
    });
    const Employee = new GraphQLObjectType({
      name: 'CimNcEmployee',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        departments: { type: new GraphQLList(Department), ...own },
      }),
    });
    const runtime = backends.mongodb();
    connectAll(runtime, track(Department, Employee));
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(String(schema.getType('OneToManyCimNcDepartmentAemployees').getFields().added.type)).toBe('[CimNcEmployeeInput]');
    expect(String(schema.getType('OneToManyCimNcEmployeeAdepartments').getFields().added.type))
      .toBe('[CimNcDepartmentInput]');
  });
});

describe('inputs that still cannot be generated', () => {
  const schemaError = (runtime) => {
    try {
      runtime.createSchema();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const matrixRuntime = () => {
    const runtime = createRuntime(createMemoryAdapter());
    const Matrix = new GraphQLObjectType({
      name: 'CiMatrix',
      fields: () => ({ id: { type: GraphQLID }, rows: { type: new GraphQLList(new GraphQLList(GraphQLString)) } }),
    });
    connectAll(runtime, [Matrix]);
    return runtime;
  };
  const embedded = { relation: { embedded: true } };
  const embeddedCycleRuntime = () => {
    const runtime = createRuntime(createMemoryAdapter());
    const A = new GraphQLObjectType({
      name: 'CiEmbeddedA',
      fields: () => ({ id: { type: GraphQLID }, b: { type: B, extensions: embedded } }),
    });
    const B = new GraphQLObjectType({
      name: 'CiEmbeddedB',
      fields: () => ({ x: { type: GraphQLString }, a: { type: A, extensions: embedded } }),
    });
    // Waits for CiEmbeddedA through an embedded list, but is not part of the cycle.
    const C = new GraphQLObjectType({
      name: 'CiEmbeddedC',
      fields: () => ({ id: { type: GraphQLID }, as: { type: new GraphQLList(A), extensions: embedded } }),
    });
    runtime.connect(null, A, 'ciembeddeda', 'ciembeddedas');
    runtime.addNoEndpointType(B);
    runtime.connect(null, C, 'ciembeddedc', 'ciembeddedcs');
    return runtime;
  };

  test('still rejects a writable list of lists with INPUT_TYPE_UNRESOLVED (guard)', () => {
    const error = schemaError(matrixRuntime());
    expect(error?.extensions).toMatchObject({ code: 'INPUT_TYPE_UNRESOLVED', status: 500 });
    expect(error.message).toMatch(/^Could not build input types for: CiMatrix\. Check for circular or misconfigured relations/);
  });

  test('names every field that has no input apart from the fields that only wait for another type', () => {
    const runtime = createRuntime(createMemoryAdapter());
    const Meta = new GraphQLObjectType({
      name: 'CiGridMeta',
      fields: () => ({ cells: { type: new GraphQLList(new GraphQLList(GraphQLFloat)) } }),
    });
    const Grid = new GraphQLObjectType({
      name: 'CiGridSheet',
      fields: () => ({
        id: { type: GraphQLID },
        rows: { type: new GraphQLList(new GraphQLList(GraphQLString)) },
        // Waits for CiGridMeta, which cannot be built for a reason of its own.
        meta: { type: Meta, extensions: embedded },
        cols: { type: new GraphQLNonNull(new GraphQLList(new GraphQLList(GraphQLInt))) },
        name: { type: GraphQLString },
      }),
    });
    connectAll(runtime, [Grid]);
    runtime.addNoEndpointType(Meta);
    const error = schemaError(runtime);
    expect(error?.extensions).toMatchObject({ code: 'INPUT_TYPE_UNRESOLVED', status: 500 });
    expect(error.message).toBe('Could not build input types for: CiGridSheet, CiGridMeta. Check for circular or '
      + 'misconfigured relations: no input can be generated for CiGridSheet.rows, CiGridSheet.cols, CiGridMeta.cells '
      + '(writable lists whose items have no generated input, such as lists of lists); mark such a field readOnly. '
      + 'These fields only wait for another listed type and build once it does: CiGridSheet.meta waits for CiGridMeta.');
  });

  test('still rejects embedded types that contain each other on the core runtime (guard)', () => {
    const error = schemaError(embeddedCycleRuntime());
    expect(error?.extensions).toMatchObject({ code: 'INPUT_TYPE_UNRESOLVED', status: 500 });
    expect(error.message).toMatch(/^Could not build input types for: CiEmbeddedA, CiEmbeddedB, CiEmbeddedC\./);
  });

  test('names the fields whose input cannot be generated', () => {
    expect(schemaError(matrixRuntime()).message).toContain('no input can be generated for CiMatrix.rows (writable lists '
      + 'whose items have no generated input, such as lists of lists); mark such a field readOnly.');
    expect(schemaError(embeddedCycleRuntime()).message).toBe('Could not build input types for: CiEmbeddedA, '
      + 'CiEmbeddedB, CiEmbeddedC. Check for circular or misconfigured relations: no input can be generated for '
      + 'CiEmbeddedA.b, CiEmbeddedB.a (embedded types that contain each other); mark such a field readOnly. These '
      + 'fields only wait for another listed type and build once it does: CiEmbeddedC.as waits for CiEmbeddedA.');
  });

  test('builds a readOnly list of lists (guard)', () => {
    const runtime = createRuntime(createMemoryAdapter());
    const Grid = new GraphQLObjectType({
      name: 'CiGrid',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        rows: { type: new GraphQLList(new GraphQLList(GraphQLString)), extensions: { readOnly: true } },
      }),
    });
    connectAll(runtime, [Grid]);
    expect(validateSchema(runtime.createSchema())).toEqual([]);
  });
});

describe('nested writes through the collection inputs (memory adapter)', () => {
  test('creates a three-level tree of one type in one add mutation', async () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const Tree = treeType('CiRunTree');
    connectAll(runtime, [Tree]);
    const schema = runtime.createSchema();
    const result = await graphql({
      schema,
      source: `mutation { addciruntree(input: { name: "root", children: { added: [
        { name: "a", children: { added: [{ name: "a1", children: { added: [{ name: "a11" }] } }] } }, { name: "b" }] } }) { id } }`,
    });
    expect(result.errors).toBeUndefined();
    const byName = Object.fromEntries(adapter.rows('CiRunTree').map((row) => [row.name, row]));
    expect(Object.keys(byName).sort()).toEqual(['a', 'a1', 'a11', 'b', 'root']);
    expect(byName.root.parent).toBeUndefined();
    expect(byName.a.parent).toBe(byName.root._id);
    expect(byName.b.parent).toBe(byName.root._id);
    expect(byName.a1.parent).toBe(byName.a._id);
    expect(byName.a11.parent).toBe(byName.a1._id);
  });

  test('creates records through a cycle of collections across types in one add mutation', async () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const Department = new GraphQLObjectType({
      name: 'CiRunDepartment',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        manager: { type: Employee, extensions: ref('manager') },
        employees: { type: new GraphQLList(Employee), extensions: ref('department') },
      }),
    });
    const Employee = new GraphQLObjectType({
      name: 'CiRunEmployee',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        department: { type: Department, extensions: ref('department') },
        managedDepartments: { type: new GraphQLList(Department), extensions: ref('manager') },
      }),
    });
    connectAll(runtime, [Department, Employee]);
    const schema = runtime.createSchema();
    const result = await graphql({
      schema,
      source: `mutation { addcirundepartment(input: { name: "D1", employees: { added: [{ name: "E1",
        managedDepartments: { added: [{ name: "D2", employees: { added: [{ name: "E2" }] } }] } }] } }) { id } }`,
    });
    expect(result.errors).toBeUndefined();
    const departments = Object.fromEntries(adapter.rows('CiRunDepartment').map((row) => [row.name, row]));
    const employees = Object.fromEntries(adapter.rows('CiRunEmployee').map((row) => [row.name, row]));
    expect(employees.E1.department).toBe(departments.D1._id);
    expect(departments.D2.manager).toBe(employees.E1._id);
    expect(employees.E2.department).toBe(departments.D2._id);
    expect(departments.D1.manager).toBeUndefined();
  });
});

// Declarative optimistic concurrency (#98): the startup checks of a protected type, the version field
// createSchema() injects, and the schema generated around it. The mutation lifecycle has its own tests.
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType,
  GraphQLScalarType, GraphQLString, coerceInputValue, graphql, printSchema, printType,
} from 'graphql';
import { buildErrorFormatter, createRuntime, describeModels } from '@simtlix/simfinity-core';

// Loaded on use, so that on a checkout without the subpath each test fails by itself, not the whole file.
const RECORD_VERSION_MODULE = '@simtlix/simfinity-core/internal/record-version';
const load = () => import(/* @vite-ignore */ RECORD_VERSION_MODULE);

const RANGE = 'RecordVersion must be an integer from 1 to 9007199254740991';
const SHAPE = (type) => `${type} extensions.concurrency must be { mode: 'optimistic' }`;
const TOGGLE = (type) => `${type} declares optimistic concurrency after a schema was created without it; declare it `
  + `before the first createSchema() that contains ${type}`;
const BUILT = (type) => `${type} declares optimistic concurrency after its inputs or generated model were built without it; `
  + `declare it before the first createSchema() attempt that builds ${type}`;
const REMOVED = (type) => `${type} no longer declares optimistic concurrency, but Simfinity already added its version `
  + 'field; keep extensions.concurrency on a type once it has that field';
const ENTITY = (type) => `${type} declares optimistic concurrency, so it must be an entity: register it with connect() `
  + 'or make it a relation target';
const EMBEDDED_USE = (type, path) => `${type} declares optimistic concurrency, so it cannot be embedded (${path})`;
const COLLISION = (type, tail) => `${type} declares optimistic concurrency, so Simfinity adds its version field, but ${tail}`;
const MISUSE = (field) => `${field} uses RecordVersion, which only the managed version field may use`;
const UNSUPPORTED = (type) => `The database adapter does not support optimistic concurrency, which ${type} declares `
  + '(extensions.concurrency)';
const RESERVED = (name) => `${name} is reserved for optimistic concurrency; rename the application type`;
const FOREIGN = (type) => `${type} declares optimistic concurrency, so a schema that contains it must register it in this `
  + 'runtime, with connect() or as a relation target';
const SECOND_COPY = 'RecordVersion is reserved for optimistic concurrency, and this RecordVersion comes from another copy '
  + 'of @simtlix/simfinity-core: two copies of the package are loaded; import RecordVersion from the facade the '
  + 'application uses';
const CORE_DESCRIPTION = 'Revision of a record with optimistic concurrency. Send it back unchanged in updates and deletes; '
  + 'Simfinity advances it.';

const invalidModel = (message) => ({ code: 'INVALID_MODEL', status: 400, message });
const reservedName = (name) => ({ code: 'RESERVED_TYPE_NAME', status: 500, message: RESERVED(name) });

// An adapter that keeps records in memory and declares optimistic concurrency unless `options` gives
// other writeFeatures, undefined included. Writes are not part of these tests.
const createAdapter = (options = {}) => {
  const records = new Map();
  return {
    writeFeatures: Object.hasOwn(options, 'writeFeatures') ? options.writeFeatures : { optimisticConcurrency: true },
    prepare: vi.fn(),
    createModel: vi.fn((gqltype, onModelCreated) => {
      const model = { name: gqltype.name };
      if (onModelCreated) onModelCreated(model);
      return model;
    }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    newRecord: (Model, data) => ({ ...data, _id: String(records.size + 1) }),
    async saveRecord(Model, record) {
      records.set(`${Model.name}:${record._id}`, record);
      return record;
    },
    toObject: (record) => ({ ...record }),
    async getById(Model, id) { return records.get(`${Model.name}:${id}`) ?? null; },
    prepareUpdate: (set, unset) => ({ set, unset }),
    async update() { throw new Error('writes are not part of these tests'); },
    async delete() { throw new Error('writes are not part of these tests'); },
    async find() { return []; },
    async count() { return 0; },
    async aggregate() { return []; },
    async findChildren() { return []; },
    seed(typeName, record) { records.set(`${typeName}:${record._id}`, record); },
  };
};

const OPTIMISTIC = () => ({ concurrency: { mode: 'optimistic' } });
const ref = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
const EMBEDDED = () => ({ relation: { embedded: true } });

const objectType = (name, fields, extensions = {}) => new GraphQLObjectType({
  name, extensions, fields: () => ({ id: { type: GraphQLID }, ...fields() }),
});
const productType = ({ name = 'Producto', extensions = OPTIMISTIC(), fields = () => ({}) } = {}) => objectType(
  name, () => ({ name: { type: GraphQLString }, price: { type: GraphQLInt }, ...fields() }), extensions,
);

// An unprotected order with a collection of protected items, a protected type with a self-referencing
// collection, and a protected product.
const storeTypes = () => {
  const Pedido = objectType('Pedido', () => ({
    numero: { type: GraphQLString },
    items: { type: new GraphQLList(Item), extensions: ref('pedido') },
  }));
  const Item = objectType('Item', () => ({
    nombre: { type: GraphQLString },
    pedido: { type: Pedido, extensions: ref() },
  }), OPTIMISTIC());
  const Categoria = objectType('Categoria', () => ({
    name: { type: GraphQLString },
    padre: { type: Categoria, extensions: ref() },
    subcategorias: { type: new GraphQLList(Categoria), extensions: ref('padre') },
  }), OPTIMISTIC());
  return {
    Producto: productType(), Pedido, Item, Categoria,
  };
};

// Types with none of the extension: a collection and a self-referencing collection.
const libraryTypes = () => {
  const Autor = objectType('Autor', () => ({
    nombre: { type: new GraphQLNonNull(GraphQLString) },
    libros: { type: new GraphQLList(Libro), extensions: ref('autor') },
  }));
  const Libro = objectType('Libro', () => ({
    titulo: { type: GraphQLString },
    paginas: { type: GraphQLInt },
    autor: { type: Autor, extensions: ref() },
  }));
  const Nodo = objectType('Nodo', () => ({
    etiqueta: { type: GraphQLString },
    padre: { type: Nodo, extensions: ref() },
    hijos: { type: new GraphQLList(Nodo), extensions: ref('padre') },
  }));
  return { Autor, Libro, Nodo };
};

const lower = (name) => name.charAt(0).toLowerCase() + name.slice(1);
const connectAll = (runtime, ...types) => {
  for (const type of types) runtime.connect(null, type, lower(type.name), `${lower(type.name)}s`);
  return runtime;
};
const buildStore = () => {
  const types = storeTypes();
  const adapter = createAdapter();
  const schema = connectAll(createRuntime(adapter), ...Object.values(types)).createSchema();
  return { ...types, adapter, schema };
};

const thrown = (callback) => {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
};
const expectError = (error, { code, status, message }) => {
  expect(error.extensions).toMatchObject({ code, status });
  expect(error.message).toBe(message);
};
const fieldList = (schema, typeName) => Object.values(schema.getType(typeName).getFields())
  .map((field) => `${field.name}: ${field.type}`);
const argList = (field) => field.args.map((arg) => `${arg.name}: ${arg.type}`);
const mutationArgs = (schema, name) => argList(schema.getMutationType().getFields()[name]);
// The injected field's marker (RECORD_VERSION_FIELD), read here so that a test that only looks for the field fails on
// a version without it for that reason, not for the missing module.
const isInjected = (field) => field?.extensions?.[Symbol.for('simfinity.recordVersionField')] === true;
const hasVersionField = (type) => Object.values(type.getFields()).some(isInjected);
const run = async (schema, source, variableValues) => {
  const result = await graphql({ schema, source, variableValues, contextValue: {} });
  return result.errors ? { ...result, errors: result.errors.map(buildErrorFormatter()) } : result;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startup validation', () => {
  it('checks the declaration at connect() and addNoEndpointType(), reading only extensions', () => {
    for (const concurrency of [null, [], {}, 'optimistic', { mode: 'pessimistic' }, { mode: 'optimistic', retries: 3 }]) {
      const fields = vi.fn(() => ({ id: { type: GraphQLID } }));
      const type = new GraphQLObjectType({ name: 'Producto', extensions: { concurrency }, fields });
      const runtime = createRuntime(createAdapter());
      expectError(thrown(() => runtime.connect(null, type, 'producto', 'productos')), invalidModel(SHAPE('Producto')));
      expect(fields).not.toHaveBeenCalled();
      expectError(thrown(() => runtime.addNoEndpointType(type)), invalidModel(SHAPE('Producto')));
      expect(runtime.getRegistrations()).toEqual([]);
    }
  });

  it('checks the declaration again at createSchema()', () => {
    const adapter = createAdapter();
    const Producto = productType();
    const runtime = connectAll(createRuntime(adapter), Producto);
    Producto.extensions.concurrency = { mode: 'optimistic', retries: 3 };
    expectError(thrown(() => runtime.createSchema()), invalidModel(SHAPE('Producto')));
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  // A protected type that another runtime registers, reached here through a registered mutation.
  const foreignProtected = (runtime) => {
    const Ajena = productType({ name: 'Ajena' });
    connectAll(createRuntime(createAdapter()), Ajena);
    runtime.registerMutation('ajena', 'ajena', null, Ajena, () => null);
    return Ajena;
  };

  // Each case breaks two adjacent checks of the spec's order; the earlier one is reported.
  const orderCases = {
    'the declaration shape': () => {
      const Etiqueta = productType({ name: 'Etiqueta', extensions: {} });
      connectAll(createRuntime(createAdapter()), Etiqueta).createSchema();
      Etiqueta.extensions.concurrency = { mode: 'optimistic' };
      const adapter = createAdapter();
      const Producto = productType();
      const runtime = connectAll(createRuntime(adapter), Etiqueta, Producto);
      Producto.extensions.concurrency = { mode: 'optimistic', retries: 3 };
      return {
        adapter, runtime, types: [Etiqueta, Producto], error: invalidModel(SHAPE('Producto')),
      };
    },
    'the protection recorded by an earlier schema': () => {
      const adapter = createAdapter();
      const runtime = createRuntime(adapter);
      const Ajena = foreignProtected(runtime);
      const Producto = productType({ extensions: {} });
      connectAll(createRuntime(createAdapter()), Producto).createSchema();
      Producto.extensions.concurrency = { mode: 'optimistic' };
      connectAll(runtime, Producto);
      return {
        adapter, runtime, types: [Ajena, Producto], error: invalidModel(TOGGLE('Producto')),
      };
    },
    'a protected type registered in another runtime': () => {
      const adapter = createAdapter();
      const runtime = createRuntime(adapter);
      const Ajena = foreignProtected(runtime);
      const Producto = productType();
      const Pedido = objectType('Pedido', () => ({ producto: { type: Producto, extensions: EMBEDDED() } }));
      connectAll(runtime, Producto, Pedido);
      return {
        adapter, runtime, types: [Ajena, Producto, Pedido], error: invalidModel(FOREIGN('Ajena')),
      };
    },
    'never embedded': () => {
      const adapter = createAdapter();
      const Producto = productType();
      const Pedido = objectType('Pedido', () => ({ producto: { type: Producto, extensions: EMBEDDED() } }));
      const runtime = createRuntime(adapter);
      runtime.addNoEndpointType(Producto);
      connectAll(runtime, Pedido);
      return {
        adapter, runtime, types: [Producto, Pedido], error: invalidModel(EMBEDDED_USE('Producto', 'Pedido.producto')),
      };
    },
    'entities only': () => {
      const adapter = createAdapter();
      const Producto = productType({ fields: () => ({ version: { type: GraphQLInt } }) });
      const runtime = createRuntime(adapter);
      runtime.addNoEndpointType(Producto);
      return {
        adapter, runtime, types: [Producto], error: invalidModel(ENTITY('Producto')),
      };
    },
    'storage collisions': async () => {
      const { RecordVersion } = await load();
      const adapter = createAdapter();
      const Producto = productType({
        fields: () => ({ version: { type: GraphQLString }, lastVersion: { type: RecordVersion } }),
      });
      const runtime = connectAll(createRuntime(adapter), Producto);
      return {
        adapter,
        runtime,
        types: [Producto],
        error: invalidModel(COLLISION('Producto', 'Producto already has a field named version; rename that field')),
      };
    },
    'other RecordVersion fields': async () => {
      const { RecordVersion } = await load();
      const adapter = createAdapter({ writeFeatures: undefined });
      const Producto = productType({ fields: () => ({ lastVersion: { type: RecordVersion } }) });
      const runtime = connectAll(createRuntime(adapter), Producto);
      return {
        adapter, runtime, types: [Producto], error: invalidModel(MISUSE('Producto.lastVersion')),
      };
    },
    'adapter support': () => {
      const adapter = createAdapter({ writeFeatures: undefined });
      const Producto = productType();
      const runtime = connectAll(createRuntime(adapter), Producto);
      runtime.registerMutation('legacy', 'legacy', null, new GraphQLScalarType({ name: 'RecordVersion' }), () => null);
      return {
        adapter, runtime, types: [Producto], error: invalidModel(UNSUPPORTED('Producto')),
      };
    },
    'reserved type names': () => {
      const adapter = createAdapter();
      const Producto = productType();
      const runtime = connectAll(createRuntime(adapter), Producto);
      runtime.registerMutation('legacy', 'legacy', null, new GraphQLScalarType({ name: 'RecordVersion' }), () => null);
      return {
        adapter, runtime, types: [Producto], error: reservedName('RecordVersion'),
      };
    },
  };

  it.each(Object.keys(orderCases))('reports %s before the later checks, before adapter.prepare(), injecting nothing', async (name) => {
    const {
      adapter, runtime, types, error,
    } = await orderCases[name]();
    expectError(thrown(() => runtime.createSchema()), error);
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
    for (const type of types) expect(hasVersionField(type), type.name).toBe(false);
  });

  it('injects the version field after adapter.prepare() and before adapter.createModel()', () => {
    const adapter = createAdapter();
    const seen = {};
    adapter.prepare.mockImplementation((registrations) => {
      seen.prepare = registrations.map(({ gqltype }) => Object.keys(gqltype.getFields()));
    });
    adapter.createModel.mockImplementation((gqltype) => {
      seen.createModel = Object.keys(gqltype.getFields());
      return { name: gqltype.name };
    });
    connectAll(createRuntime(adapter), productType()).createSchema();
    expect(seen.prepare).toEqual([['id', 'name', 'price']]);
    expect(seen.createModel).toEqual(['id', 'name', 'price', 'version']);
  });

  it('rejects a protected type that is not an entity, and accepts one that is a relation target', () => {
    const Producto = productType();
    const runtime = createRuntime(createAdapter());
    runtime.addNoEndpointType(Producto);
    expectError(thrown(() => runtime.createSchema()), invalidModel(ENTITY('Producto')));

    const { Pedido, Item } = storeTypes();
    const target = createRuntime(createAdapter());
    target.addNoEndpointType(Item);
    connectAll(target, Pedido).createSchema();
    expect(hasVersionField(Item)).toBe(true);
  });

  it('rejects a protected type used as an embedded value, single, in a list and through an unregistered readOnly type', () => {
    const cases = [
      [(Producto) => ({ producto: { type: Producto, extensions: EMBEDDED() } }), 'Pedido.producto'],
      [(Producto) => ({ productos: { type: new GraphQLList(Producto), extensions: EMBEDDED() } }), 'Pedido.productos'],
      [(Producto) => {
        const Resumen = objectType('Resumen', () => ({ producto: { type: Producto, extensions: EMBEDDED() } }));
        return { resumen: { type: Resumen, extensions: { ...EMBEDDED(), readOnly: true } } };
      }, 'Resumen.producto'],
    ];
    for (const [fields, path] of cases) {
      const Producto = productType();
      const Pedido = objectType('Pedido', () => fields(Producto));
      const runtime = connectAll(createRuntime(createAdapter()), Producto, Pedido);
      expectError(thrown(() => runtime.createSchema()), invalidModel(EMBEDDED_USE('Producto', path)));
    }
  });

  it('rejects every storage collision with the version field', () => {
    const Fabricante = objectType('Fabricante', () => ({ name: { type: GraphQLString } }));
    const collisions = [
      () => [productType({ fields: () => ({ version: { type: GraphQLInt } }) })],
      () => [productType({ fields: () => ({ fabricante: { type: Fabricante, extensions: ref('version') } }) }), Fabricante],
      () => {
        const { Pedido, Item } = storeTypes();
        Pedido.getFields().items.extensions = ref('version');
        return [Pedido, Item];
      },
      () => {
        const { Item } = storeTypes();
        const Pedido = objectType('Pedido', () => ({
          version: {
            type: new GraphQLList(Item), extensions: { relation: { embedded: false }, readOnly: true }, resolve: () => [],
          },
        }));
        return [Pedido, Item];
      },
    ];
    const messages = [
      COLLISION('Producto', 'Producto already has a field named version; rename that field'),
      COLLISION('Producto', 'Producto.fabricante uses version as its connectionField; choose another one'),
      COLLISION('Item', 'Pedido.items links its items through version; use another connectionField'),
      COLLISION('Item', 'Pedido.version links its items through version; use another connectionField'),
    ];
    collisions.forEach((types, index) => {
      const adapter = createAdapter();
      const runtime = connectAll(createRuntime(adapter), ...types());
      expectError(thrown(() => runtime.createSchema()), invalidModel(messages[index]));
      expect(adapter.prepare).not.toHaveBeenCalled();
    });
  });

  it('rejects any other field typed RecordVersion on registered and embedded types, with or without protection', async () => {
    const { RecordVersion } = await load();
    const cases = [
      [() => [productType({ fields: () => ({ lastVersion: { type: RecordVersion } }) })], 'Producto.lastVersion'],
      [() => [objectType('Pedido', () => ({ versiones: { type: new GraphQLList(new GraphQLNonNull(RecordVersion)) } }))],
        'Pedido.versiones'],
      [() => {
        const Detalle = objectType('Detalle', () => ({ desde: { type: RecordVersion } }));
        return [objectType('Pedido', () => ({ detalle: { type: Detalle, extensions: { ...EMBEDDED(), readOnly: true } } }))];
      }, 'Detalle.desde'],
    ];
    for (const [types, field] of cases) {
      const runtime = connectAll(createRuntime(createAdapter({ writeFeatures: undefined })), ...types());
      expectError(thrown(() => runtime.createSchema()), invalidModel(MISUSE(field)));
    }
  });

  it('requires an adapter that declares writeFeatures.optimisticConcurrency', () => {
    for (const writeFeatures of [undefined, null, {}, { optimisticConcurrency: false }]) {
      const adapter = createAdapter({ writeFeatures });
      const runtime = connectAll(createRuntime(adapter), productType());
      expectError(thrown(() => runtime.createSchema()), invalidModel(UNSUPPORTED('Producto')));
      expect(adapter.prepare).not.toHaveBeenCalled();
    }
    expect(() => connectAll(createRuntime(createAdapter()), productType()).createSchema()).not.toThrow();
  });

  it('validates writeFeatures in createRuntime() and reads them once', () => {
    const invalidFeatures = (message) => ({ code: 'INVALID_WRITE_FEATURES', status: 500, message: `DatabaseAdapter writeFeatures ${message}` });
    for (const writeFeatures of ['yes', 1, true, [], new Map(), () => {}]) {
      expectError(thrown(() => createRuntime(createAdapter({ writeFeatures }))), invalidFeatures('must be a plain object'));
    }
    for (const optimisticConcurrency of ['true', 1, null, {}]) {
      expectError(thrown(() => createRuntime(createAdapter({ writeFeatures: { optimisticConcurrency } }))),
        invalidFeatures('optimisticConcurrency must be a boolean'));
    }
    for (const writeFeatures of [null, {}, Object.create(null), { optimisticConcurrency: undefined },
      { optimisticConcurrency: false }, { optimisticConcurrency: true, batching: 'later' }]) {
      expect(() => createRuntime(createAdapter({ writeFeatures }))).not.toThrow();
    }

    const supported = createAdapter();
    const declared = createRuntime(supported);
    supported.writeFeatures.optimisticConcurrency = false;
    supported.writeFeatures = null;
    expect(() => connectAll(declared, productType()).createSchema()).not.toThrow();

    const unsupported = createAdapter({ writeFeatures: { optimisticConcurrency: false } });
    const undeclared = createRuntime(unsupported);
    unsupported.writeFeatures = { optimisticConcurrency: true };
    expectError(thrown(() => connectAll(undeclared, productType()).createSchema()), invalidModel(UNSUPPORTED('Producto')));
  });

  it('reserves RecordVersion and RecordVersionRef in schemas with protected types, also inside input fields', async () => {
    const AppVersion = () => new GraphQLScalarType({ name: 'RecordVersion' });
    const AppRef = () => new GraphQLInputObjectType({ name: 'RecordVersionRef', fields: { id: { type: GraphQLID } } });
    const cases = [
      [() => [null, AppVersion()], 'RecordVersion', false],
      [() => [AppRef(), GraphQLString], 'RecordVersionRef', false],
      [() => [new GraphQLInputObjectType({ name: 'RenameInput', fields: { version: { type: AppVersion() } } }), GraphQLString],
        'RecordVersion', true],
      [() => [new GraphQLInputObjectType({ name: 'BulkInput', fields: { refs: { type: new GraphQLList(AppRef()) } } }),
        GraphQLString], 'RecordVersionRef', true],
    ];
    for (const [operation, name, hidden] of cases) {
      const adapter = createAdapter();
      const Producto = productType();
      const runtime = connectAll(createRuntime(adapter), Producto);
      runtime.registerMutation('custom', 'custom', ...operation(), () => null);
      expectError(thrown(() => runtime.createSchema()), reservedName(name));
      // A name hidden in an input field is found when the schema is constructed, after injection.
      expect(adapter.prepare).toHaveBeenCalledTimes(hidden ? 1 : 0);
      expect(hasVersionField(Producto)).toBe(hidden);
    }

    const { RecordVersion } = await load();
    const Producto = productType();
    const runtime = connectAll(createRuntime(createAdapter()), Producto);
    const TouchInput = new GraphQLInputObjectType({
      name: 'TouchInput',
      fields: { id: { type: new GraphQLNonNull(GraphQLID) }, version: { type: new GraphQLNonNull(RecordVersion) } },
    });
    runtime.registerMutation('touchProducto', 'touch', TouchInput, Producto, () => null);
    const schema = runtime.createSchema();
    expect(schema.getType('RecordVersion')).toBe(RecordVersion);
    expect(fieldList(schema, 'TouchInput')).toEqual(['id: ID!', 'version: RecordVersion!']);
  });

  it.each([false, true])('excluded protected registrations do not reserve names (nested input: %s)', (nested) => {
    const adapter = createAdapter();
    const Hidden = productType({ name: 'Hidden' });
    const Visible = productType({ name: 'Visible', extensions: {} });
    const runtime = connectAll(createRuntime(adapter), Hidden, Visible);
    const AppVersion = new GraphQLScalarType({ name: 'RecordVersion' });
    const AppRef = new GraphQLInputObjectType({ name: 'RecordVersionRef', fields: { id: { type: GraphQLID } } });
    const input = nested ? new GraphQLInputObjectType({ name: 'CustomInput', fields: { ref: { type: AppRef }, revision: { type: AppVersion } } }) : AppRef;
    runtime.registerMutation('custom', 'custom', input, nested ? GraphQLString : AppVersion, () => null);
    const schema = runtime.createSchema([Visible], [], ['custom']);
    expect(schema.getType('Hidden')).toBeUndefined();
    expect(schema.getType('RecordVersion')).toBe(AppVersion);
    expect(schema.getType('RecordVersionRef')).toBe(AppRef);
    expect(adapter.prepare).toHaveBeenCalledTimes(1);
    expect(adapter.prepare.mock.calls[0][0].map(({ gqltype }) => gqltype)).toContain(Hidden);
    expect(hasVersionField(Hidden)).toBe(true);
    delete Hidden.extensions.concurrency;
    expectError(thrown(() => runtime.createSchema([Visible], [], ['custom'])), invalidModel(REMOVED('Hidden')));
  });

  it.each(['mutation', 'relation', 'custom output'])('pin: reserves both names when included %s reaches protection', (route) => {
    for (const name of ['RecordVersion', 'RecordVersionRef']) for (const nested of [false, true]) {
      const adapter = createAdapter();
      const Hidden = productType({ name: 'Hidden' });
      const Visible = productType({ name: 'Visible', extensions: {}, fields: () => route === 'relation'
        ? { hidden: { type: Hidden, extensions: ref() } } : {} });
      const runtime = connectAll(createRuntime(adapter), Hidden, Visible);
      const appType = name === 'RecordVersion' ? new GraphQLScalarType({ name })
        : new GraphQLInputObjectType({ name, fields: { id: { type: GraphQLID } } });
      const input = nested ? new GraphQLInputObjectType({ name: 'CustomInput', fields: { value: { type: appType } } }) : appType;
      runtime.registerMutation('custom', 'custom', input, route === 'custom output' ? Hidden : GraphQLString, () => null);
      expectError(thrown(() => runtime.createSchema([Visible], route === 'mutation' ? [Hidden] : [], ['custom'])), reservedName(name));
      expect(adapter.prepare).toHaveBeenCalledTimes(nested ? 1 : 0);
    }
  });

  it('pin: a schema without protected types accepts application types named RecordVersion and RecordVersionRef', () => {
    const AppVersion = new GraphQLScalarType({ name: 'RecordVersion' });
    const AppRef = new GraphQLInputObjectType({ name: 'RecordVersionRef', fields: { id: { type: GraphQLID } } });
    const { Autor, Libro, Nodo } = libraryTypes();
    const runtime = connectAll(createRuntime(createAdapter({ writeFeatures: undefined })), Autor, Libro, Nodo);
    runtime.registerMutation('legacy', 'legacy', AppRef, AppVersion, () => null);
    const schema = runtime.createSchema();
    expect(schema.getType('RecordVersion')).toBe(AppVersion);
    expect(schema.getType('RecordVersionRef')).toBe(AppRef);
  });

  it('fixes protection once, across two createSchema() calls both ways and across runtimes', () => {
    const Producto = productType({ extensions: {} });
    const runtime = connectAll(createRuntime(createAdapter()), Producto);
    runtime.createSchema();
    Producto.extensions.concurrency = { mode: 'optimistic' };
    expectError(thrown(() => runtime.createSchema()), invalidModel(TOGGLE('Producto')));
    expectError(thrown(() => connectAll(createRuntime(createAdapter()), Producto).createSchema()),
      invalidModel(TOGGLE('Producto')));

    const Articulo = productType({ name: 'Articulo' });
    const protecting = connectAll(createRuntime(createAdapter()), Articulo);
    protecting.createSchema();
    delete Articulo.extensions.concurrency;
    expectError(thrown(() => protecting.createSchema()), invalidModel(REMOVED('Articulo')));
    expectError(thrown(() => connectAll(createRuntime(createAdapter()), Articulo).createSchema()),
      invalidModel(REMOVED('Articulo')));
    Articulo.extensions.concurrency = { mode: 'pessimistic' };
    expectError(thrown(() => protecting.createSchema()), invalidModel(SHAPE('Articulo')));
    Articulo.extensions.concurrency = { mode: 'optimistic' };
    expect(() => protecting.createSchema()).not.toThrow();
  });

  it('reports inputs retained by a failed createSchema() when protection is added afterwards', () => {
    // Inputs: the first call fails when the schema is constructed, after the inputs were built.
    const Producto = productType({ extensions: {} });
    const runtime = connectAll(createRuntime(createAdapter()), Producto);
    runtime.registerMutation('duplicado', 'duplicado', null, objectType('Producto', () => ({})), () => null);
    expect(() => runtime.createSchema()).toThrow('multiple types named "Producto"');
    Producto.extensions.concurrency = { mode: 'optimistic' };
    expectError(thrown(() => runtime.createSchema()), invalidModel(BUILT('Producto')));
    expect(hasVersionField(Producto)).toBe(false);
  });

  it('reports a generated model retained by a failed createSchema() when protection is added afterwards', () => {
    // A model: the first call fails at a later type's model, after this type's model was created.
    const adapter = createAdapter();
    adapter.createModel.mockImplementation((gqltype) => {
      if (gqltype.name === 'Etiqueta') throw new Error('model failed');
      return { name: gqltype.name };
    });
    const Articulo = productType({ name: 'Articulo', extensions: {} });
    const modelled = connectAll(createRuntime(adapter), Articulo, productType({ name: 'Etiqueta', extensions: {} }));
    expect(() => modelled.createSchema()).toThrow('model failed');
    Articulo.extensions.concurrency = { mode: 'optimistic' };
    expectError(thrown(() => modelled.createSchema()), invalidModel(BUILT('Articulo')));
    expect(hasVersionField(Articulo)).toBe(false);
  });

  it('does not count a supplied model as having built the type without protection', () => {
    // A model supplied to connect() was not built from the type by Simfinity.
    const supplier = createAdapter();
    const supplied = createRuntime(supplier);
    supplied.connect({ name: 'supplied' }, productType({ name: 'Suministrado' }), 'suministrado', 'suministrados');
    expect(fieldList(supplied.createSchema(), 'Suministrado')).toContain('version: RecordVersion!');
    expect(supplier.createModel).not.toHaveBeenCalled();
  });

  it('requires every protected type the schema contains to be registered in this runtime, whatever the adapter supports', () => {
    for (const order of ['before', 'after']) {
      const Producto = productType();
      const owner = connectAll(createRuntime(createAdapter()), Producto);
      if (order === 'after') owner.createSchema();
      const adapter = createAdapter({ writeFeatures: undefined });
      const runtime = connectAll(createRuntime(adapter), objectType('Nota', () => ({ texto: { type: GraphQLString } })));
      const Resultado = objectType('Resultado', () => ({ producto: { type: Producto } }));
      runtime.registerMutation('crearProducto', 'crear', null, Resultado, () => null);
      expectError(thrown(() => runtime.createSchema()), invalidModel(FOREIGN('Producto')));
      expect(adapter.prepare, order).not.toHaveBeenCalled();
      // A schema whose allowlist leaves the mutation out does not contain the type.
      expect(() => runtime.createSchema(undefined, undefined, []), order).not.toThrow();
    }

    const { Pedido, Item } = storeTypes();
    const target = createRuntime(createAdapter());
    target.addNoEndpointType(Item);
    connectAll(target, Pedido);
    target.registerMutation('crearItem', 'crear', null, Item, () => null);
    expect(fieldList(target.createSchema(), 'Item')).toContain('version: RecordVersion!');

    const Producto = productType();
    const first = connectAll(createRuntime(createAdapter()), Producto);
    const second = connectAll(createRuntime(createAdapter()), Producto);
    second.registerMutation('crearProducto', 'crear', null, Producto, () => null);
    first.createSchema();
    expect(fieldList(second.createSchema(), 'Producto')).toContain('version: RecordVersion!');
  });

  it('hints that a version field copied through an extensions spread lost its marker', () => {
    const Producto = productType();
    connectAll(createRuntime(createAdapter()), Producto).createSchema();
    const config = Producto.toConfig();
    // graphql-js copies only the string keys of an extensions object that is not null-prototype.
    const Copia = new GraphQLObjectType({
      ...config,
      fields: () => Object.fromEntries(Object.entries(config.fields)
        .map(([name, field]) => [name, { ...field, extensions: { ...field.extensions } }])),
    });
    const runtime = connectAll(createRuntime(createAdapter()), Copia);
    expectError(thrown(() => runtime.createSchema()), invalidModel(COLLISION('Producto', 'Producto already has a field '
      + 'named version; rename that field. It is typed RecordVersion, so it was probably copied from a protected type '
      + 'without its marker: keep the field\'s extensions object as it is, for example with toConfig()')));
  });

  it('says two copies of core are loaded when the clashing RecordVersion has core\'s description', () => {
    const secondCopy = { code: 'RESERVED_TYPE_NAME', status: 500, message: SECOND_COPY };
    const copy = () => new GraphQLScalarType({ name: 'RecordVersion', description: CORE_DESCRIPTION });
    const cases = [
      [() => [null, copy()], 0],
      [() => [new GraphQLInputObjectType({ name: 'RenameInput', fields: { version: { type: copy() } } }), GraphQLString], 1],
    ];
    for (const [operation, prepared] of cases) {
      const adapter = createAdapter();
      const runtime = connectAll(createRuntime(adapter), productType());
      runtime.registerMutation('custom', 'custom', ...operation(), () => null);
      expectError(thrown(() => runtime.createSchema()), secondCopy);
      expect(adapter.prepare).toHaveBeenCalledTimes(prepared);
    }
  });

  it('records nothing for a failed createSchema(), and keeps a field injected before the failure', () => {
    const adapter = createAdapter();
    adapter.createModel.mockImplementationOnce(() => {
      throw new Error('model failed');
    });
    const Producto = productType({ extensions: {} });
    const runtime = connectAll(createRuntime(adapter), Producto);
    expect(() => runtime.createSchema()).toThrow('model failed');
    Producto.extensions.concurrency = { mode: 'optimistic' };
    expect(fieldList(runtime.createSchema(), 'Producto')).toEqual(['id: ID', 'name: String', 'price: Int', 'version: RecordVersion!']);

    // A failed check records nothing either.
    const Etiqueta = productType({ name: 'Etiqueta', extensions: {} });
    const unsupported = connectAll(createRuntime(createAdapter({ writeFeatures: undefined })), Etiqueta, productType());
    expectError(thrown(() => unsupported.createSchema()), invalidModel(UNSUPPORTED('Producto')));
    Etiqueta.extensions.concurrency = { mode: 'optimistic' };
    expect(() => connectAll(createRuntime(createAdapter()), Etiqueta).createSchema()).not.toThrow();
    expect(hasVersionField(Etiqueta)).toBe(true);

    const failing = createAdapter();
    failing.createModel.mockImplementationOnce(() => {
      throw new Error('model failed');
    });
    const Articulo = productType({ name: 'Articulo' });
    const retried = connectAll(createRuntime(failing), Articulo);
    expect(() => retried.createSchema()).toThrow('model failed');
    const field = Articulo.getFields().version;
    expect(isInjected(field)).toBe(true);
    retried.createSchema();
    expect(Articulo.getFields().version).toBe(field);
    expect(Object.keys(Articulo.getFields())).toEqual(['id', 'name', 'price', 'version']);
  });

  it('describes the version field of registrations before createSchema()', () => {
    const runtime = connectAll(createRuntime(createAdapter()), productType());
    const { entities: [entity] } = describeModels(runtime.getRegistrations());
    expect(entity.fields.map((field) => field.name)).toEqual(['id', 'name', 'price', 'version']);
    expect(entity.fields.at(-1)).toMatchObject({ scalar: 'Version', required: true, readOnly: true, version: true });
  });
});

describe('generated schema', () => {
  it('appends version: RecordVersion! to protected types, read-only in introspection, read from the stored record', async () => {
    const { schema, adapter, Producto } = buildStore();
    expect(fieldList(schema, 'Producto')).toEqual(['id: ID', 'name: String', 'price: Int', 'version: RecordVersion!']);
    expect(fieldList(schema, 'Item')).toEqual(['id: ID', 'nombre: String', 'pedido: Pedido', 'version: RecordVersion!']);
    expect(fieldList(schema, 'Pedido')).toEqual(['id: ID', 'numero: String', 'items: [Item]']);
    const { RecordVersion, isVersionField } = await load();
    expect(schema.getType('RecordVersion')).toBe(RecordVersion);
    const field = Producto.getFields().version;
    expect(isVersionField(field)).toBe(true);
    expect(field.description).toBe('Revision of this record. Send it back unchanged in updates and deletes; Simfinity advances it.');

    const introspection = await run(schema, '{ __type(name: "Producto") { fields { name extensions { readOnly } } } }');
    expect(introspection.data.__type.fields.at(-1)).toEqual({ name: 'version', extensions: { readOnly: true } });

    adapter.seed('Producto', { _id: '1', name: 'legacy' });
    adapter.seed('Producto', { _id: '2', version: 5 });
    adapter.seed('Producto', { _id: '3', version: 7n });
    adapter.seed('Producto', { _id: '4', version: '2' });
    expect(await run(schema, '{ a: producto(id: "1") { version } b: producto(id: "2") { version } c: producto(id: "3") { version } }'))
      .toEqual({ data: { a: { version: 1 }, b: { version: 5 }, c: { version: 7 } } });
    const invalid = await run(schema, '{ producto(id: "4") { id version } }');
    expect(invalid.errors).toHaveLength(1);
    expect(invalid.errors[0].extensions).toMatchObject({ code: 'DATABASE_ERROR', status: 500 });
    expect(invalid.errors[0].message).toBe('Producto 4 stores an invalid version');
  });

  it('leaves version out of create inputs and puts it last in update inputs, after self-referencing collections', () => {
    const { schema } = buildStore();
    expect(fieldList(schema, 'ProductoInput')).toEqual(['name: String', 'price: Int']);
    expect(fieldList(schema, 'ProductoInputForUpdate')).toEqual(['id: ID!', 'name: String', 'price: Int', 'version: RecordVersion!']);
    expect(fieldList(schema, 'CategoriaInput')).toEqual(['name: String', 'padre: IdInputType', 'subcategorias: OneToManyAsubcategorias']);
    expect(fieldList(schema, 'CategoriaInputForUpdate')).toEqual([
      'id: ID!', 'name: String', 'padre: IdInputType', 'subcategorias: OneToManyUsubcategorias', 'version: RecordVersion!',
    ]);
    expect(fieldList(schema, 'PedidoInputForUpdate')).toEqual(['id: ID!', 'numero: String', 'items: OneToManyPedidoUitems']);
  });

  it('adds version to the delete arguments of protected types only', () => {
    const { schema } = buildStore();
    expect(mutationArgs(schema, 'deleteproducto')).toEqual(['id: ID!', 'version: RecordVersion!']);
    expect(mutationArgs(schema, 'deletecategoria')).toEqual(['id: ID!', 'version: RecordVersion!']);
    expect(mutationArgs(schema, 'deletepedido')).toEqual(['id: ID!']);
  });

  it('deletes protected collection items by RecordVersionRef and updates them with a version, under any parent', async () => {
    const { schema } = buildStore();
    expect(fieldList(schema, 'OneToManyPedidoAitems')).toEqual([
      'added: [PedidoAItemInputForPedido]', 'updated: [ItemInputForUpdate]', 'deleted: [RecordVersionRef]',
    ]);
    expect(fieldList(schema, 'OneToManyPedidoUitems')).toEqual([
      'added: [PedidoUItemInputForPedido]', 'updated: [ItemInputForUpdate]', 'deleted: [RecordVersionRef]',
    ]);
    expect(fieldList(schema, 'PedidoAItemInputForPedido')).toEqual(['nombre: String']);
    expect(fieldList(schema, 'ItemInputForUpdate')).toEqual(['id: ID!', 'nombre: String', 'pedido: IdInputType', 'version: RecordVersion!']);
    expect(fieldList(schema, 'OneToManyAsubcategorias')).toEqual([
      'added: [ACategoriaInputForPadre]', 'updated: [CategoriaInputForUpdate]', 'deleted: [RecordVersionRef]',
    ]);
    expect(fieldList(schema, 'OneToManyUsubcategorias')).toEqual([
      'added: [UCategoriaInputForPadre]', 'updated: [CategoriaInputForUpdate]', 'deleted: [RecordVersionRef]',
    ]);
    const { RecordVersionRef } = await load();
    expect(schema.getType('RecordVersionRef')).toBe(RecordVersionRef);
  });

  it('generates no filter for version, and rejects conditions and sorts on it', async () => {
    const { schema, Producto, Pedido } = buildStore();
    expect(Object.keys(Producto.getFields())).toContain('version');
    expect(argList(schema.getQueryType().getFields().productos).map((arg) => arg.split(':')[0]))
      .toEqual(['id', 'name', 'price', 'pagination', 'sort', 'AND', 'OR']);
    expect(Pedido.getFields().items.args.map((arg) => arg.name)).toEqual(['id', 'nombre', 'pagination', 'sort', 'AND', 'OR']);

    const argument = await run(schema, '{ productos(version: { operator: EQ, value: 1 }) { id } }');
    expect(argument.errors[0].extensions).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(argument.errors[0].message).toBe('Unknown argument "version" on field "RootQueryType.productos".');
    for (const source of [
      '{ productos(AND: [{ conditions: [{ field: "version", operator: EQ, value: 1 }] }]) { id } }',
      '{ productos(sort: { terms: [{ field: "version", order: ASC }] }) { id } }',
    ]) {
      const result = await run(schema, source);
      expect(result.errors[0].extensions).toMatchObject({ code: 'FORBIDDEN_FILTER_PATH', status: 403 });
      expect(result.errors[0].message).toBe('Query path version uses the non-queryable field Producto.version');
    }
  });

  it('gives a protected type without writable fields no update input, update mutation, state actions or nested updated entries', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const SelloState = new GraphQLEnumType({ name: 'SelloState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
    const readOnly = { readOnly: true };
    const Pedido = objectType('Pedido', () => ({
      numero: { type: GraphQLString },
      sellos: { type: new GraphQLList(Sello), extensions: ref('pedido') },
    }));
    const Sello = new GraphQLObjectType({
      name: 'Sello',
      extensions: OPTIMISTIC(),
      fields: () => ({
        id: { type: GraphQLID, extensions: readOnly },
        codigo: { type: GraphQLString, extensions: readOnly },
        state: { type: SelloState },
        pedido: { type: Pedido, extensions: { ...ref(), readOnly: true } },
      }),
    });
    const runtime = connectAll(createRuntime(createAdapter()), Pedido);
    runtime.connect(null, Sello, 'sello', 'sellos', null, null, {
      initialState: SelloState.getValue('OPEN'),
      actions: { close: { from: SelloState.getValue('OPEN'), to: SelloState.getValue('CLOSED') } },
    });
    const schema = runtime.createSchema();
    expect(fieldList(schema, 'Sello')).toEqual(['id: ID', 'codigo: String', 'state: SelloState', 'pedido: Pedido', 'version: RecordVersion!']);
    expect(schema.getType('SelloInputForUpdate')).toBeUndefined();
    const mutations = Object.keys(schema.getMutationType().getFields());
    expect(mutations).not.toContain('updatesello');
    expect(mutations).not.toContain('close_sello');
    expect(mutationArgs(schema, 'deletesello')).toEqual(['id: ID!', 'version: RecordVersion!']);
    expect(fieldList(schema, 'OneToManyPedidoUsellos')).toEqual(['deleted: [RecordVersionRef]']);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('the schema has no updatesello mutation and no state machine actions'));
  });

  it('reports an invalid stored version under the type being resolved, also for a renamed copy', async () => {
    const Producto = productType();
    connectAll(createRuntime(createAdapter()), Producto).createSchema();
    const Mercaderia = new GraphQLObjectType({ ...Producto.toConfig(), name: 'Mercaderia' });
    const adapter = createAdapter();
    const schema = connectAll(createRuntime(adapter), Mercaderia).createSchema();
    adapter.seed('Mercaderia', { _id: '9', version: 'x' });
    const result = await run(schema, '{ mercaderia(id: "9") { version } }');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].extensions).toMatchObject({ code: 'DATABASE_ERROR', status: 500 });
    expect(result.errors[0].message).toBe('Mercaderia 9 stores an invalid version');
  });

  it('pin: a schema without protected types prints byte-identical SDL', () => {
    const { Autor, Libro, Nodo } = libraryTypes();
    const schema = connectAll(createRuntime(createAdapter({ writeFeatures: undefined })), Autor, Libro, Nodo).createSchema();
    expect(printSchema(schema)).toBe(UNPROTECTED_SDL);
  });

  it('pin: types neither protected nor owning protected items print the same next to protected types', () => {
    const rootFields = (schema) => Object.fromEntries([schema.getQueryType(), schema.getMutationType()]
      .flatMap((root) => Object.values(root.getFields()))
      .map((field) => [field.name, `(${argList(field).join(', ')}): ${field.type}`]));
    const alone = libraryTypes();
    const unprotected = connectAll(createRuntime(createAdapter()), ...Object.values(alone)).createSchema();
    const together = libraryTypes();
    const mixed = connectAll(createRuntime(createAdapter()), ...Object.values(together), ...Object.values(storeTypes())).createSchema();
    const roots = [unprotected.getQueryType().name, unprotected.getMutationType().name];
    for (const [name, type] of Object.entries(unprotected.getTypeMap())) {
      if (roots.includes(name) || name.startsWith('__')) continue;
      expect(printType(mixed.getType(name)), name).toBe(printType(type));
    }
    const mixedRoots = rootFields(mixed);
    for (const [name, printed] of Object.entries(rootFields(unprotected))) expect(mixedRoots[name], name).toBe(printed);
  });

  it('injects the field once: two createSchema() calls, a toConfig() copy, an extensions spread, a second runtime', async () => {
    const Producto = productType();
    const runtime = connectAll(createRuntime(createAdapter()), Producto);
    const first = runtime.createSchema();
    const field = Producto.getFields().version;
    const second = runtime.createSchema();
    expect(Producto.getFields().version).toBe(field);
    expect(printType(second.getType('Producto'))).toBe(printType(first.getType('Producto')));

    const copy = new GraphQLObjectType(Producto.toConfig());
    const copyAdapter = createAdapter();
    const copied = connectAll(createRuntime(copyAdapter), copy).createSchema();
    expect(isInjected(copy.getFields().version)).toBe(true);
    expect(fieldList(copied, 'Producto')).toEqual(['id: ID', 'name: String', 'price: Int', 'version: RecordVersion!']);
    copyAdapter.seed('Producto', { _id: '1', version: 3 });
    expect(await run(copied, '{ producto(id: "1") { version } }')).toEqual({ data: { producto: { version: 3 } } });

    field.extensions = { ...field.extensions, note: 'kept' };
    runtime.createSchema();
    const sharedAdapter = createAdapter();
    const shared = connectAll(createRuntime(sharedAdapter), Producto).createSchema();
    expect(Producto.getFields().version).toBe(field);
    expect(fieldList(shared, 'Producto')).toEqual(['id: ID', 'name: String', 'price: Int', 'version: RecordVersion!']);
    sharedAdapter.seed('Producto', { _id: '1' });
    expect(await run(shared, '{ producto(id: "1") { version } }')).toEqual({ data: { producto: { version: 1 } } });
  });
});

describe('clients sending the wrong shape (Review Focus 4)', () => {
  const expectBadRequest = (result, message) => {
    expect(result.data ?? null).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].extensions).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(result.errors[0].message).toBe(message);
  };

  it('rejects a version sent as the string "7" in variables', async () => {
    const { schema } = buildStore();
    expectBadRequest(await run(schema, 'mutation ($id: ID!, $version: RecordVersion!) { deleteproducto(id: $id, version: $version) { id } }',
      { id: '1', version: '7' }), `Variable "$version" got invalid value "7"; Expected type "RecordVersion". ${RANGE}`);
    expectBadRequest(await run(schema, 'mutation ($input: ProductoInputForUpdate!) { updateproducto(input: $input) { id } }',
      { input: { id: '1', name: 'x', version: '7' } }),
    `Variable "$input" got invalid value "7" at "input.version"; Expected type "RecordVersion". ${RANGE}`);
  });

  it('rejects a nested updated entry without version, and a deleted ID without one, under an unprotected parent', async () => {
    const { schema } = buildStore();
    const update = 'mutation ($input: PedidoInputForUpdate!) { updatepedido(input: $input) { id } }';
    expectBadRequest(await run(schema, update, { input: { id: '1', items: { updated: [{ id: '2', nombre: 'x' }] } } }),
      'Variable "$input" got invalid value { id: "2", nombre: "x" } at "input.items.updated[0]"; '
        + 'Field "version" of required type "RecordVersion!" was not provided.');
    expectBadRequest(await run(schema, update, { input: { id: '1', items: { deleted: ['2'] } } }),
      'Variable "$input" got invalid value "2" at "input.items.deleted[0]"; Expected type "RecordVersionRef" to be an object.');
  });

  it.each(['updated', 'deleted'])('accepts null entries around versioned %s entries during input coercion', (operation) => {
    const { schema } = buildStore();
    const errors = [];
    const coerced = coerceInputValue({
      id: '1', items: { [operation]: [null, { id: '2', version: 7 }, null] },
    }, schema.getType('PedidoInputForUpdate'), (_path, _value, error) => errors.push(error.message));
    expect(errors).toEqual([]);
    expect(coerced).toEqual({ id: '1', items: { [operation]: [null, { id: '2', version: 7 }, null] } });
  });
});

// printSchema() of libraryTypes() with collection frames, before optimistic concurrency.
const UNPROTECTED_SDL = `schema {
  query: RootQueryType
  mutation: Mutation
}

type RootQueryType {
  autor(id: ID): Autor
  autors(id: QLFilter, nombre: QLFilter, libros: QLTypeFilterExpression, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup]): [Autor]
  autors_aggregate(id: QLFilter, nombre: QLFilter, libros: QLTypeFilterExpression, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup], aggregation: QLTypeAggregationExpression!): [QLTypeAggregationResult]
  libro(id: ID): Libro
  libros(id: QLFilter, titulo: QLFilter, paginas: QLFilter, autor: QLTypeFilterExpression, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup]): [Libro]
  libros_aggregate(id: QLFilter, titulo: QLFilter, paginas: QLFilter, autor: QLTypeFilterExpression, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup], aggregation: QLTypeAggregationExpression!): [QLTypeAggregationResult]
  nodo(id: ID): Nodo
  nodos(id: QLFilter, etiqueta: QLFilter, padre: QLTypeFilterExpression, hijos: QLTypeFilterExpression, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup]): [Nodo]
  nodos_aggregate(id: QLFilter, etiqueta: QLFilter, padre: QLTypeFilterExpression, hijos: QLTypeFilterExpression, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup], aggregation: QLTypeAggregationExpression!): [QLTypeAggregationResult]
}

type Autor {
  id: ID
  nombre: String!
  libros(id: QLFilter, titulo: QLFilter, paginas: QLFilter, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup]): [Libro]
}

type Libro {
  id: ID
  titulo: String
  paginas: Int
  autor: Autor
}

input QLFilter {
  operator: QLOperator
  value: QLValue

  """Compare with a stored field path; mutually exclusive with value."""
  valuePath: String
}

enum QLOperator {
  EQ
  LT
  GT
  LTE
  GTE
  BTW
  NE
  IN
  NIN
  LIKE
  ILIKE
  STARTS_WITH
  ISTARTS_WITH
  ENDS_WITH
  IENDS_WITH
  IEQ
  IS_EMPTY
  IS_NOT_EMPTY
  CONTAINS_ALL
  IIN
}

scalar QLValue

input QLPagination {
  page: Int!
  size: Int!
  count: Boolean
}

input QLSortExpression {
  terms: [QLSort]
}

input QLSort {
  field: String!
  order: QLSortOrder!
}

enum QLSortOrder {
  DESC
  ASC
}

input QLFilterGroup {
  ANY: [QLQuantifiedGroup]
  ALL: [QLQuantifiedGroup]
  NONE: [QLQuantifiedGroup]
  AND: [QLFilterGroup]
  OR: [QLFilterGroup]
  conditions: [QLFilterCondition]
}

input QLQuantifiedGroup {
  path: String!
  AND: [QLFilterGroup]
  OR: [QLFilterGroup]
  ANY: [QLQuantifiedGroup]
  ALL: [QLQuantifiedGroup]
  NONE: [QLQuantifiedGroup]
  conditions: [QLFilterCondition]
}

input QLFilterCondition {
  field: String!
  operator: QLOperator
  value: QLValue

  """Compare with a stored field path; mutually exclusive with value."""
  valuePath: String
  path: String
}

input QLTypeFilterExpression {
  terms: [QLTypeFilter]
  quantifier: QLQuantifier
}

input QLTypeFilter {
  operator: QLOperator
  value: QLValue

  """Compare with a stored field path; mutually exclusive with value."""
  valuePath: String
  path: String
}

enum QLQuantifier {
  ANY
  ALL
  NONE
}

type QLTypeAggregationResult {
  groupId: JSON
  facts: JSON
}

"""The \`JSON\` scalar type represents JSON values as specified by ECMA-404"""
scalar JSON

input QLTypeAggregationExpression {
  groupId: String!
  facts: [QLTypeAggregationFact!]!
}

input QLTypeAggregationFact {
  operation: QLAggregationOperation!
  factName: String!
  path: String!
}

enum QLAggregationOperation {
  SUM
  COUNT
  AVG
  MIN
  MAX
}

type Nodo {
  id: ID
  etiqueta: String
  padre: Nodo
  hijos(id: QLFilter, etiqueta: QLFilter, hijos: QLTypeFilterExpression, pagination: QLPagination, sort: QLSortExpression, AND: [QLFilterGroup], OR: [QLFilterGroup]): [Nodo]
}

type Mutation {
  """add"""
  addautor(input: AutorInput!): Autor

  """delete"""
  deleteautor(id: ID!): Autor

  """add"""
  addlibro(input: LibroInput!): Libro

  """delete"""
  deletelibro(id: ID!): Libro

  """add"""
  addnodo(input: NodoInput!): Nodo

  """delete"""
  deletenodo(id: ID!): Nodo

  """update"""
  updateautor(input: AutorInputForUpdate!): Autor

  """update"""
  updatelibro(input: LibroInputForUpdate!): Libro

  """update"""
  updatenodo(input: NodoInputForUpdate!): Nodo
}

input AutorInput {
  nombre: String!
  libros: OneToManyAutorAlibros
}

input OneToManyAutorAlibros {
  added: [AutorALibroInputForAutor]
  updated: [LibroInputForUpdate]
  deleted: [ID]
}

input AutorALibroInputForAutor {
  titulo: String
  paginas: Int
}

input LibroInputForUpdate {
  id: ID!
  titulo: String
  paginas: Int
  autor: IdInputType
}

input IdInputType {
  id: String!
}

input LibroInput {
  titulo: String
  paginas: Int
  autor: IdInputType
}

input NodoInput {
  etiqueta: String
  padre: IdInputType
  hijos: OneToManyAhijos
}

input OneToManyAhijos {
  added: [ANodoInputForPadre]
  updated: [NodoInputForUpdate]
  deleted: [ID]
}

input ANodoInputForPadre {
  etiqueta: String
  hijos: OneToManyAhijos
}

input NodoInputForUpdate {
  id: ID!
  etiqueta: String
  padre: IdInputType
  hijos: OneToManyUhijos
}

input OneToManyUhijos {
  added: [UNodoInputForPadre]
  updated: [NodoInputForUpdate]
  deleted: [ID]
}

input UNodoInputForPadre {
  etiqueta: String
  hijos: OneToManyAhijos
}

input AutorInputForUpdate {
  id: ID!
  nombre: String
  libros: OneToManyAutorUlibros
}

input OneToManyAutorUlibros {
  added: [AutorULibroInputForAutor]
  updated: [LibroInputForUpdate]
  deleted: [ID]
}

input AutorULibroInputForAutor {
  titulo: String
  paginas: Int
}

type FieldExtensionsType {
  relation: RelationType
  stateMachine: Boolean
  readOnly: Boolean
}

type RelationType {
  embedded: Boolean
  connectionField: String
  displayField: String
}`;


describe('named views with optimistic concurrency', () => {
  it.each([true, false])('rejects a managed version param before preparation (included: %s)', (included) => {
    const adapter = createAdapter();
    const Producto = productType();
    const runtime = connectAll(createRuntime(adapter), Producto);
    runtime.registerView('currentProducts', {
      type: Producto, description: 'Current products', params: { version: { type: GraphQLInt } }, where: () => [],
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expectError(thrown(() => runtime.createSchema(included ? undefined : [])), {
        code: 'INVALID_VIEW',
        status: 500,
        message: 'registerView currentProducts param version has the name of a field of Producto',
      });
      expect(adapter.prepare).not.toHaveBeenCalled();
      expect(adapter.createModel).not.toHaveBeenCalled();
      expect(hasVersionField(Producto)).toBe(false);
    }
  });

  it.each(['RecordVersion', 'RecordVersionRef'])('rejects an included view param type named %s before preparation', (name) => {
    const adapter = createAdapter();
    const Producto = productType();
    const runtime = connectAll(createRuntime(adapter), Producto);
    runtime.registerView('currentProducts', {
      type: Producto, description: 'Current products',
      params: { revision: { type: new GraphQLNonNull(new GraphQLScalarType({ name })) } }, where: () => [],
    });
    expectError(thrown(() => runtime.createSchema()), reservedName(name));
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
    expect(hasVersionField(Producto)).toBe(false);
  });

  it('does not reserve a param type from an excluded view', () => {
    const adapter = createAdapter();
    const Hidden = productType({ name: 'Hidden' });
    const Visible = productType({ name: 'Visible', extensions: {} });
    const runtime = connectAll(createRuntime(adapter), Hidden, Visible);
    runtime.registerView('visibleProducts', {
      type: Visible, description: 'Visible products',
      params: { revision: { type: new GraphQLScalarType({ name: 'RecordVersion' }) } }, where: () => [],
    });
    const schema = runtime.createSchema([Hidden], []);
    expect(schema.getQueryType().getFields().visibleProducts).toBeUndefined();
    expect(hasVersionField(Hidden)).toBe(true);
  });

  it('does not reserve a view param type when protection is excluded', () => {
    const adapter = createAdapter();
    const Hidden = productType({ name: 'Hidden' });
    const Visible = productType({ name: 'Visible', extensions: {} });
    const runtime = connectAll(createRuntime(adapter), Hidden, Visible);
    const AppVersion = new GraphQLScalarType({ name: 'RecordVersion' });
    runtime.registerView('visibleProducts', {
      type: Visible, description: 'Visible products', params: { revision: { type: AppVersion } }, where: () => [],
    });
    const schema = runtime.createSchema([Visible], []);
    expect(schema.getType('RecordVersion')).toBe(AppVersion);
    expect(schema.getType('Hidden')).toBeUndefined();
  });

  it('keeps version params on unprotected views across repeated schemas', () => {
    const adapter = createAdapter();
    const Producto = productType({ extensions: {} });
    const runtime = connectAll(createRuntime(adapter), Producto);
    runtime.registerView('currentProducts', {
      type: Producto, description: 'Current products', params: { version: { type: GraphQLInt } }, where: () => [],
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const schema = runtime.createSchema();
      expect(schema.getQueryType().getFields().currentProducts.args.find(({ name }) => name === 'version').type).toBe(GraphQLInt);
      expect(hasVersionField(Producto)).toBe(false);
    }
  });

  it('returns the managed version through a named view', async () => {
    const adapter = createAdapter();
    adapter.find = async () => [{ _id: '1', name: 'Current', version: 7 }];
    const Producto = productType();
    const runtime = connectAll(createRuntime(adapter), Producto);
    runtime.registerView('currentProducts', { type: Producto, description: 'Current products', where: () => [] });
    const schema = runtime.createSchema();
    const result = await graphql({ schema, source: '{ currentProducts { id version } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data.currentProducts).toEqual([{ id: '1', version: 7 }]);
  });
});

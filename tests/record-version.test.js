import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLError, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType,
  GraphQLScalarType, GraphQLSchema, GraphQLString, Kind, graphql, printType,
} from 'graphql';
import { buildErrorFormatter, SimfinityError } from '@simtlix/simfinity-core';
import { describeModels } from '../packages/core/src/metadata.js';

// Loaded on use, so that on a checkout without the subpath each test fails by itself, not the whole file.
const RECORD_VERSION_MODULE = '@simtlix/simfinity-core/internal/record-version';
const load = () => import(/* @vite-ignore */ RECORD_VERSION_MODULE);

const MAX = Number.MAX_SAFE_INTEGER;
const RANGE = 'an integer from 1 to 9007199254740991';
const SHAPE_MESSAGE = 'Producto extensions.concurrency must be { mode: \'optimistic\' }';
const concurrency = { concurrency: { mode: 'optimistic' } };
const relation = (connectionField, embedded = false) => ({ relation: { connectionField, embedded } });

const thrown = (callback) => {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
};
const expectSimfinityError = (error, code, status, message) => {
  expect(error).toBeInstanceOf(SimfinityError);
  expect(error.extensions).toMatchObject({ code, status });
  expect(error.message).toBe(message);
};
const expectInvalidModel = (callback, message) => expectSimfinityError(thrown(callback), 'INVALID_MODEL', 400, message);

const protectedType = (name, fields = {}, extensions = concurrency) => new GraphQLObjectType({
  name,
  extensions,
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, ...fields },
});
// What createSchema() does to a protected type in Task 2: the field goes into the map getFields() caches.
const inject = async (type) => {
  const { createVersionFieldConfig } = await load();
  type.getFields().version = createVersionFieldConfig(() => 1);
  return type;
};
const VERSION = {
  name: 'version', storageName: 'version', kind: 'scalar', scalar: 'Version', required: true,
  list: false, itemRequired: false, unique: false, readOnly: true, version: true,
};
const COLLISION = (type, tail) => `${type} declares optimistic concurrency, so Simfinity adds its version field, but ${tail}`;
// What the collision of a field named version adds when the field is typed RecordVersion: it is most likely the
// injected field, copied without its marker.
const COPIED = '. It is typed RecordVersion, so it was probably copied from a protected type without its marker: keep '
  + 'the field\'s extensions object as it is, for example with toConfig()';

it('omits a null identity from the invalid stored-version diagnostic', async () => {
  const { readStoredVersion } = await load();
  expectSimfinityError(thrown(() => readStoredVersion('2', { typeName: 'T', id: null })),
    'DATABASE_ERROR', 500, 'T stores an invalid version');
});

describe('RecordVersion scalar', () => {
  it('is one scalar of the documented name and description', async () => {
    const { RecordVersion, MAX_RECORD_VERSION } = await load();
    expect(RecordVersion).toBeInstanceOf(GraphQLScalarType);
    expect(RecordVersion.name).toBe('RecordVersion');
    expect(RecordVersion.description).toBe('Revision of a record with optimistic concurrency. Send it back unchanged in updates and deletes; Simfinity advances it.');
    expect(MAX_RECORD_VERSION).toBe(MAX);
  });

  it('serializes safe integers from 1 to the maximum, as numbers, and a bigint as a number', async () => {
    const { RecordVersion } = await load();
    expect(RecordVersion.serialize(1)).toBe(1);
    expect(RecordVersion.serialize(MAX)).toBe(MAX);
    expect(RecordVersion.serialize(7n)).toBe(7);
    expect(RecordVersion.serialize(BigInt(MAX))).toBe(MAX);
  });

  it.each([
    [0, '0'], [-1, '-1'], [MAX + 1, String(MAX + 1)], [1.5, '1.5'], [Number.NaN, 'NaN'], ['7', '"7"'], [null, 'null'],
    [undefined, 'undefined'], [true, 'true'], [0n, '0'], [BigInt(MAX) + 1n, String(BigInt(MAX) + 1n)],
  ])('refuses to serialize %s', async (value, shown) => {
    const { RecordVersion } = await load();
    const error = thrown(() => RecordVersion.serialize(value));
    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.message).toBe(`RecordVersion cannot represent ${shown}`);
  });

  it('shows a value that cannot be converted to text by its type', async () => {
    const { RecordVersion } = await load();
    expect(thrown(() => RecordVersion.serialize(Object.create(null))).message).toBe('RecordVersion cannot represent object');
  });

  it('parses only numbers that are safe integers from 1 to the maximum', async () => {
    const { RecordVersion } = await load();
    expect(RecordVersion.parseValue(1)).toBe(1);
    expect(RecordVersion.parseValue(MAX)).toBe(MAX);
    for (const value of [0, -1, MAX + 1, 1.5, Number.NaN, Infinity, '7', null, undefined, true, 7n, {}, []]) {
      const error = thrown(() => RecordVersion.parseValue(value));
      expect(error, String(value)).toBeInstanceOf(TypeError);
      expect(error.message).toBe(`RecordVersion must be ${RANGE}`);
    }
  });

  it('parses only integer literals that pass the same check', async () => {
    const { RecordVersion } = await load();
    expect(RecordVersion.parseLiteral({ kind: Kind.INT, value: '1' })).toBe(1);
    expect(RecordVersion.parseLiteral({ kind: Kind.INT, value: String(MAX) })).toBe(MAX);
    const rejected = [
      { kind: Kind.INT, value: '0' }, { kind: Kind.INT, value: '-1' }, { kind: Kind.INT, value: '-0' },
      { kind: Kind.INT, value: '9007199254740992' }, { kind: Kind.INT, value: '9007199254740993' },
      { kind: Kind.FLOAT, value: '1.0' }, { kind: Kind.STRING, value: '7' }, { kind: Kind.BOOLEAN, value: true },
      { kind: Kind.NULL }, { kind: Kind.ENUM, value: 'ONE' },
    ];
    for (const node of rejected) {
      const error = thrown(() => RecordVersion.parseLiteral(node));
      expect(error, JSON.stringify(node)).toBeInstanceOf(GraphQLError);
      expect(error.message).toBe(`RecordVersion must be ${RANGE}`);
    }
  });

  it('fails GraphQL coercion for a rejected value, reported as BAD_REQUEST, and accepts the bounds', async () => {
    const { RecordVersion } = await load();
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          echo: {
            type: RecordVersion,
            args: { version: { type: new GraphQLNonNull(RecordVersion) } },
            resolve: (_, { version }) => version,
          },
          stored: { type: RecordVersion, args: { value: { type: GraphQLString } }, resolve: (_, { value }) => ({ big: 7n, zero: 0 })[value] },
        },
      }),
    });
    const run = (source, variableValues) => graphql({ schema, source, variableValues });
    expect((await run('{ echo(version: 7) }')).data).toEqual({ echo: 7 });
    expect((await run(`{ echo(version: ${MAX}) }`)).data).toEqual({ echo: MAX });
    expect((await run('query($v: RecordVersion!) { echo(version: $v) }', { v: MAX })).data).toEqual({ echo: MAX });
    const formatted = buildErrorFormatter();
    for (const result of [
      await run('{ echo(version: 0) }'),
      await run(`{ echo(version: ${MAX + 1}) }`),
      await run('{ echo(version: 1.5) }'),
      await run('{ echo(version: "7") }'),
      await run('query($v: RecordVersion!) { echo(version: $v) }', { v: '7' }),
      await run('query($v: RecordVersion!) { echo(version: $v) }', { v: 0 }),
      await run('query($v: RecordVersion!) { echo(version: $v) }', { v: MAX + 1 }),
      await run('query($v: RecordVersion!) { echo(version: $v) }', {}),
    ]) {
      expect(result.data ?? null).toBeNull();
      expect(formatted(result.errors[0]).extensions).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    }
    expect((await run('{ stored(value: "big") }')).data).toEqual({ stored: 7 });
    expect((await run('{ stored(value: "zero") }')).errors[0].message).toBe('RecordVersion cannot represent 0');
  });
});

describe('RecordVersionRef', () => {
  it('is one input object of an ID and a version, both required', async () => {
    const { RecordVersion, RecordVersionRef } = await load();
    expect(RecordVersionRef).toBeInstanceOf(GraphQLInputObjectType);
    expect(RecordVersionRef.name).toBe('RecordVersionRef');
    const fields = RecordVersionRef.getFields();
    expect(Object.keys(fields)).toEqual(['id', 'version']);
    expect(fields.id.type).toEqual(new GraphQLNonNull(GraphQLID));
    expect(fields.version.type.ofType).toBe(RecordVersion);
    expect(fields.version.type).toBeInstanceOf(GraphQLNonNull);
  });
});

describe('readStoredVersion', () => {
  const context = { typeName: 'Producto', id: 'p1' };

  it('reads a missing or null version as 1', async () => {
    const { readStoredVersion } = await load();
    expect(readStoredVersion(undefined, context)).toBe(1);
    expect(readStoredVersion(null, context)).toBe(1);
    expect(readStoredVersion(undefined)).toBe(1);
  });

  it('returns safe integers from 1 to the maximum, and a bigint, as numbers', async () => {
    const { readStoredVersion } = await load();
    expect(readStoredVersion(1, context)).toBe(1);
    expect(readStoredVersion(41, context)).toBe(41);
    expect(readStoredVersion(MAX, context)).toBe(MAX);
    expect(readStoredVersion(5n, context)).toBe(5);
    expect(readStoredVersion(BigInt(MAX), context)).toBe(MAX);
  });

  it.each([
    ['a string', '2'], ['a dotted string', '1.0.3'], ['zero', 0], ['a negative number', -3], ['a float', 2.5], ['NaN', Number.NaN],
    ['a number above the maximum', MAX + 1], ['a bigint above the maximum', BigInt(MAX) + 1n], ['a bigint of zero', 0n],
    ['a boolean', true], ['an object', {}], ['an array', [1]],
    ['a Long', mongoose.mongo.Long.fromNumber(2)], ['a Decimal128', mongoose.mongo.Decimal128.fromString('2')],
  ])('refuses %s as a stored version', async (_, value) => {
    const { readStoredVersion } = await load();
    expectSimfinityError(thrown(() => readStoredVersion(value, context)), 'DATABASE_ERROR', 500, 'Producto p1 stores an invalid version');
  });

  it('names the record only as far as the caller knows it', async () => {
    const { readStoredVersion } = await load();
    expect(thrown(() => readStoredVersion('2', { typeName: 'Producto' })).message).toBe('Producto stores an invalid version');
    expect(thrown(() => readStoredVersion('2')).message).toBe('Record stores an invalid version');
    expect(thrown(() => readStoredVersion('2')).extensions).toMatchObject({ code: 'DATABASE_ERROR', status: 500 });
  });
});

describe('assertVersionInput', () => {
  it('returns a number that is a safe integer from 1 to the maximum', async () => {
    const { assertVersionInput } = await load();
    expect(assertVersionInput(1)).toBe(1);
    expect(assertVersionInput(MAX)).toBe(MAX);
  });

  it.each([[undefined], [null]])('reports %s as a missing value', async (value) => {
    const { assertVersionInput } = await load();
    expectSimfinityError(thrown(() => assertVersionInput(value)), 'REQUIRED_VALUE', 400, 'Required value version is missing');
  });

  it.each([['7'], [0], [-1], [1.5], [Number.NaN], [MAX + 1], [7n], [true], [{}], [[1]]])('reports %s as an invalid version', async (value) => {
    const { assertVersionInput } = await load();
    expectSimfinityError(
      thrown(() => assertVersionInput(value)),
      'INVALID_VERSION',
      400,
      `Invalid value for version: expected ${RANGE}`,
    );
  });
});

describe('version errors', () => {
  it.each([
    ['versionConflictError', ['Producto', 'p1'], 'Producto p1 was modified by another operation', 'VERSION_CONFLICT', 409],
    ['versionExhaustedError', ['Producto', 'p1'], 'Producto p1 has reached the maximum version', 'VERSION_EXHAUSTED', 409],
    ['versionManagedError', ['Producto', 'onUpdating'], 'Producto.version is managed by Simfinity; onUpdating cannot set it', 'VERSION_MANAGED', 500],
    ['unadvancedVersionError', ['Producto', 'p1'], 'Producto p1 was written without advancing its version', 'DATABASE_ERROR', 500],
    ['unexpectedDeleteError', ['Producto', 'p1'], 'Producto p1 was deleted at another version', 'DATABASE_ERROR', 500],
  ])('%s builds a SimfinityError with its code, status and message', async (factory, args, message, code, status) => {
    const module = await load();
    const error = module[factory](...args);
    expect(error).toBeInstanceOf(SimfinityError);
    expect(error.extensions).toMatchObject({ code, status });
    expect(error.getCode()).toBe(code);
    expect(error.getStatus()).toBe(status);
    expect(error.message).toBe(message);
  });

  it('carries no stored version or other data in a conflict', async () => {
    const { versionConflictError } = await load();
    expect(Object.keys(versionConflictError('Producto', 'p1').extensions).sort()).toEqual(['code', 'status', 'timestamp']);
  });
});

describe('concurrencyDeclared', () => {
  it('is false for a type that does not declare it', async () => {
    const { concurrencyDeclared } = await load();
    expect(concurrencyDeclared(new GraphQLObjectType({ name: 'Plain', fields: { id: { type: GraphQLID } } }))).toBe(false);
    expect(concurrencyDeclared(protectedType('Empty', {}, {}))).toBe(false);
    expect(concurrencyDeclared(protectedType('Undefined', {}, { concurrency: undefined }))).toBe(false);
  });

  it('is true for { mode: "optimistic" }, also from a null-prototype object', async () => {
    const { concurrencyDeclared } = await load();
    expect(concurrencyDeclared(protectedType('Producto'))).toBe(true);
    expect(concurrencyDeclared(protectedType('Bare', {}, { concurrency: Object.assign(Object.create(null), { mode: 'optimistic' }) }))).toBe(true);
  });

  const inherited = Object.create({ mode: 'optimistic' });
  const hidden = { mode: 'optimistic' };
  Object.defineProperty(hidden, 'extra', { value: true, enumerable: false });
  it.each([
    ['null', null], ['an array', ['optimistic']], ['a string', 'optimistic'], ['true', true], ['an empty object', {}],
    ['another mode', { mode: 'pessimistic' }], ['an undefined mode', { mode: undefined }], ['a mode in other case', { mode: 'Optimistic' }],
    ['an extra key', { mode: 'optimistic', retries: 3 }], ['a hidden extra key', hidden],
    ['a symbol key', { mode: 'optimistic', [Symbol('extra')]: true }], ['an inherited mode', inherited],
    ['a class instance', new (class Declaration { mode = 'optimistic'; })()],
  ])('rejects %s with INVALID_MODEL', async (_, declaration) => {
    const { concurrencyDeclared } = await load();
    expectInvalidModel(
      () => concurrencyDeclared(protectedType('Producto', {}, { concurrency: declaration })),
      SHAPE_MESSAGE,
    );
  });
});

describe('the version field', () => {
  it('builds the graphql-js field object with null-prototype extensions', async () => {
    const { RecordVersion, RECORD_VERSION_FIELD, createVersionFieldConfig, isVersionField } = await load();
    expect(RECORD_VERSION_FIELD).toBe(Symbol.for('simfinity.recordVersionField'));
    const resolve = () => 1;
    const field = createVersionFieldConfig(resolve);
    expect(Object.keys(field)).toEqual(['name', 'description', 'type', 'args', 'resolve', 'deprecationReason', 'extensions', 'astNode']);
    expect(field).toMatchObject({
      name: 'version',
      description: 'Revision of this record. Send it back unchanged in updates and deletes; Simfinity advances it.',
      args: [],
      resolve,
      deprecationReason: undefined,
      astNode: undefined,
    });
    expect(field.type).toBeInstanceOf(GraphQLNonNull);
    expect(field.type.ofType).toBe(RecordVersion);
    expect(Object.getPrototypeOf(field.extensions)).toBeNull();
    expect(field.extensions.readOnly).toBe(true);
    expect(field.extensions.queryable).toBe(false);
    expect(field.extensions[RECORD_VERSION_FIELD]).toBe(true);
    expect(Reflect.ownKeys(field.extensions)).toHaveLength(3);
    expect(isVersionField(field)).toBe(true);
  });

  it('gives each field its own extensions', async () => {
    const { createVersionFieldConfig } = await load();
    expect(createVersionFieldConfig(() => 1).extensions).not.toBe(createVersionFieldConfig(() => 1).extensions);
  });

  it('recognizes the marker only', async () => {
    const { RecordVersion, createVersionFieldConfig, isVersionField } = await load();
    const field = createVersionFieldConfig(() => 1);
    expect(isVersionField({ ...field, extensions: { ...field.extensions } })).toBe(true);
    for (const other of [
      undefined, null, {}, { extensions: null }, { extensions: { readOnly: true } },
      { name: 'version', type: new GraphQLNonNull(RecordVersion), extensions: { readOnly: true, queryable: false } },
    ]) expect(isVersionField(other)).toBe(false);
  });

  it('is carried by a type, printed, resolved and kept by a toConfig() copy', async () => {
    const { createVersionFieldConfig, isVersionField } = await load();
    const type = protectedType('Producto');
    type.getFields().version = createVersionFieldConfig((record) => record.version ?? 1);
    expect(Object.keys(type.getFields())).toEqual(['id', 'name', 'version']);
    expect(printType(type)).toContain('version: RecordVersion!');
    const copy = new GraphQLObjectType(type.toConfig());
    expect(isVersionField(copy.getFields().version)).toBe(true);
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Query', fields: { producto: { type, resolve: () => ({ version: 4 }) } } }),
    });
    expect((await graphql({ schema, source: '{ producto { version } }' })).data).toEqual({ producto: { version: 4 } });
  });
});

describe('collision rules', () => {
  it('versionFieldCollision finds a field named version that Simfinity did not add', async () => {
    const { RecordVersion, versionFieldCollision } = await load();
    expect(versionFieldCollision(protectedType('Producto'))).toBeNull();
    for (const type of [GraphQLInt, new GraphQLList(GraphQLString)]) {
      expect(versionFieldCollision(protectedType('Producto', { version: { type } }))).toBe(
        COLLISION('Producto', 'Producto already has a field named version; rename that field'),
      );
    }
    for (const type of [RecordVersion, new GraphQLNonNull(RecordVersion)]) {
      expect(versionFieldCollision(protectedType('Producto', { version: { type } }))).toBe(
        COLLISION('Producto', `Producto already has a field named version; rename that field${COPIED}`),
      );
    }
  });

  it('versionFieldCollision finds a field stored as version, and passes the injected field', async () => {
    const { versionFieldCollision } = await load();
    const Owner = protectedType('Owner');
    expect(versionFieldCollision(protectedType('Producto', { owner: { type: Owner, extensions: relation('version') } }))).toBe(
      COLLISION('Producto', 'Producto.owner uses version as its connectionField; choose another one'),
    );
    expect(versionFieldCollision(protectedType('Producto', { owner: { type: Owner, extensions: relation('owner_id') } }))).toBeNull();
    // A list or embedded relation stores no link on the record, so its connectionField is not a column here.
    expect(versionFieldCollision(protectedType('Producto', { owners: { type: new GraphQLList(Owner), extensions: relation('version') } }))).toBeNull();
    expect(versionFieldCollision(protectedType('Producto', { owner: { type: Owner, extensions: relation('version', true) } }))).toBeNull();
    expect(versionFieldCollision(await inject(protectedType('Producto')))).toBeNull();
  });

  it('versionConnectionCollision finds a collection of protected items that links through version', async () => {
    const { versionConnectionCollision } = await load();
    const Item = protectedType('Item');
    const fieldOf = (type, extensions) => ({ type, extensions });
    const Pedido = protectedType('Pedido');
    const collision = (name, field) => versionConnectionCollision(Pedido, name, field);
    const message = COLLISION('Item', 'Pedido.items links its items through version; use another connectionField');
    expect(collision('items', fieldOf(new GraphQLList(Item), relation('version')))).toBe(message);
    expect(collision('items', fieldOf(new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Item))), relation('version')))).toBe(message);
    // Without a connectionField the collection links through its own field name.
    expect(collision('version', fieldOf(new GraphQLList(Item), relation()))).toBe(
      COLLISION('Item', 'Pedido.version links its items through version; use another connectionField'),
    );
    expect(collision('version', fieldOf(new GraphQLList(Item), relation('pedido_id')))).toBeNull();
    expect(collision('items', fieldOf(new GraphQLList(Item), relation('pedido_id')))).toBeNull();
    expect(collision('items', fieldOf(new GraphQLList(Item), relation()))).toBeNull();
    expect(collision('items', fieldOf(new GraphQLList(Item), relation('version', true)))).toBeNull();
    expect(collision('items', fieldOf(Item, relation('version')))).toBeNull();
    expect(collision('items', fieldOf(new GraphQLList(GraphQLString), relation('version')))).toBeNull();
    expect(collision('items', { type: new GraphQLList(Item) })).toBeNull();
    // An item type that is not protected keeps its own meaning for version.
    expect(collision('items', fieldOf(new GraphQLList(protectedType('Plain', {}, {})), relation('version')))).toBeNull();
  });

  it('versionConnectionCollision treats an item type that carries the injected field as protected', async () => {
    const { versionConnectionCollision } = await load();
    const Item = await inject(protectedType('Item', {}, {}));
    expect(versionConnectionCollision(protectedType('Pedido'), 'items', { type: new GraphQLList(Item), extensions: relation('version') }))
      .toBe(COLLISION('Item', 'Pedido.items links its items through version; use another connectionField'));
  });

  it('recordVersionFieldMisuse finds any RecordVersion field that is not the injected one', async () => {
    const { RecordVersion, recordVersionFieldMisuse } = await load();
    const message = 'Producto.lastVersion uses RecordVersion, which only the managed version field may use';
    expect(recordVersionFieldMisuse(protectedType('Producto'))).toBeNull();
    expect(recordVersionFieldMisuse(await inject(protectedType('Producto')))).toBeNull();
    for (const type of [
      RecordVersion,
      new GraphQLNonNull(RecordVersion),
      new GraphQLList(RecordVersion),
      new GraphQLList(new GraphQLNonNull(RecordVersion)),
      new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RecordVersion))),
    ]) {
      expect(recordVersionFieldMisuse(protectedType('Producto', { lastVersion: { type } }, {}))).toBe(message);
    }
  });

  it('recordVersionFieldMisuse recognizes the scalar by identity, not by name', async () => {
    const { recordVersionFieldMisuse } = await load();
    const lookalike = new GraphQLScalarType({ name: 'RecordVersion' });
    expect(recordVersionFieldMisuse(protectedType('Producto', { lastVersion: { type: lookalike } }))).toBeNull();
  });
});

describe('describeModels and the version field', () => {
  const fieldNames = (entity) => entity.fields.map((field) => field.name);
  const entityOf = (type) => describeModels([{ gqltype: type }]).entities.find((entity) => entity.name === type.name);

  it('describes an injected version field as the managed field', async () => {
    const type = await inject(protectedType('Producto'));
    const entity = entityOf(type);
    expect(fieldNames(entity)).toEqual(['id', 'name', 'version']);
    expect(entity.fields.at(-1)).toEqual(VERSION);
  });

  it('describes the field of a declared extension that is not injected yet, after the type\'s own fields, without changing the type', () => {
    const type = protectedType('Producto');
    const entity = entityOf(type);
    expect(fieldNames(entity)).toEqual(['id', 'name', 'version']);
    expect(entity.fields.at(-1)).toEqual(VERSION);
    expect(Object.keys(type.getFields())).toEqual(['id', 'name']);
  });

  it('describes the same field before and after injection', async () => {
    const type = protectedType('Producto');
    const before = entityOf(type).fields;
    await inject(type);
    expect(entityOf(type).fields).toEqual(before);
  });

  it('describes a type that carries the injected field without declaring the extension', async () => {
    const entity = entityOf(await inject(protectedType('Producto', {}, {})));
    expect(entity.fields.at(-1)).toEqual(VERSION);
    expect(entity.fields.filter((field) => field.version)).toHaveLength(1);
  });

  it('gives each description its own descriptor', () => {
    const first = entityOf(protectedType('Producto')).fields.at(-1);
    const second = entityOf(protectedType('Producto')).fields.at(-1);
    expect(first).toEqual(VERSION);
    expect(first).not.toBe(second);
  });

  it('describes a protected relation target and keeps the inverse reference of its collection after the version', () => {
    const Item = protectedType('Item');
    const Pedido = new GraphQLObjectType({ name: 'Pedido', fields: { id: { type: GraphQLID }, items: { type: new GraphQLList(Item), extensions: relation('pedido_id') } } });
    const { entities } = describeModels([{ gqltype: Pedido }]);
    const item = entities.find((entity) => entity.name === 'Item');
    expect(fieldNames(item)).toEqual(['id', 'name', 'version', 'pedido_id']);
    expect(item.fields[2]).toEqual(VERSION);
    expect(entities.find((entity) => entity.name === 'Pedido').fields.some((field) => field.version)).toBe(false);
  });

  it('pin: a registration without the extension is described as before', () => {
    const Autor = new GraphQLObjectType({ name: 'Autor', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Libro = new GraphQLObjectType({
      name: 'Libro',
      extensions: { concurrency: undefined },
      fields: {
        id: { type: GraphQLID },
        title: { type: new GraphQLNonNull(GraphQLString) },
        version: { type: GraphQLInt },
        autor: { type: Autor, extensions: relation('autor_id') },
      },
    });
    const { entities } = describeModels([{ gqltype: Libro }]);
    const own = { required: false, list: false, itemRequired: false, unique: false, readOnly: false };
    expect(entities.map((entity) => entity.name)).toEqual(['Autor', 'Libro']);
    expect(entities[1].fields).toEqual([
      { ...own, name: 'id', storageName: 'id', kind: 'scalar', scalar: 'ID' },
      { ...own, name: 'title', storageName: 'title', kind: 'scalar', scalar: 'String', required: true },
      { ...own, name: 'version', storageName: 'version', kind: 'scalar', scalar: 'Int' },
      { ...own, name: 'autor', storageName: 'autor_id', kind: 'reference', target: 'Autor' },
    ]);
  });

  it('rejects an invalid extensions.concurrency', () => {
    expectInvalidModel(
      () => describeModels([{ gqltype: protectedType('Producto', {}, { concurrency: { mode: 'pessimistic' } }) }]),
      SHAPE_MESSAGE,
    );
    expectInvalidModel(
      () => describeModels([{ gqltype: protectedType('Producto', {}, { concurrency: true }) }]),
      SHAPE_MESSAGE,
    );
  });

  it('rejects a field named version that Simfinity did not add', () => {
    for (const type of [GraphQLInt, GraphQLString]) {
      expectInvalidModel(
        () => describeModels([{ gqltype: protectedType('Producto', { version: { type } }) }]),
        COLLISION('Producto', 'Producto already has a field named version; rename that field'),
      );
    }
  });

  it('reports a RecordVersion field named version as the collision, not as a misuse', async () => {
    const { RecordVersion } = await load();
    expectInvalidModel(
      () => describeModels([{ gqltype: protectedType('Producto', { version: { type: new GraphQLNonNull(RecordVersion) } }) }]),
      COLLISION('Producto', `Producto already has a field named version; rename that field${COPIED}`),
    );
  });

  it('rejects a reference stored as version', () => {
    const Owner = protectedType('Owner', {}, {});
    expectInvalidModel(
      () => describeModels([{ gqltype: protectedType('Producto', { owner: { type: Owner, extensions: relation('version') } }) }]),
      COLLISION('Producto', 'Producto.owner uses version as its connectionField; choose another one'),
    );
  });

  it('rejects a collection of protected items that links through version, by connectionField or by field name', () => {
    const Item = protectedType('Item');
    const Pedido = (fields) => new GraphQLObjectType({ name: 'Pedido', fields: { id: { type: GraphQLID }, ...fields } });
    expectInvalidModel(
      () => describeModels([{ gqltype: Pedido({ items: { type: new GraphQLList(Item), extensions: relation('version') } }) }]),
      COLLISION('Item', 'Pedido.items links its items through version; use another connectionField'),
    );
    expectInvalidModel(
      () => describeModels([{ gqltype: Pedido({ version: { type: new GraphQLList(Item), extensions: relation() } }) }]),
      COLLISION('Item', 'Pedido.version links its items through version; use another connectionField'),
    );
  });

  it('pin: a type without the extension uses version for its own field, reference or collection', () => {
    const Item = protectedType('Plain', {}, {});
    const Other = new GraphQLObjectType({ name: 'Other', fields: { id: { type: GraphQLID }, version: { type: GraphQLInt } } });
    const Holder = new GraphQLObjectType({
      name: 'Holder',
      fields: {
        id: { type: GraphQLID },
        version: { type: GraphQLInt },
        other: { type: Other, extensions: relation('other_version') },
      },
    });
    const Parent = new GraphQLObjectType({ name: 'Parent', fields: { id: { type: GraphQLID }, items: { type: new GraphQLList(Item), extensions: relation('version') } } });
    expect(() => describeModels([{ gqltype: Holder }])).not.toThrow();
    expect(() => describeModels([{ gqltype: Parent }])).not.toThrow();
  });

  it('rejects a RecordVersion field on a protected, an unprotected and an embedded type', async () => {
    const { RecordVersion } = await load();
    const message = 'Producto.lastVersion uses RecordVersion, which only the managed version field may use';
    for (const type of [RecordVersion, new GraphQLNonNull(RecordVersion), new GraphQLList(new GraphQLNonNull(RecordVersion))]) {
      expectInvalidModel(() => describeModels([{ gqltype: protectedType('Producto', { lastVersion: { type } }) }]), message);
      expectInvalidModel(() => describeModels([{ gqltype: protectedType('Producto', { lastVersion: { type } }, {}) }]), message);
    }
    const Producto = protectedType('Producto', { lastVersion: { type: RecordVersion } }, {});
    const Pedido = new GraphQLObjectType({
      name: 'Pedido',
      fields: { id: { type: GraphQLID }, producto: { type: Producto, extensions: relation(undefined, true) } },
    });
    expectInvalidModel(() => describeModels([{ gqltype: Pedido }, { gqltype: Producto, endpoint: false }]), message);
  });

  it('rejects a protected type used as an embedded value', async () => {
    const Producto = protectedType('Producto');
    const Pedido = new GraphQLObjectType({
      name: 'Pedido',
      fields: { id: { type: GraphQLID }, producto: { type: Producto, extensions: relation(undefined, true) } },
    });
    const message = 'Producto declares optimistic concurrency, so it cannot be embedded (Pedido.producto)';
    expectInvalidModel(() => describeModels([{ gqltype: Pedido }, { gqltype: Producto, endpoint: false }]), message);
    await inject(Producto);
    Producto.extensions = {};
    expectInvalidModel(() => describeModels([{ gqltype: Pedido }, { gqltype: Producto, endpoint: false }]), message);
  });

  it('describes the injected field of one type and a plain version field of another side by side', async () => {
    const Producto = await inject(protectedType('Producto'));
    const Other = new GraphQLObjectType({ name: 'Other', fields: { id: { type: GraphQLID }, version: { type: GraphQLInt } } });
    const { entities } = describeModels([{ gqltype: Producto }, { gqltype: Other }]);
    expect(entities.find((entity) => entity.name === 'Producto').fields.at(-1)).toEqual(VERSION);
    expect(entities.find((entity) => entity.name === 'Other').fields.at(-1)).toMatchObject({ name: 'version', scalar: 'Int' });
  });
});

describe('exports', () => {
  it('exports RecordVersion and MAX_RECORD_VERSION from the core root and the three facades, as the subpath\'s own instances', async () => {
    const { RecordVersion, MAX_RECORD_VERSION } = await load();
    for (const name of ['@simtlix/simfinity-core', '@simtlix/simfinity-js', '@simtlix/simfinity-sql', '@simtlix/simfinity-postgres']) {
      const exported = await import(name);
      expect(exported.RecordVersion, name).toBe(RecordVersion);
      expect(exported.MAX_RECORD_VERSION, name).toBe(MAX_RECORD_VERSION);
    }
  });

  it('pin: the roots and facades keep the internals off their exports', async () => {
    for (const name of ['@simtlix/simfinity-core', '@simtlix/simfinity-js', '@simtlix/simfinity-sql', '@simtlix/simfinity-postgres']) {
      const exported = await import(name);
      for (const internal of ['RecordVersionRef', 'RECORD_VERSION_FIELD', 'retainStoredVersion', 'retainedStoredVersion', 'isVersionField', 'readStoredVersion', 'versionConflictError']) {
        expect(exported[internal], `${name} ${internal}`).toBeUndefined();
      }
    }
  });

  it('exposes everything else through ./internal/record-version, and nothing more', async () => {
    const module = await load();
    expect(Object.keys(module).sort()).toEqual([
      'MAX_RECORD_VERSION', 'RECORD_VERSION_FIELD', 'RecordVersion', 'RecordVersionRef', 'assertVersionInput',
      'concurrencyDeclared', 'createVersionFieldConfig', 'isProtectedType', 'isVersionField', 'readStoredVersion',
      'recordVersionFieldMisuse', 'retainStoredVersion', 'retainedStoredVersion', 'unadvancedVersionError', 'unexpectedDeleteError', 'versionConflictError',
      'versionConnectionCollision', 'versionEmbeddedMisuse', 'versionExhaustedError', 'versionFieldCollision',
      'versionManagedError',
    ]);
  });
});

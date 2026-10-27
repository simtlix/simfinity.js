import { describe, expect, test, vi } from 'vitest';
import {
  GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLScalarType, GraphQLString,
} from 'graphql';

import SimfinityError from '../packages/core/src/errors/simfinity.error.js';
import { readDeleteTarget, snapshotOperationInput } from '../packages/core/src/operation-input.js';
import { RecordVersion, RecordVersionRef } from '../packages/core/src/record-version.js';

// Pure graphql types, as the generated inputs of a runtime have them: an update input with a nested
// collection input, the input of a single reference, an enum with object internal values, a JSON-like
// scalar and a Date scalar.

const nonNull = (type) => new GraphQLNonNull(type);
const listOf = (type) => new GraphQLList(type);

const Color = new GraphQLEnumType({
  name: 'Color',
  values: { RED: { value: { code: 'red' } }, BLUE: { value: { code: 'blue' } }, GREEN: { value: 'green' } },
});
const RED = Color.getValue('RED').value;
const JSONScalar = new GraphQLScalarType({ name: 'JSON' });
const DateTime = new GraphQLScalarType({ name: 'DateTime' });

const IdInputType = new GraphQLInputObjectType({ name: 'IdInputType', fields: { id: { type: nonNull(GraphQLString) } } });

const LineInput = new GraphQLInputObjectType({
  name: 'LineInput',
  fields: {
    name: { type: nonNull(GraphQLString) },
    price: { type: GraphQLFloat },
    color: { type: Color },
    meta: { type: JSONScalar },
    when: { type: DateTime },
  },
});
const LineInputForUpdate = new GraphQLInputObjectType({
  name: 'LineInputForUpdate',
  fields: {
    id: { type: nonNull(GraphQLID) },
    name: { type: GraphQLString },
    price: { type: GraphQLFloat },
    meta: { type: JSONScalar },
  },
});
const OneToManyLines = new GraphQLInputObjectType({
  name: 'OneToManyULines',
  fields: {
    added: { type: listOf(LineInput) },
    updated: { type: listOf(LineInputForUpdate) },
    deleted: { type: listOf(GraphQLID) },
  },
});

// A protected collection: its items carry their version and are deleted at the version read.
const ItemInputForUpdate = new GraphQLInputObjectType({
  name: 'ItemInputForUpdate',
  fields: { id: { type: nonNull(GraphQLID) }, version: { type: nonNull(RecordVersion) }, qty: { type: GraphQLInt } },
});
const OneToManyItems = new GraphQLInputObjectType({
  name: 'OneToManyUItems',
  fields: { updated: { type: listOf(ItemInputForUpdate) }, deleted: { type: listOf(RecordVersionRef) } },
});

// An embedded value: not a collection, and its own id is no record key.
const AddressInput = new GraphQLInputObjectType({
  name: 'AddressInput',
  fields: { id: { type: GraphQLID }, street: { type: GraphQLString } },
});

const NodeInput = new GraphQLInputObjectType({
  name: 'NodeInput',
  fields: () => ({ name: { type: GraphQLString }, next: { type: NodeInput } }),
});

const OrderInputForUpdate = new GraphQLInputObjectType({
  name: 'OrderInputForUpdate',
  fields: {
    id: { type: nonNull(GraphQLID) },
    version: { type: nonNull(RecordVersion) },
    title: { type: nonNull(GraphQLString) },
    name: { type: GraphQLString },
    tags: { type: listOf(nonNull(GraphQLString)) },
    score: { type: listOf(listOf(GraphQLInt)) },
    placedAt: { type: DateTime },
    payload: { type: JSONScalar },
    color: { type: Color },
    colors: { type: listOf(Color) },
    customer: { type: IdInputType },
    customers: { type: listOf(IdInputType) },
    address: { type: AddressInput },
    lines: { type: OneToManyLines },
    items: { type: OneToManyItems },
    chain: { type: NodeInput },
  },
});

// A type declared with `id: String` has a nullable id in its update input.
const LooseInputForUpdate = new GraphQLInputObjectType({
  name: 'LooseInputForUpdate',
  fields: { id: { type: GraphQLString }, name: { type: GraphQLString } },
});

// A model whose ids are numbers declares `id: Int`.
const PartInputForUpdate = new GraphQLInputObjectType({
  name: 'PartInputForUpdate',
  fields: { id: { type: GraphQLInt }, qty: { type: GraphQLInt } },
});
const OneToManyParts = new GraphQLInputObjectType({
  name: 'OneToManyUParts',
  fields: { updated: { type: listOf(PartInputForUpdate) }, deleted: { type: listOf(GraphQLInt) } },
});
const CounterInputForUpdate = new GraphQLInputObjectType({
  name: 'CounterInputForUpdate',
  fields: { id: { type: GraphQLInt }, label: { type: GraphQLString }, parts: { type: OneToManyParts } },
});

const collectionInputTypes = new WeakSet([OneToManyLines, OneToManyItems, OneToManyParts]);
const baseOptions = { collectionInputTypes, idInputType: IdInputType };

const snapshot = (value, type, options = {}) => snapshotOperationInput(value, type, { ...baseOptions, ...options });
const update = (value, options = {}) => snapshot(value, OrderInputForUpdate, { topLevelId: true, ...options });

const order = (extra = {}) => ({ id: '507f1f77bcf86cd799439011', version: 2, title: 'Spring order', ...extra });

class ObjectIdLike {
  constructor(hex) {
    this.hex = hex;
  }
}

class Money {
  constructor(amount) {
    this.amount = amount;
  }
}

const failure = (callback) => {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the call did not throw');
};

const expectInvalid = (callback, path, reason) => {
  const error = failure(callback);
  expect(error).toBeInstanceOf(SimfinityError);
  expect(error.getCode()).toBe('INVALID_INPUT');
  expect(error.getStatus()).toBe(400);
  expect(error.message).toBe(`Invalid input at ${path}: ${reason}`);
};

const expectRequired = (callback, path) => {
  const error = failure(callback);
  expect(error).toBeInstanceOf(SimfinityError);
  expect(error.getCode()).toBe('REQUIRED_VALUE');
  expect(error.getStatus()).toBe(400);
  expect(error.message).toBe(`Required value ${path} is missing`);
};

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

const STRING_KEY = 'pass the ID as a string, for example String(record._id)';
const PRIMITIVE_KEY = 'pass the ID as a primitive value';

describe('containers (programmatic)', () => {
  test('a valid update input comes back equal and new', () => {
    const source = order({
      name: 'n',
      tags: ['a', 'b'],
      lines: { added: [{ name: 'x', price: 1.5, color: RED }], updated: [{ id: 'l1', name: 'y' }], deleted: ['l2'] },
      items: { updated: [{ id: 'i1', version: 3, qty: 2 }], deleted: [{ id: 'i2', version: 1 }] },
      customer: { id: 'c1' },
      address: { id: 7, street: 's' },
    });
    const result = update(source);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result.lines).not.toBe(source.lines);
    expect(result.lines.added).not.toBe(source.lines.added);
    expect(result.lines.added[0]).not.toBe(source.lines.added[0]);
  });

  test('null-prototype containers are accepted and come back as plain objects', () => {
    const lines = Object.assign(Object.create(null), { deleted: ['l1'] });
    const result = update(Object.assign(Object.create(null), order({ lines })));

    expect(result.lines).toEqual({ deleted: ['l1'] });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.lines)).toBe(Object.prototype);
  });

  test.each([
    ['a class instance', () => new Money(3)],
    ['an array', () => []],
    ['a Date', () => new Date()],
    ['a Map', () => new Map()],
    ['an object with another prototype', () => Object.create({ street: 'inherited' })],
    ['a string', () => 'x'],
    ['a number', () => 3],
  ])('%s where the input expects an object', (_, make) => {
    expectInvalid(() => update(order({ address: make() })), 'input.address', 'expected a plain object');
  });

  test('the root itself must be a plain object', () => {
    expectInvalid(() => update(new Money(1)), 'input', 'expected a plain object');
    expectInvalid(() => update([order()]), 'input', 'expected a plain object');
  });

  test('an accessor property fails and its getter never runs', () => {
    const getter = vi.fn(() => 'name');
    const source = order();
    Object.defineProperty(source, 'name', { get: getter, enumerable: true });

    expectInvalid(() => update(source), 'input.name', 'accessor property');
    expect(getter).not.toHaveBeenCalled();
  });

  test('a setter-only accessor fails the same way', () => {
    const source = order();
    Object.defineProperty(source, 'name', { set() {}, enumerable: true });

    expectInvalid(() => update(source), 'input.name', 'accessor property');
  });

  test('a symbol-keyed property fails at the container', () => {
    const source = order({ address: { street: 's', [Symbol('hidden')]: 1 } });

    expectInvalid(() => update(source), 'input.address', 'non-enumerable or symbol-keyed property');
  });

  test('a non-enumerable property fails at the property', () => {
    const source = order();
    Object.defineProperty(source, 'name', { value: 'n', enumerable: false });

    expectInvalid(() => update(source), 'input.name', 'non-enumerable or symbol-keyed property');
  });

  test('a container that contains itself is a cycle', () => {
    const node = { name: 'a' };
    node.next = node;

    expectInvalid(() => update(order({ chain: node })), 'input.chain.next', 'cycle');
  });

  test('a longer cycle is found along the path', () => {
    const first = { name: 'a' };
    const second = { name: 'b', next: first };
    first.next = second;

    expectInvalid(() => update(order({ chain: first })), 'input.chain.next.next', 'cycle');
  });

  test('a list that contains itself is a cycle', () => {
    const rows = [];
    rows.push(rows);

    expectInvalid(() => update(order({ score: rows })), 'input.score[0]', 'cycle');
  });

  test('a sparse list fails at the list', () => {
    const tags = ['a'];
    tags[2] = 'c';

    expectInvalid(() => update(order({ tags })), 'input.tags', 'expected a dense list');
    expectInvalid(() => update(order({ tags: new Array(2) })), 'input.tags', 'expected a dense list');
  });

  test('an accessor list element fails at the element and is never read', () => {
    const getter = vi.fn(() => 'a');
    const tags = [];
    Object.defineProperty(tags, 0, { get: getter, enumerable: true });

    expectInvalid(() => update(order({ tags })), 'input.tags[0]', 'accessor property');
    expect(getter).not.toHaveBeenCalled();
  });

  test('a bare value is not wrapped into a list', () => {
    expectInvalid(() => update(order({ tags: 'a' })), 'input.tags', 'expected a list');
    expectInvalid(() => update(order({ lines: { added: { name: 'x' } } })), 'input.lines.added', 'expected a list');
    expectInvalid(() => update(order({ score: [1] })), 'input.score[0]', 'expected a list');
    expectInvalid(() => update(order({ tags: { 0: 'a', length: 1 } })), 'input.tags', 'expected a list');
  });

  test('an unknown field fails with its path', () => {
    expectInvalid(() => update(order({ nope: 1 })), 'input.nope', 'unknown field');
    expectInvalid(() => update(order({ lines: { added: [{ name: 'a' }, { name: 'b', nope: 1 }] } })),
      'input.lines.added[1].nope', 'unknown field');
    expectInvalid(() => update(order({ customer: { id: 'c', extra: 1 } })), 'input.customer.extra', 'unknown field');
  });

  test('an own __proto__ key is an unknown field, not a change of prototype', () => {
    expectInvalid(() => update(JSON.parse('{"id":"1","version":1,"title":"t","__proto__":{"name":"x"}}')),
      'input.__proto__', 'unknown field');
  });

  test('a record spread into the input fails at its first unknown field, before any missing one', () => {
    const stored = { _id: '507f1f77bcf86cd799439011', title: 'Spring order', version: 2, __v: 0 };

    expectInvalid(() => update({ ...stored, name: 'renamed' }), 'input._id', 'unknown field');
  });

  describe('state', () => {
    test('on a type whose state is managed, an undeclared top-level state says to use transitionObject', () => {
      expectInvalid(() => update(order({ state: 'CLOSED' }), { stateManaged: true }), 'input.state',
        'state changes only through transitionObject');
    });

    test('without stateManaged it is an ordinary unknown field', () => {
      expectInvalid(() => update(order({ state: 'CLOSED' })), 'input.state', 'unknown field');
      expectInvalid(() => update(order({ state: 'CLOSED' }), { stateManaged: false }), 'input.state', 'unknown field');
    });

    test('anywhere but the top level it is an ordinary unknown field', () => {
      expectInvalid(() => update(order({ address: { state: 'x' } }), { stateManaged: true }),
        'input.address.state', 'unknown field');
      expectInvalid(() => update(order({ lines: { added: [{ name: 'a', state: 'x' }] } }), { stateManaged: true }),
        'input.lines.added[0].state', 'unknown field');
    });

    test('an own undefined state is an omitted field', () => {
      expect(update(order({ state: undefined }), { stateManaged: true })).toEqual(order());
    });

    test('a declared field called state is an ordinary field', () => {
      const WithState = new GraphQLInputObjectType({
        name: 'WithState', fields: { id: { type: GraphQLID }, state: { type: GraphQLString } },
      });

      expect(snapshot({ id: '1', state: 'OPEN' }, WithState, { stateManaged: true })).toEqual({ id: '1', state: 'OPEN' });
    });
  });

  test('errors name the path and never a value', () => {
    const error = failure(() => update(order({ lines: { added: [{ name: 'a', color: 'secret-value' }] } })));

    expect(error.message).toBe('Invalid input at input.lines.added[0].color: not a value of enum Color');
    expect(error.message).not.toContain('secret-value');
  });

  test('the path option names the root', () => {
    expectInvalid(() => update(order({ nope: 1 }), { path: 'operations[2].update' }), 'operations[2].update.nope',
      'unknown field');
    expectInvalid(() => update(order({ lines: { added: [{ name: 'a', price: new Money(1) }] } }),
      { path: 'helper' }), 'helper.lines.added[0].price', 'unsupported scalar value');
  });
});

describe('required values (programmatic)', () => {
  test('a missing top-level id fails whatever its declared nullability', () => {
    expectRequired(() => snapshot({ name: 'n' }, LooseInputForUpdate, { topLevelId: true }), 'input.id');
    expectRequired(() => snapshot({ id: null, name: 'n' }, LooseInputForUpdate, { topLevelId: true }), 'input.id');
    expectRequired(() => snapshot({ id: undefined, name: 'n' }, LooseInputForUpdate, { topLevelId: true }), 'input.id');
    expectRequired(() => update({ version: 1, title: 't' }), 'input.id');
  });

  test('without topLevelId a nullable id may be absent or null', () => {
    expect(snapshot({ name: 'n' }, LooseInputForUpdate)).toEqual({ name: 'n' });
    expect(snapshot({ id: null }, LooseInputForUpdate)).toEqual({ id: null });
  });

  test('a null for a non-null field fails', () => {
    expectRequired(() => update(order({ title: null })), 'input.title');
    expectRequired(() => update(order({ version: null })), 'input.version');
    expectRequired(() => update(order({ id: null })), 'input.id');
  });

  test('a missing or undefined non-null field fails', () => {
    expectRequired(() => update({ id: '1', title: 't' }), 'input.version');
    expectRequired(() => update(order({ title: undefined })), 'input.title');
    expectRequired(() => update(order({ lines: { added: [{ price: 1 }] } })), 'input.lines.added[0].name');
  });

  test('a null item in a list of non-null items fails, and so does an undefined one', () => {
    expectRequired(() => update(order({ tags: ['a', null] })), 'input.tags[1]');
    expectRequired(() => update(order({ tags: ['a', undefined] })), 'input.tags[1]');
  });

  test('a null top-level value fails at the root path', () => {
    expectRequired(() => update(null), 'input');
    expectRequired(() => update(undefined), 'input');
    expectRequired(() => update(null, { path: 'operations[0].update' }), 'operations[0].update');
    expectRequired(() => snapshot(null, OrderInputForUpdate, { mode: 'coerced' }), 'input');
  });

  test('a null for a nullable field is kept and an omitted one stays absent', () => {
    const result = update(order({ name: null, tags: null, address: null, lines: null }));

    expect(result.name).toBeNull();
    expect(result.tags).toBeNull();
    expect(result.address).toBeNull();
    expect(result.lines).toBeNull();
    expect(Object.hasOwn(result, 'payload')).toBe(false);
    expect(Object.hasOwn(result, 'customer')).toBe(false);
  });

  test('a required value is reported after the unknown fields of the container', () => {
    expectInvalid(() => update({ id: '1', nope: 1 }), 'input.nope', 'unknown field');
  });

  test('the version is only checked for presence', () => {
    expect(update(order({ version: 0 })).version).toBe(0);
    expect(update(order({ version: '3' })).version).toBe('3');
  });
});

describe('absence and undefined (programmatic)', () => {
  test('an own undefined is dropped from the snapshot', () => {
    const result = update(order({ name: undefined, address: { street: undefined, id: '1' }, ghost: undefined }));

    expect(Object.hasOwn(result, 'name')).toBe(false);
    expect(Object.hasOwn(result, 'ghost')).toBe(false);
    expect(result.address).toEqual({ id: '1' });
    expect(Object.hasOwn(result.address, 'street')).toBe(false);
  });

  test('a list item undefined becomes null, and null stays null', () => {
    const result = update(order({
      lines: { deleted: ['l1', undefined, null] },
      customers: [{ id: 'c1' }, undefined],
      colors: [undefined, null, RED],
    }));

    expect(result.lines.deleted).toEqual(['l1', null, null]);
    expect(result.customers).toEqual([{ id: 'c1' }, null]);
    expect(result.colors).toEqual([null, null, RED]);
  });
});

describe('copies', () => {
  test('a frozen source gives an extensible copy', () => {
    const source = deepFreeze(order({
      tags: ['a'],
      lines: { added: [{ name: 'x', meta: { a: [1, { b: 2 }] } }], deleted: ['l1'] },
      address: { street: 's' },
    }));
    const result = update(source);

    expect(result).toEqual(source);
    for (const container of [result, result.tags, result.lines, result.lines.added, result.lines.added[0],
      result.lines.added[0].meta, result.lines.added[0].meta.a, result.lines.added[0].meta.a[1], result.address]) {
      expect(Object.isExtensible(container)).toBe(true);
      expect(Object.isFrozen(container)).toBe(false);
    }
    result.lines.added[0].name = 'changed';
    result.tags.push('b');
    expect(source.lines.added[0].name).toBe('x');
    expect(source.tags).toEqual(['a']);
  });

  test('the source is never written to', () => {
    const make = () => order({
      name: 'n',
      tags: ['a'],
      placedAt: new Date(5),
      payload: { a: [1, 2], b: { c: null } },
      lines: { added: [{ name: 'x', when: new Date(9) }], updated: [{ id: 'l1' }], deleted: ['l2', undefined] },
      customers: [{ id: 'c1' }, undefined],
    });
    const source = make();
    const result = update(source);

    result.tags.push('z');
    result.payload.a.push(3);
    result.lines.added[0].when.setTime(0);
    result.placedAt.setTime(0);

    expect(source).toEqual(make());
  });

  test('a container shared by two positions gives two distinct objects', () => {
    const line = { name: 'x' };
    const customer = { id: 'c1' };
    const result = update(order({ lines: { added: [line, line] }, customer, customers: [customer, customer] }));

    expect(result.lines.added[0]).toEqual(line);
    expect(result.lines.added[0]).not.toBe(line);
    expect(result.lines.added[1]).not.toBe(line);
    expect(result.lines.added[0]).not.toBe(result.lines.added[1]);
    expect(new Set([customer, result.customer, result.customers[0], result.customers[1]]).size).toBe(4);
  });

  test('a list shared by two positions gives two distinct lists', () => {
    const rows = [1, 2];
    const result = update(order({ score: [rows, rows] }));

    expect(result.score).toEqual([[1, 2], [1, 2]]);
    expect(result.score[0]).not.toBe(result.score[1]);
    expect(result.score[0]).not.toBe(rows);
  });

  test('a cycle fails', () => {
    const node = {};
    node.next = { next: node };

    expectInvalid(() => update(order({ chain: node })), 'input.chain.next.next', 'cycle');
  });
});

describe('enums', () => {
  test('a member object is kept by identity', () => {
    const result = update(order({ color: RED, colors: [RED, 'green'], lines: { added: [{ name: 'a', color: RED }] } }));

    expect(result.color).toBe(RED);
    expect(result.colors[0]).toBe(RED);
    expect(result.colors[1]).toBe('green');
    expect(result.lines.added[0].color).toBe(RED);
  });

  test('a non-member fails with the enum name', () => {
    expectInvalid(() => update(order({ color: 'RED' })), 'input.color', 'not a value of enum Color');
    expectInvalid(() => update(order({ color: { code: 'red' } })), 'input.color', 'not a value of enum Color');
    expectInvalid(() => update(order({ color: 3 })), 'input.color', 'not a value of enum Color');
    expectInvalid(() => update(order({ colors: [RED, 'purple'] })), 'input.colors[1]', 'not a value of enum Color');
  });

  test('membership is SameValueZero', () => {
    const Numbers = new GraphQLEnumType({ name: 'Numbers', values: { NAN: { value: Number.NaN }, ZERO: { value: 0 } } });
    const Holder = new GraphQLInputObjectType({ name: 'Holder', fields: { n: { type: Numbers } } });

    expect(snapshot({ n: Number.NaN }, Holder).n).toBeNaN();
    expect(snapshot({ n: -0 }, Holder).n).toBe(-0);
    expectInvalid(() => snapshot({ n: 1 }, Holder), 'input.n', 'not a value of enum Numbers');
  });
});

describe('scalars', () => {
  test('primitives are kept as they are', () => {
    const result = update(order({ name: 'n', payload: 7, lines: { added: [{ name: 'a', price: 0.5, meta: 12n }] } }));

    expect(result.name).toBe('n');
    expect(result.payload).toBe(7);
    expect(result.lines.added[0].price).toBe(0.5);
    expect(result.lines.added[0].meta).toBe(12n);
    expect(update(order({ payload: true })).payload).toBe(true);
    expect(update(order({ payload: 'text' })).payload).toBe('text');
    expect(update(order({ payload: null })).payload).toBeNull();
  });

  test('a Date is copied by time', () => {
    const date = new Date(1700000000000);
    const result = update(order({ placedAt: date, lines: { added: [{ name: 'a', when: date }] } }));

    expect(result.placedAt).toBeInstanceOf(Date);
    expect(result.placedAt).not.toBe(date);
    expect(result.placedAt.getTime()).toBe(1700000000000);
    expect(result.lines.added[0].when).not.toBe(result.placedAt);
    expect(result.lines.added[0].when.getTime()).toBe(1700000000000);
    expect(update(order({ placedAt: new Date(Number.NaN) })).placedAt.getTime()).toBeNaN();
  });

  describe('a Date is read with the intrinsic, never through the caller (F1)', () => {
    const DATE_PATHS = [
      ['a scalar position', (value) => order({ payload: value }), 'input.payload'],
      ['plain data', (value) => order({ payload: { a: [value] } }), 'input.payload.a[0]'],
      ['a nested input', (value) => order({ lines: { added: [{ name: 'a', when: value }] } }),
        'input.lines.added[0].when'],
    ];

    test.each(DATE_PATHS)('an object that only has the Date prototype is refused at %s', (_, build, path) => {
      expectInvalid(() => update(build(Object.create(Date.prototype))), path, 'unsupported scalar value');
    });

    test.each(DATE_PATHS)('a Symbol.toStringTag spoof is refused at %s', (_, build, path) => {
      const spoof = Object.create(Date.prototype, { [Symbol.toStringTag]: { value: 'Date' } });

      expectInvalid(() => update(build(spoof)), path, 'unsupported scalar value');
    });

    test.each(DATE_PATHS)('a Proxy of a Date is refused at %s', (_, build, path) => {
      expectInvalid(() => update(build(new Proxy(new Date(1), {}))), path, 'unsupported scalar value');
    });

    test('an object that only has the Date prototype is not touched by the check', () => {
      const getTime = vi.fn(() => 1);
      const fake = Object.create(Date.prototype, { getTime: { value: getTime } });

      expectInvalid(() => update(order({ payload: fake })), 'input.payload', 'unsupported scalar value');
      expect(getTime).not.toHaveBeenCalled();
    });

    test('a real Date with its own getTime function is copied by its real time and the override never runs', () => {
      const override = vi.fn(() => 5);
      const date = new Date(1700000000000);
      date.getTime = override;
      const result = update(order({ placedAt: date, payload: { when: date } }));

      expect(result.placedAt).toBeInstanceOf(Date);
      expect(result.placedAt.getTime()).toBe(1700000000000);
      expect(result.payload.when.getTime()).toBe(1700000000000);
      expect(override).not.toHaveBeenCalled();
    });

    test('a real Date with its own getTime getter is copied by its real time and the getter never runs', () => {
      const getter = vi.fn(() => () => 5);
      const date = new Date(1700000000000);
      Object.defineProperty(date, 'getTime', { get: getter, enumerable: true, configurable: true });
      const result = update(order({ placedAt: date }));

      expect(result.placedAt.getTime()).toBe(1700000000000);
      expect(getter).not.toHaveBeenCalled();
    });

    test('pin: a Date subclass and an invalid Date keep their rulings', () => {
      class Later extends Date {}

      expectInvalid(() => update(order({ payload: new Later(1) })), 'input.payload', 'unsupported scalar value');
      expect(update(order({ placedAt: new Date(Number.NaN) })).placedAt.getTime()).toBeNaN();
    });

    test('the copy mode reads a Date the same way', () => {
      const date = new Date(7);
      date.getTime = () => 9;

      expect(update({ placedAt: date }, { mode: 'copy' }).placedAt.getTime()).toBe(7);
    });
  });

  describe('a property without a descriptor is refused, never a TypeError (F1)', () => {
    // The key is reported by ownKeys and then has no descriptor, as when caller code removes it mid-walk.
    const ghost = () => new Proxy({}, { ownKeys: () => ['ghost'] });

    test('in a typed input', () => {
      expectInvalid(() => update(order({ address: ghost() })), 'input.address.ghost',
        'non-enumerable or symbol-keyed property');
      expectInvalid(() => update(ghost()), 'input.ghost', 'non-enumerable or symbol-keyed property');
    });

    test('in plain data', () => {
      expectInvalid(() => update(order({ payload: { deep: ghost() } })), 'input.payload.deep.ghost',
        'non-enumerable or symbol-keyed property');
      expectInvalid(() => update(order({ lines: { added: [{ name: 'a', meta: ghost() }] } })),
        'input.lines.added[0].meta.ghost', 'non-enumerable or symbol-keyed property');
    });

    test('in a list whose item goes away between the two reads', () => {
      let reads = 0;
      const vanishing = new Proxy(['a'], {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === '0') {
            reads += 1;
            if (reads > 1) return undefined;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });

      expectInvalid(() => update(order({ tags: vanishing })), 'input.tags[0]', 'non-enumerable or symbol-keyed property');
      expect(reads).toBe(2);
    });
  });

  describe('the depth of one scalar value is limited (F2)', () => {
    const nestedLists = (depth) => {
      let value = [];
      for (let level = 1; level < depth; level += 1) value = [value];
      return value;
    };
    const nestedObjects = (depth) => {
      let value = {};
      for (let level = 1; level < depth; level += 1) value = { a: value };
      return value;
    };
    const depthOf = (value, step) => {
      let depth = 0;
      for (let current = value; current !== undefined; current = step(current)) depth += 1;
      return depth;
    };
    const deepJson = (depth) => JSON.parse('['.repeat(depth) + ']'.repeat(depth));
    const coerced = (value) => update(value, { mode: 'coerced' });

    test('256 nested lists are copied and 257 are refused at the 257th', () => {
      const result = update(order({ payload: nestedLists(256) })).payload;

      expect(depthOf(result, (list) => list[0])).toBe(256);
      expectInvalid(() => update(order({ payload: nestedLists(257) })), `input.payload${'[0]'.repeat(256)}`,
        'unsupported scalar value');
    });

    test('256 nested objects are copied and 257 are refused at the 257th', () => {
      const result = update(order({ payload: nestedObjects(256) })).payload;

      expect(depthOf(result, (object) => object.a)).toBe(256);
      expectInvalid(() => update(order({ payload: nestedObjects(257) })), `input.payload${'.a'.repeat(256)}`,
        'unsupported scalar value');
    });

    test('the limit counts from the scalar value, not from the input', () => {
      const lines = { added: [{ name: 'a', meta: nestedLists(256) }] };

      expect(update(order({ lines })).lines.added[0].meta).toEqual(nestedLists(256));
      expectInvalid(() => update(order({ lines: { added: [{ name: 'a', meta: nestedLists(257) }] } })),
        `input.lines.added[0].meta${'[0]'.repeat(256)}`, 'unsupported scalar value');
    });

    test('a Date at the limit is a leaf and does not count', () => {
      let value = new Date(1);
      for (let level = 0; level < 256; level += 1) value = [value];

      expect(depthOf(update(order({ payload: value })).payload, (list) => (Array.isArray(list) ? list[0] : undefined)))
        .toBe(257);
    });

    test('a 5000-deep JSON value is an INVALID_INPUT, never a RangeError', () => {
      expectInvalid(() => update(order({ payload: deepJson(5000) })), `input.payload${'[0]'.repeat(256)}`,
        'unsupported scalar value');
      expectInvalid(() => coerced({ id: '1', payload: deepJson(5000) }), `input.payload${'[0]'.repeat(256)}`,
        'unsupported scalar value');
      expectInvalid(() => coerced({ id: '1', nope: deepJson(5000) }), `input.nope${'[0]'.repeat(256)}`,
        'unsupported scalar value');
      expectInvalid(() => readDeleteTarget({ id: '1', version: deepJson(5000) }, { protectedType: true }),
        `input.version${'[0]'.repeat(256)}`, 'unsupported scalar value');
    });

    test('a snapshot at the limit survives the copy mode', () => {
      const source = update(order({ payload: nestedLists(256) }));

      expect(depthOf(update(source, { mode: 'copy' }).payload, (list) => list[0])).toBe(256);
    });
  });

  test('plain data is deep-copied', () => {
    const payload = { a: [1, { b: new Date(3) }], c: { d: null, e: undefined }, f: 'x' };
    const result = update(order({ payload })).payload;

    expect(result).toEqual(payload);
    expect(result).not.toBe(payload);
    expect(result.a).not.toBe(payload.a);
    expect(result.a[1]).not.toBe(payload.a[1]);
    expect(result.a[1].b).not.toBe(payload.a[1].b);
    expect(result.a[1].b.getTime()).toBe(3);
    expect(result.c).not.toBe(payload.c);
    expect(Object.hasOwn(result.c, 'e')).toBe(true);
  });

  test('references are shared inside one value and never across positions', () => {
    const inner = { k: 1 };
    const when = new Date(4);
    const payload = { first: inner, second: inner, list: [inner, when, when] };
    const result = update(order({
      payload,
      lines: { added: [{ name: 'a', meta: inner }, { name: 'b', meta: inner }] },
    }));

    expect(result.payload.first).not.toBe(inner);
    expect(result.payload.second).toBe(result.payload.first);
    expect(result.payload.list[0]).toBe(result.payload.first);
    expect(result.payload.list[2]).toBe(result.payload.list[1]);
    expect(result.payload.list[1]).not.toBe(when);
    expect(result.lines.added[0].meta).not.toBe(result.payload.first);
    expect(result.lines.added[0].meta).not.toBe(result.lines.added[1].meta);
    expect(result.lines.added[0].meta).toEqual(inner);
  });

  test('an own __proto__ key from JSON.parse stays an own data property and the prototype stays', () => {
    const payload = JSON.parse('{"__proto__": 1, "nested": {"__proto__": {"polluted": true}}, "list": [{"__proto__": 2}]}');
    const result = update(order({ payload })).payload;

    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__').value).toBe(1);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    const nested = Object.getOwnPropertyDescriptor(result.nested, '__proto__').value;
    expect(nested).toEqual({ polluted: true });
    expect(nested).not.toBe(Object.getOwnPropertyDescriptor(payload.nested, '__proto__').value);
    expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result.list[0], '__proto__').value).toBe(2);
    expect({}.polluted).toBeUndefined();
  });

  test('a null-prototype object keeps its prototype and is not frozen', () => {
    const payload = Object.assign(Object.create(null), { a: Object.assign(Object.create(null), { b: 1 }) });
    const result = update(order({ payload: deepFreeze(payload) })).payload;

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result.a)).toBeNull();
    expect(result.a.b).toBe(1);
    expect(Object.isExtensible(result)).toBe(true);
    expect(Object.isFrozen(result.a)).toBe(false);
  });

  test.each([
    ['a Buffer', () => Buffer.from('abc')],
    ['a Map', () => new Map([[1, 2]])],
    ['a Set', () => new Set([1])],
    ['a class instance', () => new Money(3)],
    ['an ObjectId-like instance', () => new ObjectIdLike('507f1f77bcf86cd799439011')],
    ['a typed array', () => new Uint8Array(2)],
    ['a RegExp', () => /x/],
    ['a function', () => () => 1],
    ['a symbol', () => Symbol('s')],
  ])('%s is an unsupported scalar value, at any depth', (_, make) => {
    expectInvalid(() => update(order({ payload: make() })), 'input.payload', 'unsupported scalar value');
    expectInvalid(() => update(order({ payload: { deep: make() } })), 'input.payload.deep', 'unsupported scalar value');
    expectInvalid(() => update(order({ payload: [1, make()] })), 'input.payload[1]', 'unsupported scalar value');
    expectInvalid(() => update(order({ lines: { added: [{ name: 'a', price: make() }] } })),
      'input.lines.added[0].price', 'unsupported scalar value');
  });

  test('an accessor, a hidden member, a symbol key, a sparse array and a cycle inside plain data fail', () => {
    const getter = vi.fn(() => 1);
    const withGetter = {};
    Object.defineProperty(withGetter, 'x', { get: getter, enumerable: true });
    const hidden = {};
    Object.defineProperty(hidden, 'x', { value: 1, enumerable: false });
    const sparse = [1];
    sparse[2] = 3;
    const cyclic = { a: {} };
    cyclic.a.back = cyclic;

    expectInvalid(() => update(order({ payload: { w: withGetter } })), 'input.payload.w.x', 'accessor property');
    expect(getter).not.toHaveBeenCalled();
    expectInvalid(() => update(order({ payload: { h: hidden } })), 'input.payload.h.x',
      'non-enumerable or symbol-keyed property');
    expectInvalid(() => update(order({ payload: { s: { [Symbol('k')]: 1 } } })), 'input.payload.s',
      'non-enumerable or symbol-keyed property');
    expectInvalid(() => update(order({ payload: { list: sparse } })), 'input.payload.list', 'expected a dense list');
    expectInvalid(() => update(order({ payload: cyclic })), 'input.payload.a.back', 'cycle');
  });

  test('the value is never reached through a scalar function', () => {
    const parse = vi.fn((value) => value);
    const Tracked = new GraphQLScalarType({ name: 'Tracked', parseValue: parse, parseLiteral: parse, serialize: parse });
    const Holder = new GraphQLInputObjectType({ name: 'TrackedHolder', fields: { value: { type: Tracked } } });

    expect(snapshot({ value: { a: 1 } }, Holder)).toEqual({ value: { a: 1 } });
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('record keys (D1)', () => {
  const badKeys = [
    ['a plain object', () => ({ $ne: null })],
    ['an array', () => ['a']],
    ['a Date', () => new Date()],
    ['an ObjectId-like instance', () => new ObjectIdLike('507f1f77bcf86cd799439011')],
  ];

  // Each record-key position with a declared type that is ID or IdInputType.id.
  const stringPositions = [
    ['the top-level id', (key) => order({ id: key }), 'input.id'],
    ['updated[].id', (key) => order({ lines: { updated: [{ id: 'l0' }, { id: key }] } }), 'input.lines.updated[1].id'],
    ['updated[].id of a protected collection', (key) => order({ items: { updated: [{ id: key, version: 1 }] } }),
      'input.items.updated[0].id'],
    ['a deleted item', (key) => order({ lines: { deleted: ['l0', key] } }), 'input.lines.deleted[1]'],
    ['RecordVersionRef.id', (key) => order({ items: { deleted: [{ id: key, version: 1 }] } }),
      'input.items.deleted[0].id'],
    ['IdInputType.id', (key) => order({ customer: { id: key } }), 'input.customer.id'],
    ['IdInputType.id in a list', (key) => order({ customers: [{ id: 'c0' }, { id: key }] }), 'input.customers[1].id'],
  ];

  describe.each(stringPositions)('%s', (_, make, path) => {
    test.each(badKeys)('%s fails with the string hint', (__, bad) => {
      expectInvalid(() => update(make(bad())), path, STRING_KEY);
    });

    test.each([
      ['a number', 5],
      ['a boolean', true],
      ['a bigint', 5n],
      ['a symbol', Symbol('id')],
    ])('%s fails with the string hint', (__, bad) => {
      expectInvalid(() => update(make(bad)), path, STRING_KEY);
    });

    test('a string passes', () => {
      expect(() => update(make('507f1f77bcf86cd799439011'))).not.toThrow();
    });
  });

  test('a null deleted item is skipped later, so it passes', () => {
    expect(update(order({ lines: { deleted: [null, 'l1'] } })).lines.deleted).toEqual([null, 'l1']);
  });

  test('the check fails before the rest of the input is read', () => {
    expectInvalid(() => update({ id: { $ne: null }, version: 1, title: 't', nope: 1 }), 'input.id', STRING_KEY);
  });

  test('the message hints at the string and never names the value', () => {
    const error = failure(() => update(order({ id: new ObjectIdLike('507f1f77bcf86cd799439011') })));

    expect(error.message).toBe('Invalid input at input.id: pass the ID as a string, for example String(record._id)');
    expect(error.message).not.toContain('507f1f77bcf86cd799439011');
  });

  test('a key declared with another scalar accepts any primitive', () => {
    const counter = (extra) => snapshot({ id: 7, ...extra }, CounterInputForUpdate, { topLevelId: true });

    expect(counter({}).id).toBe(7);
    expect(snapshot({ id: '7' }, CounterInputForUpdate, { topLevelId: true }).id).toBe('7');
    expect(snapshot({ id: 7n }, CounterInputForUpdate, { topLevelId: true }).id).toBe(7n);
    expect(counter({ parts: { updated: [{ id: 3, qty: 1 }], deleted: [4, 5] } }).parts)
      .toEqual({ updated: [{ id: 3, qty: 1 }], deleted: [4, 5] });
  });

  test.each(badKeys)('a key declared with another scalar refuses %s with the primitive hint', (_, make) => {
    const counter = (extra) => snapshot({ id: 7, ...extra }, CounterInputForUpdate, { topLevelId: true });

    expectInvalid(() => snapshot({ id: make() }, CounterInputForUpdate, { topLevelId: true }), 'input.id', PRIMITIVE_KEY);
    expectInvalid(() => counter({ parts: { updated: [{ id: make() }] } }), 'input.parts.updated[0].id', PRIMITIVE_KEY);
    expectInvalid(() => counter({ parts: { deleted: [1, make()] } }), 'input.parts.deleted[1]', PRIMITIVE_KEY);
  });

  test('without topLevelId the top-level id is an ordinary field', () => {
    const result = snapshot({ id: 7 }, CounterInputForUpdate);

    expect(result.id).toBe(7);
    expect(() => snapshot({ id: { $ne: null } }, CounterInputForUpdate)).not.toThrow();
    expectInvalid(() => snapshot({ id: new Money(1) }, CounterInputForUpdate), 'input.id', 'unsupported scalar value');
  });

  test('the id of an embedded value is no record key', () => {
    expect(update(order({ address: { id: 7 } })).address).toEqual({ id: 7 });
    expect(update(order({ address: { id: { code: 1 } } })).address).toEqual({ id: { code: 1 } });
    expectInvalid(() => update(order({ address: { id: new ObjectIdLike('a') } })), 'input.address.id',
      'unsupported scalar value');
  });

  test('RecordVersionRef is known by default and by the option', () => {
    const OtherRef = new GraphQLInputObjectType({
      name: 'OtherRef', fields: { id: { type: nonNull(GraphQLID) }, version: { type: nonNull(RecordVersion) } },
    });
    const Holder = new GraphQLInputObjectType({
      name: 'RefHolder', fields: { refs: { type: listOf(RecordVersionRef) }, others: { type: listOf(OtherRef) } },
    });

    expectInvalid(() => snapshot({ refs: [{ id: 5, version: 1 }] }, Holder), 'input.refs[0].id', STRING_KEY);
    expect(() => snapshot({ others: [{ id: 5, version: 1 }] }, Holder)).not.toThrow();
    expectInvalid(() => snapshot({ others: [{ id: 5, version: 1 }] }, Holder, { recordVersionRef: OtherRef }),
      'input.others[0].id', STRING_KEY);
  });
});

describe('the nesting of an input is limited', () => {
  const NESTED = 'input is nested too deeply';
  const MODES = ['programmatic', 'coerced', 'copy'];
  const TreeInput = new GraphQLInputObjectType({
    name: 'TreeInput',
    fields: () => ({
      name: { type: GraphQLString }, meta: { type: JSONScalar }, next: { type: TreeInput }, children: { type: listOf(TreeInput) },
    }),
  });
  const tree = (value, options = {}) => snapshot(value, TreeInput, options);
  // `levels` input objects, each the `next` of the one above, the deepest being `leaf`.
  const objects = (levels, leaf = {}) => {
    let value = leaf;
    for (let level = 1; level < levels; level += 1) value = { next: value };
    return value;
  };
  // `levels` containers that alternate between an input object, at odd levels, and its `children` list.
  const alternating = (levels) => {
    let value = levels % 2 === 1 ? {} : [];
    for (let level = levels - 1; level >= 1; level -= 1) value = level % 2 === 1 ? { children: value } : [value];
    return value;
  };
  const alternatingPath = (level) => `input${Array.from({ length: level - 1 }, (_, index) => (index % 2 === 0 ? '.children' : '[0]')).join('')}`;
  const depthOf = (value, step) => {
    let depth = 0;
    for (let current = value; current !== undefined; current = step(current)) depth += 1;
    return depth;
  };

  test.each(MODES)('256 nested input objects are walked and the 257th is refused at its path (%s)', (mode) => {
    expect(depthOf(tree(objects(256), { mode }), (object) => object.next)).toBe(256);
    expectInvalid(() => tree(objects(257), { mode }), `input${'.next'.repeat(256)}`, NESTED);
  });

  test.each(MODES)('lists count as levels too (%s)', (mode) => {
    expect(depthOf(tree(alternating(256), { mode }), (level) => (Array.isArray(level) ? level[0] : level.children)))
      .toBe(256);
    expectInvalid(() => tree(alternating(257), { mode }), alternatingPath(257), NESTED);
  });

  test.each(['programmatic', 'coerced'])('a 5000-deep input is an INVALID_INPUT, never a RangeError (%s)', (mode) => {
    expectInvalid(() => tree(objects(5000), { mode }), `input${'.next'.repeat(256)}`, NESTED);
    expectInvalid(() => tree(alternating(5000), { mode }), alternatingPath(257), NESTED);
  });

  test('a scalar value at the deepest input level keeps its own limit', () => {
    let meta = [];
    for (let level = 1; level < 256; level += 1) meta = [meta];
    const walked = tree(objects(256, { meta }));

    let deepest = walked;
    while (deepest.next !== undefined) deepest = deepest.next;
    expect(deepest.meta).toEqual(meta);
  });
});

describe('modes', () => {
  const GraphQLShaped = () => Object.assign(Object.create(null), {
    id: '507f1f77bcf86cd799439011',
    version: 2,
    title: 'Spring order',
    color: RED,
    payload: { a: [1] },
    lines: Object.assign(Object.create(null), { deleted: ['l1'] }),
  });

  describe('coerced', () => {
    const coerced = (value, options = {}) => update(value, { mode: 'coerced', ...options });

    test('a GraphQL-shaped input comes back as new plain containers', () => {
      const source = GraphQLShaped();
      const result = coerced(source);

      expect(result).toEqual({ ...source, lines: { deleted: ['l1'] } });
      expect(result).not.toBe(source);
      expect(result.lines).not.toBe(source.lines);
      expect(result.payload).not.toBe(source.payload);
      expect(result.payload.a).not.toBe(source.payload.a);
      expect(result.color).toBe(RED);
    });

    test('the structure rules do not apply', () => {
      const result = coerced({ id: '1', nope: { a: 1 }, color: 'purple', address: [1] });

      expect(result.nope).toEqual({ a: 1 });
      expect(result.color).toBe('purple');
      expect(result.address).toEqual([1]);
      expect(() => coerced({ id: '1', state: 'CLOSED' }, { stateManaged: true })).not.toThrow();
      expect(() => coerced({ id: '1', tags: 'a' })).not.toThrow();
    });

    test('nullability is left to GraphQL', () => {
      expect(coerced({ id: '1', title: null, tags: ['a', null] })).toEqual({ id: '1', title: null, tags: ['a', null] });
      expect(coerced({ id: '1' })).toEqual({ id: '1' });
    });

    test('a null item stays null and an undefined one is dropped like in any mode', () => {
      expect(coerced({ id: '1', lines: { deleted: ['a', undefined] } }).lines.deleted).toEqual(['a', null]);
    });

    test('the scalar rules apply', () => {
      expectInvalid(() => coerced({ id: '1', payload: Buffer.from('a') }), 'input.payload', 'unsupported scalar value');
      expectInvalid(() => coerced({ id: '1', payload: { deep: new Map() } }), 'input.payload.deep',
        'unsupported scalar value');
      expectInvalid(() => coerced({ id: '1', lines: { added: [{ name: 'a', price: new Money(1) }] } }),
        'input.lines.added[0].price', 'unsupported scalar value');
      expectInvalid(() => coerced({ id: '1', nope: new Money(1) }), 'input.nope', 'unsupported scalar value');
      const cyclic = {};
      cyclic.self = cyclic;
      expectInvalid(() => coerced({ id: '1', payload: cyclic }), 'input.payload.self', 'cycle');
    });

    test('the record-key rules apply', () => {
      expectInvalid(() => coerced({ id: { $ne: null } }), 'input.id', STRING_KEY);
      expectInvalid(() => coerced({ id: '1', lines: { updated: [{ id: ['a'] }] } }), 'input.lines.updated[0].id',
        STRING_KEY);
      expectInvalid(() => coerced({ id: '1', lines: { deleted: [new Date()] } }), 'input.lines.deleted[0]', STRING_KEY);
      expectInvalid(() => coerced({ id: '1', items: { deleted: [{ id: 5, version: 1 }] } }),
        'input.items.deleted[0].id', STRING_KEY);
      expectInvalid(() => coerced({ id: '1', customer: { id: new ObjectIdLike('a') } }), 'input.customer.id', STRING_KEY);
    });

    test('topLevelId still makes the id required', () => {
      expectRequired(() => coerced({ title: 't' }), 'input.id');
      expectRequired(() => coerced({ id: null }), 'input.id');
      expect(() => update({ title: 't' }, { mode: 'coerced', topLevelId: false })).not.toThrow();
    });

    test('a cycle of containers is still refused', () => {
      const node = { name: 'a' };
      node.next = node;

      expectInvalid(() => coerced({ id: '1', chain: node }), 'input.chain.next', 'cycle');
    });
  });

  describe('copy', () => {
    const copy = (value, options = {}) => update(value, { mode: 'copy', ...options });

    test('copies a snapshot into new containers, dates and plain data', () => {
      const shared = { k: 1 };
      const source = update(order({
        placedAt: new Date(5),
        payload: { a: shared, b: shared, c: [shared] },
        lines: { added: [{ name: 'x', color: RED }], deleted: ['l1', null] },
        customer: { id: 'c1' },
      }));
      const result = copy(source);

      expect(result).toEqual(source);
      expect(result).not.toBe(source);
      expect(result.lines).not.toBe(source.lines);
      expect(result.lines.added[0]).not.toBe(source.lines.added[0]);
      expect(result.lines.added[0].color).toBe(RED);
      expect(result.placedAt).not.toBe(source.placedAt);
      expect(result.placedAt.getTime()).toBe(5);
      expect(result.payload.a).not.toBe(source.payload.a);
      expect(result.payload.b).toBe(result.payload.a);
      expect(result.payload.c[0]).toBe(result.payload.a);
    });

    test('each copy is independent of the snapshot and of the others', () => {
      const source = update(order({ tags: ['a'], lines: { added: [{ name: 'x', meta: { a: [1] } }] } }));
      const first = copy(source);
      const second = copy(source);

      first.tags.push('b');
      first.lines.added[0].meta.a.push(2);
      first.lines.added[0].name = 'changed';

      expect(second.tags).toEqual(['a']);
      expect(second.lines.added[0]).toEqual({ name: 'x', meta: { a: [1] } });
      expect(source.lines.added[0]).toEqual({ name: 'x', meta: { a: [1] } });
    });

    test('a frozen snapshot gives an extensible copy', () => {
      const result = copy(deepFreeze(update(order({ tags: ['a'], address: { street: 's' } }))));

      expect(Object.isExtensible(result)).toBe(true);
      expect(Object.isExtensible(result.tags)).toBe(true);
      expect(Object.isExtensible(result.address)).toBe(true);
    });

    test('nothing is checked', () => {
      const money = new Money(1);
      const id = { $ne: null };
      const result = copy({
        id, nope: 1, title: null, color: 'purple', address: 3, tags: 'a', payload: { money }, customer: { id: [1] },
      });

      expect(result.id).toEqual(id);
      expect(result.id).not.toBe(id);
      expect(result.nope).toBe(1);
      expect(result.title).toBeNull();
      expect(result.color).toBe('purple');
      expect(result.payload.money).toBe(money);
      expect(result.customer).toEqual({ id: [1] });
      expect(copy({ title: 't' })).toEqual({ title: 't' });
    });

    test('a null or undefined value comes back as it is', () => {
      expect(copy(null)).toBeNull();
      expect(copy(undefined)).toBeUndefined();
    });
  });

  test('an unknown mode is refused', () => {
    expect(() => update(order(), { mode: 'lenient' })).toThrow(TypeError);
  });

  test('the root must be an input object type', () => {
    expect(() => snapshotOperationInput({}, GraphQLString)).toThrow(TypeError);
    expect(() => snapshotOperationInput({}, listOf(OrderInputForUpdate))).toThrow(TypeError);
    expect(snapshotOperationInput({ name: 'n' }, nonNull(LooseInputForUpdate))).toEqual({ name: 'n' });
  });
});

describe('readDeleteTarget', () => {
  test('an unprotected type takes an id only', () => {
    expect(readDeleteTarget({ id: '1' }, { protectedType: false })).toEqual({ id: '1' });
    expect(readDeleteTarget({ id: '1' }, {})).toEqual({ id: '1' });
    expect(readDeleteTarget({ id: '1', version: undefined }, { protectedType: false })).toEqual({ id: '1' });
  });

  test('version is an unknown field on an unprotected type', () => {
    expectInvalid(() => readDeleteTarget({ id: '1', version: 1 }, { protectedType: false }), 'input.version',
      'unknown field');
    expectInvalid(() => readDeleteTarget({ id: '1', version: null }, { protectedType: false }), 'input.version',
      'unknown field');
    expectInvalid(() => readDeleteTarget({ id: '1', version: 1 }), 'input.version', 'unknown field');
  });

  test('version is required on a protected type', () => {
    expect(readDeleteTarget({ id: '1', version: 3 }, { protectedType: true })).toEqual({ id: '1', version: 3 });
    expectRequired(() => readDeleteTarget({ id: '1' }, { protectedType: true }), 'input.version');
    expectRequired(() => readDeleteTarget({ id: '1', version: null }, { protectedType: true }), 'input.version');
    expectRequired(() => readDeleteTarget({ id: '1', version: undefined }, { protectedType: true }), 'input.version');
  });

  test('the version is only checked for presence', () => {
    expect(readDeleteTarget({ id: '1', version: 0 }, { protectedType: true })).toEqual({ id: '1', version: 0 });
    expect(readDeleteTarget({ id: '1', version: '2' }, { protectedType: true })).toEqual({ id: '1', version: '2' });
    expectInvalid(() => readDeleteTarget({ id: '1', version: new Money(1) }, { protectedType: true }),
      'input.version', 'unsupported scalar value');
  });

  test('any other key is an unknown field', () => {
    expectInvalid(() => readDeleteTarget({ id: '1', _id: '1' }, { protectedType: false }), 'input._id', 'unknown field');
    expectInvalid(() => readDeleteTarget({ id: '1', version: 1, name: 'n' }, { protectedType: true }), 'input.name',
      'unknown field');
    expectInvalid(() => readDeleteTarget({ id: '1', name: undefined, extra: 1 }, { protectedType: false }),
      'input.extra', 'unknown field');
  });

  test('the id is required', () => {
    expectRequired(() => readDeleteTarget({}, { protectedType: false }), 'input.id');
    expectRequired(() => readDeleteTarget({ id: null }, { protectedType: false }), 'input.id');
    expectRequired(() => readDeleteTarget({ id: undefined, version: 1 }, { protectedType: true }), 'input.id');
    expectRequired(() => readDeleteTarget({ version: 1 }, { protectedType: true }), 'input.id');
  });

  test('a missing or null target fails at the path', () => {
    expectRequired(() => readDeleteTarget(undefined, { protectedType: false }), 'input');
    expectRequired(() => readDeleteTarget(null, { protectedType: true }), 'input');
    expectRequired(() => readDeleteTarget(null, { protectedType: true, path: 'operations[1].delete' }),
      'operations[1].delete');
  });

  test('the id is a record key: only a string', () => {
    for (const bad of [{ $ne: null }, ['a'], new Date(), new ObjectIdLike('507f1f77bcf86cd799439011'), 5, true, 5n]) {
      expectInvalid(() => readDeleteTarget({ id: bad }, { protectedType: false }), 'input.id', STRING_KEY);
      expectInvalid(() => readDeleteTarget({ id: bad, version: 1 }, { protectedType: true }), 'input.id', STRING_KEY);
    }
  });

  test('the target must be a plain or null-prototype object', () => {
    expect(readDeleteTarget(Object.assign(Object.create(null), { id: '1' }), { protectedType: false })).toEqual({ id: '1' });
    expectInvalid(() => readDeleteTarget('1', { protectedType: false }), 'input', 'expected a plain object');
    expectInvalid(() => readDeleteTarget(['1'], { protectedType: false }), 'input', 'expected a plain object');
    expectInvalid(() => readDeleteTarget(new Money(1), { protectedType: false }), 'input', 'expected a plain object');
    expectInvalid(() => readDeleteTarget('1', { protectedType: false, path: 'target' }), 'target',
      'expected a plain object');
  });

  test('accessors, hidden and symbol-keyed properties fail', () => {
    const getter = vi.fn(() => '1');
    const withGetter = {};
    Object.defineProperty(withGetter, 'id', { get: getter, enumerable: true });
    const hidden = { id: '1' };
    Object.defineProperty(hidden, 'version', { value: 1, enumerable: false });

    expectInvalid(() => readDeleteTarget(withGetter, { protectedType: false }), 'input.id', 'accessor property');
    expect(getter).not.toHaveBeenCalled();
    expectInvalid(() => readDeleteTarget(hidden, { protectedType: true }), 'input.version',
      'non-enumerable or symbol-keyed property');
    expectInvalid(() => readDeleteTarget({ id: '1', [Symbol('k')]: 1 }, { protectedType: false }), 'input',
      'non-enumerable or symbol-keyed property');
  });

  test('a key without a descriptor is refused, never a TypeError', () => {
    const ghost = new Proxy({}, { ownKeys: () => ['id'] });

    expectInvalid(() => readDeleteTarget(ghost, { protectedType: false }), 'input.id',
      'non-enumerable or symbol-keyed property');
  });

  test('the result is a new object and a frozen source is accepted', () => {
    const source = deepFreeze({ id: '1', version: 2 });
    const result = readDeleteTarget(source, { protectedType: true });

    expect(result).toEqual({ id: '1', version: 2 });
    expect(result).not.toBe(source);
    expect(Object.isExtensible(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['id', 'version']);
  });
});

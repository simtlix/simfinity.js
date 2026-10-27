import { afterEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLObjectType, GraphQLString, GraphQLUnionType, getNamedType, graphql,
  printSchema, printType,
} from 'graphql';

import {
  QLOperator, createQueryPlan, createRuntime, describeModels, resolveModelPath,
} from '../packages/core/src/index.js';
import { configureQueryLimits } from '../packages/core/src/query-limits.js';
import { graphqlStep, modelStep } from '../packages/core/src/query-emptiness.js';
import { frameCollectionPaths, frameUnits, validateQuantifiedGroups } from '../packages/core/src/query-frames.js';
import { createEvaluator } from './helpers/collection-frames.js';
import { LIST_OPERATOR_CASES, createListOperatorTypes, listOperatorArgs, listOperatorStore } from './helpers/list-operators.js';

// #108 part 4: the list operators CONTAINS_ALL (issue 3.3) and IIN (IN ignoring case), without a database. This file
// holds the enum, the shared module's validators and path rules, the shared validator's order of checks in GraphQL and
// model contexts, createQueryPlan's nodes, the shape and anchors of hand-built implicit groups, the frame rewrite and the memory
// evaluator's branches. The runtime gates are tested in list-operators-runtime.test.js, and each backend's forms with
// that backend.

// The 18 operators before part 4, in QLOperator order, and the two that part 4 appends.
const EARLIER = [
  'EQ', 'LT', 'GT', 'LTE', 'GTE', 'BTW', 'NE', 'IN', 'NIN', 'LIKE', 'ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH',
  'IENDS_WITH', 'IEQ', 'IS_EMPTY', 'IS_NOT_EMPTY',
];
const LIST = ['CONTAINS_ALL', 'IIN'];
const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];

// Loaded on use, so that each test of the shared module fails on its own where the module lacks a name.
const OPERATORS_MODULE = '@simtlix/simfinity-core/internal/query-operators';
const loadOperators = () => import(/* @vite-ignore */ OPERATORS_MODULE);

// The messages of the spec's section 2.5.
const SHORTHAND = 'The shorthand excludes them; use an explicit group';
const OBJECT_END = 'Filter on object field requires a scalar path';
const crossing = (steps) => `CONTAINS_ALL cannot cross the reference ${steps} inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead`;
const notList = (path) => `CONTAINS_ALL requires a list field, or a field reached through an embedded list; ${path} is not one`;
const notSupported = (operator) => `The ${operator} filter operator is not supported by this query compiler`;
const NO_QUANTIFIERS = 'Quantified groups are not supported by this query compiler';

const errorOf = (body) => {
  try {
    body();
  } catch (error) {
    return error;
  }
  return null;
};
// The code, status and message of what `body` throws, or null.
const rejection = (body) => {
  const error = errorOf(body);
  return error && { code: error.extensions?.code ?? null, status: error.extensions?.status ?? null, message: error.message };
};
const invalidValue = (message) => ({ code: 'INVALID_FILTER_VALUE', status: 400, message });
// `[, value]`, written without a sparse literal: a hole at index 0, then the value.
const holeThen = (value) => Object.assign(new Array(2), { 1: value });

const condition = (field, operator, value) => ({ field, operator, value });
const grouped = (...conditions) => ({ AND: [{ conditions }] });
const implicit = (path, conditions, extra = {}) => ({ path, conditions, __implicit: true, ...extra });
const predicate = (path, operator, value) => ({ kind: 'predicate', path: path.split('.'), operator, value });

// The fixture of the spec's section 9.2, with the PostgreSQL prefix. No database is involved.
const types = createListOperatorTypes('Ql');
const registrations = [types.Shop, types.Review, types.Note, types.Label, types.Item].map((gqltype) => ({ gqltype }))
  .concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
const models = describeModels(registrations);
const plainModels = { entities: models.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
const ITEM = types.Item.name;
const SHOP = types.Shop.name;
const enabled = { quantifiers: true, referenceEmptiness: true, operation: 'find' };
const contexts = [
  ['GraphQL', { gqltype: types.Item }],
  ['models', { models: plainModels, entity: ITEM }],
];
const callers = [
  ['GraphQL', (args, entity = ITEM) => validateQuantifiedGroups(args, { ...enabled, gqltype: types[entity.slice(2)] })],
  ['models', (args, entity = ITEM) => validateQuantifiedGroups(args, { ...enabled, models: plainModels, entity })],
  ['createQueryPlan', (args, entity = ITEM) => createQueryPlan(models, entity, args)],
];

// A local copy of the recursive CfCategory type of tests/collection-frames.test.js, with an interface and a union
// field: abstract carriers exist only in GraphQL contexts, since describeModels rejects them.
const Abstract = new GraphQLInterfaceType({ name: 'QlAbstract', fields: { name: { type: GraphQLString } } });
const UnionMember = new GraphQLObjectType({ name: 'QlUnionMember', fields: { name: { type: GraphQLString } } });
const Union = new GraphQLUnionType({ name: 'QlUnion', types: [UnionMember] });
const Category = new GraphQLObjectType({
  name: 'QlCategory',
  fields: () => ({
    id: { type: GraphQLID }, name: { type: GraphQLString }, n: { type: GraphQLInt },
    tags: { type: new GraphQLList(GraphQLString) }, abstract: { type: Abstract }, union: { type: Union },
    children: { type: new GraphQLList(Category), extensions: { relation: { connectionField: 'parent' } } },
    parent: { type: Category, extensions: { relation: {} } },
    lines: { type: new GraphQLList(Category), extensions: { relation: { embedded: true } } },
    detail: { type: Category, extensions: { relation: { embedded: true } } },
  }),
});
const categoryContext = { ...enabled, gqltype: Category };

// The steps of a path as the shared validator classifies them (graphqlStep on GraphQL types, modelStep on field
// descriptions), and the field descriptions resolveModelPath returns, which PostgreSQL's hand-built plans read.
const graphqlSteps = (gqltype, path) => {
  let current = gqltype;
  return path.split('.').map((name) => {
    const field = current.getFields()[name];
    current = getNamedType(field.type);
    return graphqlStep(name, field);
  });
};
const modelSteps = (entity, path) => {
  let fields = models.entities.find((item) => item.name === entity).fields;
  return path.split('.').map((name) => {
    const field = fields.find((item) => item.name === name);
    fields = field.kind === 'embedded' ? field.fields : models.entities.find((item) => item.name === field.target)?.fields;
    return modelStep(field);
  });
};
const stepKinds = [
  ['graphqlStep', (entity, path) => graphqlSteps(types[entity.slice(2)], path)],
  ['modelStep', (entity, path) => modelSteps(entity, path)],
  ['resolveModelPath', (entity, path) => resolveModelPath(models, entity, path)],
];

describe('QLOperator', () => {
  it('appends CONTAINS_ALL and then IIN after IS_NOT_EMPTY, with names equal to values', () => {
    expect(QLOperator.getValues().map((entry) => entry.value)).toEqual([...EARLIER, ...LIST]);
    expect(QLOperator.getValues().map((entry) => entry.name)).toEqual([...EARLIER, ...LIST]);
  });

  it('publishes them in the generated SDL and in introspection, and changes no input type', async () => {
    const runtime = createRuntime({
      bind() {},
      prepare() {},
      createModel: (gqltype) => ({ name: gqltype.name }),
      castId: String,
      withTransaction: async (session, body) => body(session || {}),
      getById: async () => null,
      find: async () => [],
      count: async () => 0,
      aggregate: async () => [],
      findChildren: async () => [],
    });
    const Thing = new GraphQLObjectType({ name: 'QlThing', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    runtime.connect(null, Thing, 'qlThing', 'qlThings');
    const schema = runtime.createSchema();
    expect(printSchema(schema)).toContain(`enum QLOperator {\n${[...EARLIER, ...LIST].map((name) => `  ${name}`).join('\n')}\n}`);
    const result = await graphql({ schema, source: '{ __type(name: "QLOperator") { enumValues { name } } }' });
    expect(result.data.__type.enumValues.map((value) => value.name).slice(-2)).toEqual(LIST);
    // The operators take the existing operator and value fields.
    expect(printType(schema.getType('QLFilter'))).toBe('input QLFilter {\n  operator: QLOperator\n  value: QLValue\n}');
    expect(printType(schema.getType('QLFilterCondition')))
      .toBe('input QLFilterCondition {\n  field: String!\n  operator: QLOperator\n  value: QLValue\n  path: String\n}');
  });
});

describe('shared list operator module', () => {
  it('lists the operators that take an array value, frozen', async () => {
    const { LIST_VALUE_OPERATORS } = await loadOperators();
    expect(LIST_VALUE_OPERATORS).toEqual(['IN', 'NIN', 'BTW', 'CONTAINS_ALL', 'IIN']);
    expect(Object.isFrozen(LIST_VALUE_OPERATORS)).toBe(true);
  });

  it('tells which operators take an array value', async () => {
    const { takesListValue } = await loadOperators();
    for (const operator of ['IN', 'NIN', 'BTW', 'CONTAINS_ALL', 'IIN']) expect(takesListValue(operator), operator).toBe(true);
    for (const operator of ['EQ', 'NE', 'LIKE', 'IEQ', 'IS_EMPTY', 'contains_all', 'BAD', '', null, undefined]) {
      expect(takesListValue(operator), String(operator)).toBe(false);
    }
  });

  it('honors CONTAINS_ALL and IIN declared before this version knew them', async () => {
    const { resolveQueryFeatures } = await loadOperators();
    expect([...resolveQueryFeatures({ operators: ['IEQ', 'CONTAINS_ALL', 'IIN', 'eq'] }).operators]).toEqual(['IEQ', 'CONTAINS_ALL', 'IIN']);
  });

  it('accepts CONTAINS_ALL values that are non-empty arrays of non-null scalars, and returns them unchanged', async () => {
    const { validateContainsAllValue } = await loadOperators();
    const values = [
      ['A'], ['A', 'A', 'B'], [1, 2.5], [true, false], [0, false, ''], ['A', 1, true], [new Date(0)], [new mongoose.Types.ObjectId()],
    ];
    for (const [index, value] of values.entries()) expect(validateContainsAllValue(value), `value ${index}`).toBe(value);
  });

  it('rejects other CONTAINS_ALL values with INVALID_FILTER_VALUE and the message of their value rule', async () => {
    const { validateContainsAllValue } = await loadOperators();
    const elements = 'Filter lists require non-null scalar elements';
    const cases = [
      [undefined, 'Expected a scalar filter value'], [null, 'Expected a scalar filter value'],
      [[null], elements], [[undefined], elements], [['A', null], elements], [holeThen('A'), elements], [new Array(1), elements],
      [[['A']], elements], [[{}], elements], [[{ a: 1 }], elements], [[Object.create(null)], elements],
      ['A', 'CONTAINS_ALL requires an array value'], [5, 'CONTAINS_ALL requires an array value'], [true, 'CONTAINS_ALL requires an array value'],
      [{}, 'CONTAINS_ALL requires an array value'], [new Date(0), 'CONTAINS_ALL requires an array value'],
      [[], 'CONTAINS_ALL requires a non-empty list'],
    ];
    for (const [index, [value, message]] of cases.entries()) {
      expect(rejection(() => validateContainsAllValue(value)), `case ${index}`).toEqual(invalidValue(message));
    }
  });

  it('accepts IIN values that are arrays of strings without U+0000 on String fields, the empty array included', async () => {
    const { validateTextListFilterValue } = await loadOperators();
    for (const [index, value] of [[], ['a'], ['a', 'A', 'a'], ['', '%', '_', '.*\\^$(', 'Ünïß', '\n']].entries()) {
      expect(validateTextListFilterValue('IIN', value, 'String', 'name'), `value ${index}`).toBe(value);
      expect(validateTextListFilterValue('IIN', value, 'String'), `value ${index}`).toBe(value);
    }
  });

  it('rejects IIN on fields that are not String, and other values, with INVALID_FILTER_VALUE', async () => {
    const { validateTextListFilterValue } = await loadOperators();
    const check = (value, scalar, path, message) => expect(rejection(() => validateTextListFilterValue('IIN', value, scalar, path))).toEqual(invalidValue(message));
    for (const scalar of ['ID', 'Int', 'Float', 'Boolean', 'DateTime', 'Enum', 'QlKind', undefined]) {
      check(['a'], scalar, 'kinds', 'IIN requires a String field on kinds');
      check([], scalar, 'kinds', 'IIN requires a String field on kinds');
    }
    check(['a'], 'ID', undefined, 'IIN requires a String field');
    // The field rule comes first, then the array, its elements and U+0000.
    check('x', 'Enum', 'kinds', 'IIN requires a String field on kinds');
    for (const value of [null, undefined, 'a', 5, {}, new Set(['a'])]) check(value, 'String', 'name', 'IIN requires an array value on name');
    check(null, 'String', ['shop', 'name'], 'IIN requires an array value on shop.name');
    for (const value of [[null], [undefined], [5], ['a', null], [['a']], [{}], ['a\u0000', 5], holeThen('a'), new Array(1)]) {
      check(value, 'String', 'name', 'IIN requires non-null string elements on name');
    }
    for (const value of [['a\u0000'], ['\u0000'], ['a', 'b\u0000c']]) check(value, 'String', 'name', 'IIN values cannot contain U+0000 on name');
    check(['\u0000'], 'String', undefined, 'IIN values cannot contain U+0000');
  });
});

describe('holes of sparse arrays', () => {
  it('pin: IN, NIN and BTW keep skipping holes of sparse arrays', () => {
    for (const operator of ['IN', 'NIN', 'BTW']) {
      const value = holeThen('a');
      const args = grouped(condition('name', operator, value));
      for (const [label, shape] of contexts) expect(() => validateQuantifiedGroups(args, { ...enabled, ...shape }), `${operator} ${label}`).not.toThrow();
      const { where } = createQueryPlan(models, ITEM, args);
      expect(where).toEqual({ kind: 'predicate', path: ['name'], operator, value });
      expect(where.value).toBe(value);
      expect(0 in where.value).toBe(false);
    }
  });

  it.each(callers)('rejects a hole in a CONTAINS_ALL or IIN value (%s)', (label, call) => {
    for (const value of [holeThen('a'), new Array(1)]) {
      expect(rejection(() => call(grouped(condition('tags', 'CONTAINS_ALL', value))))).toEqual(invalidValue('Filter lists require non-null scalar elements'));
      expect(rejection(() => call(grouped(condition('name', 'IIN', value))))).toEqual(invalidValue('IIN requires non-null string elements on name'));
    }
  });
});

describe('assertContainsAllPath', () => {
  const LIST_LEAVES = [
    'tags', 'ids', 'ranks', 'scores', 'flags', 'kinds', 'ats', 'emails', 'dims.codes', 'box.tags', 'shop.tags', 'box.shop.tags',
    'shop.slines.sku', 'lines.sku', 'parts.sku', 'lines.qty', 'lines.at', 'parts.at', 'lines.id', 'lines.notes', 'parts.codes',
    'lines.subs.code', 'lines.subs.notes', 'parts.subs.code',
  ];
  const REJECTED = [
    ...['dims', 'lines', 'box', 'shop', 'reviews'].map((path) => [path, 'MISSING_FILTER_PATH', OBJECT_END]),
    ...['box.shop', 'parts.shop', 'shop.items', 'reviews.item'].map((path) => [path, 'INVALID_FILTER_PATH', OBJECT_END]),
    // The collection rule comes before the reference rule.
    ...['reviews.tags', 'shop.items.tags', 'notes.itemId', 'parts.shop.items.tags'].map((path) => [path, 'INVALID_FILTER_PATH', SHORTHAND]),
    ...['parts.shop.tags', 'parts.shop.slines.sku'].map((path) => [path, 'INVALID_FILTER_PATH', crossing('parts.shop')]),
    ...['name', 'id', 'dims.label', 'box.label', 'shop.name'].map((path) => [path, 'INVALID_FILTER_OPERATOR', notList(path)]),
  ];

  it.each(stepKinds)('accepts every list leaf on %s steps', async (label, stepsOf) => {
    const { assertContainsAllPath } = await loadOperators();
    for (const path of LIST_LEAVES) expect(() => assertContainsAllPath(stepsOf(ITEM, path)), path).not.toThrow();
  });

  it.each(stepKinds)('rejects object ends, collections, references after embedded lists and other leaves on %s steps', async (label, stepsOf) => {
    const { assertContainsAllPath } = await loadOperators();
    for (const [path, code, message] of REJECTED) {
      expect(rejection(() => assertContainsAllPath(stepsOf(ITEM, path))), path).toEqual({ code, status: 400, message });
    }
  });

  it.each(stepKinds)('rejects QlNote.itemId, an inferred inverse reference, as a leaf that is not a list on %s steps', async (label, stepsOf) => {
    const { assertContainsAllPath } = await loadOperators();
    expect(rejection(() => assertContainsAllPath(stepsOf(types.Note.name, 'itemId'))))
      .toEqual({ code: 'INVALID_FILTER_OPERATOR', status: 400, message: notList('itemId') });
  });

  it('rejects interface and union carriers in GraphQL contexts', async () => {
    const { assertContainsAllPath } = await loadOperators();
    for (const field of ['abstract', 'union']) {
      expect(rejection(() => assertContainsAllPath(graphqlSteps(Category, field))), field)
        .toEqual({ code: 'INVALID_FILTER_OPERATOR', status: 400, message: notList(field) });
    }
  });
});

// The order of the spec's section 2.4: known, declared, then CONTAINS_ALL's collection, reference and leaf rules, then
// values. For IIN, GraphQL contexts check the String field before the value, models only after the generic value
// checks (sections 2.5 and 2.6). On an operator list without CONTAINS_ALL or IIN, a path that does not resolve and a
// path that ends at an object keep their own errors before UNSUPPORTED_QUERY. Rows that 3.15.0 answers with the same
// code and message are guards.
const ORDER_ROWS = [
  ['guard: reviews.author CONTAINS_ALL null reports the collection before the value', grouped(condition('reviews.author', 'CONTAINS_ALL', null)),
    'INVALID_FILTER_PATH', SHORTHAND],
  ['parts.shop.name CONTAINS_ALL null reports the reference after an embedded list before the value', grouped(condition('parts.shop.name', 'CONTAINS_ALL', null)),
    'INVALID_FILTER_PATH', crossing('parts.shop')],
  ['name CONTAINS_ALL null reports the leaf that is not a list before the value', grouped(condition('name', 'CONTAINS_ALL', null)),
    'INVALID_FILTER_OPERATOR', notList('name')],
  ['name CONTAINS_ALL ["x"] reports the leaf that is not a list', grouped(condition('name', 'CONTAINS_ALL', ['x'])), 'INVALID_FILTER_OPERATOR', notList('name')],
  ['guard: parts.shop.items.tags CONTAINS_ALL ["a"] reports the collection before the reference', grouped(condition('parts.shop.items.tags', 'CONTAINS_ALL', ['a'])),
    'INVALID_FILTER_PATH', SHORTHAND],
  ...['lines', 'dims', 'shop', 'reviews'].map((field) => [`guard: ${field} CONTAINS_ALL ["a"] keeps the object-end rule of every operator`,
    grouped(condition(field, 'CONTAINS_ALL', ['a'])), 'MISSING_FILTER_PATH', { GraphQL: `Filter on object field "${field}" requires a path`, models: OBJECT_END }]),
  ...['box.shop', 'reviews.item'].map((field) => [`guard: ${field} CONTAINS_ALL ["a"] keeps the object-end rule of every operator`,
    grouped(condition(field, 'CONTAINS_ALL', ['a'])), 'INVALID_FILTER_PATH', OBJECT_END]),
  ['an operator list without CONTAINS_ALL rejects reviews.author CONTAINS_ALL ["x"] before its path rule', grouped(condition('reviews.author', 'CONTAINS_ALL', ['x'])),
    'UNSUPPORTED_QUERY', notSupported('CONTAINS_ALL'), { operators: new Set(['EQ']) }],
  ['guard: an operator list without CONTAINS_ALL keeps the object-end rule of lines', grouped(condition('lines', 'CONTAINS_ALL', ['a'])),
    'MISSING_FILTER_PATH', { GraphQL: 'Filter on object field "lines" requires a path', models: OBJECT_END }, { operators: new Set(['EQ']) }],
  ['guard: an operator list without CONTAINS_ALL keeps the object-end rule of box.shop', grouped(condition('box.shop', 'CONTAINS_ALL', ['a'])),
    'INVALID_FILTER_PATH', OBJECT_END, { operators: new Set(['EQ']) }],
  ['guard: an operator list without CONTAINS_ALL keeps the unknown field nope', grouped(condition('nope', 'CONTAINS_ALL', ['a'])),
    'INVALID_FILTER_FIELD', { GraphQL: 'Unknown filter field: nope', models: 'Unknown field nope' }, { operators: new Set(['EQ']) }],
  ['guard: an operator list without CONTAINS_ALL keeps the traversal error of name.x', grouped(condition('name.x', 'CONTAINS_ALL', ['a'])),
    'INVALID_FILTER_PATH', 'Field name cannot be traversed', { operators: new Set(['EQ']) }],
  ['guard: an operator list without IIN keeps the object-end rule of shop', grouped(condition('shop', 'IIN', ['a'])),
    'MISSING_FILTER_PATH', { GraphQL: 'Filter on object field "shop" requires a path', models: OBJECT_END }, { operators: new Set(['EQ']) }],
  ['guard: an operator list without IIN keeps the unknown field nope', grouped(condition('nope', 'IIN', ['a'])),
    'INVALID_FILTER_FIELD', { GraphQL: 'Unknown filter field: nope', models: 'Unknown field nope' }, { operators: new Set(['EQ']) }],
  ['kinds IIN null reports the field that is not String in GraphQL contexts, and the missing value in models', grouped(condition('kinds', 'IIN', null)), 'INVALID_FILTER_VALUE',
    { GraphQL: 'IIN requires a String field on kinds', models: 'Expected a scalar filter value' }],
  ['kinds IIN "x" reports the field that is not String in GraphQL contexts, and the value that is not an array in models', grouped(condition('kinds', 'IIN', 'x')), 'INVALID_FILTER_VALUE',
    { GraphQL: 'IIN requires a String field on kinds', models: 'IIN requires an array value' }],
  ['name IIN null reports the missing array', grouped(condition('name', 'IIN', null)), 'INVALID_FILTER_VALUE',
    { GraphQL: 'IIN requires an array value on name', models: 'Expected a scalar filter value' }],
  ['name IIN [null] reports the null element', grouped(condition('name', 'IIN', [null])), 'INVALID_FILTER_VALUE',
    { GraphQL: 'IIN requires non-null string elements on name', models: 'Filter lists require non-null scalar elements' }],
  ['name IIN [5] reports the element that is not a string', grouped(condition('name', 'IIN', [5])), 'INVALID_FILTER_VALUE', 'IIN requires non-null string elements on name'],
];

describe.each(contexts)('the order of checks (%s)', (label, shape) => {
  it.each(ORDER_ROWS)('%s', (name, args, code, message, override = {}) => {
    const expected = typeof message === 'string' ? message : message[label];
    expect(rejection(() => validateQuantifiedGroups(args, { ...enabled, ...shape, ...override }))).toEqual({ code, status: 400, message: expected });
  });
});

// Abstract carriers exist only in GraphQL contexts, so these rows stay out of ORDER_ROWS, which runs in both.
const ABSTRACT_ROWS = [
  ['abstract CONTAINS_ALL ["x"] reports a leaf that is not a list', condition('abstract', 'CONTAINS_ALL', ['x']),
    { code: 'INVALID_FILTER_OPERATOR', status: 400, message: notList('abstract') }],
  ['union CONTAINS_ALL ["x"] reports a leaf that is not a list', condition('union', 'CONTAINS_ALL', ['x']),
    { code: 'INVALID_FILTER_OPERATOR', status: 400, message: notList('union') }],
  ['abstract IIN ["x"] reports the field that is not String', condition('abstract', 'IIN', ['x']), invalidValue('IIN requires a String field on abstract')],
];

describe('the order of checks on abstract carriers', () => {
  it('reports CONTAINS_ALL on an abstract carrier without a value as a leaf that is not a list, before the missing value', () => {
    expect(rejection(() => validateQuantifiedGroups(grouped({ field: 'abstract', operator: 'CONTAINS_ALL' }), categoryContext)))
      .toEqual({ code: 'INVALID_FILTER_OPERATOR', status: 400, message: notList('abstract') });
  });

  it.each(ABSTRACT_ROWS)('%s', (name, entry, expected) => {
    expect(rejection(() => validateQuantifiedGroups(grouped(entry), categoryContext))).toEqual(expected);
  });
});

// CONTAINS_ALL's rules on the path relative to its frame, as an explicit group and as a quantified field filter.
const FRAME_ROWS = [
  ['ANY reviews: author CONTAINS_ALL ["x"] reports the element leaf that is not a list', 'reviews', { path: 'author', operator: 'CONTAINS_ALL', value: ['x'] },
    'INVALID_FILTER_OPERATOR', notList('author')],
  ['ANY reviews: item.parts.shop.tags CONTAINS_ALL ["a"] names the reference from the element', 'reviews',
    { path: 'item.parts.shop.tags', operator: 'CONTAINS_ALL', value: ['a'] }, 'INVALID_FILTER_PATH', crossing('item.parts.shop')],
  ['guard: ANY shop: items.tags CONTAINS_ALL ["A"] keeps the shorthand reason', 'shop', { path: 'items.tags', operator: 'CONTAINS_ALL', value: ['A'] },
    'INVALID_FILTER_PATH', SHORTHAND],
];

describe.each(callers)('frame-relative paths (%s)', (label, call) => {
  it.each(FRAME_ROWS)('%s', (name, path, term, code, message) => {
    const group = { AND: [{ ANY: [{ path, conditions: [condition(term.path, term.operator, term.value)] }] }] };
    const filter = { [path]: { quantifier: 'ANY', terms: [term] } };
    for (const args of [group, filter]) expect(rejection(() => call(args)), JSON.stringify(args)).toEqual({ code, status: 400, message });
  });
});

describe.each(callers)('a record identity declared String (%s)', (label, call) => {
  const LABEL = types.Label.name;
  it('accepts IIN on Label.id and on Item.label.id, the empty list included', () => {
    for (const value of [['LB1'], []]) {
      expect(() => call(grouped(condition('id', 'IIN', value)), LABEL)).not.toThrow();
      expect(() => call(grouped(condition('label.id', 'IIN', value)))).not.toThrow();
      expect(() => call({ AND: [{ ANY: [{ path: 'label', conditions: [condition('id', 'IIN', value)] }] }] })).not.toThrow();
    }
  });

  it('pin: accepts IEQ on Label.id and on Item.label.id', () => {
    expect(() => call(grouped(condition('id', 'IEQ', 'LB1')), LABEL)).not.toThrow();
    expect(() => call(grouped(condition('label.id', 'IEQ', 'LB1')))).not.toThrow();
    expect(() => call({ AND: [{ ANY: [{ path: 'label', conditions: [condition('id', 'IEQ', 'LB1')] }] }] })).not.toThrow();
  });
});

describe('createQueryPlan', () => {
  const aggregation = (groupId) => ({ groupId, facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] });

  it('plans CONTAINS_ALL and IIN as predicates with the values as sent: not cast, duplicates kept', () => {
    const tags = ['A', 'A', 'B'];
    const ats = [new Date(0), '2024-06-01T12:30:00.000Z'];
    const names = ['ONE', 'one', 'ONE'];
    const plan = createQueryPlan(models, ITEM, {
      tags: { operator: 'CONTAINS_ALL', value: tags },
      AND: [{ conditions: [condition('ats', 'CONTAINS_ALL', ats), condition('lines.sku', 'CONTAINS_ALL', ['A']), condition('name', 'IIN', names), condition('shop.name', 'IIN', [])] }],
    });
    expect(plan.where).toEqual({ kind: 'and', terms: [
      predicate('tags', 'CONTAINS_ALL', ['A', 'A', 'B']),
      { kind: 'and', terms: [
        predicate('ats', 'CONTAINS_ALL', [new Date(0), '2024-06-01T12:30:00.000Z']), predicate('lines.sku', 'CONTAINS_ALL', ['A']),
        predicate('name', 'IIN', ['ONE', 'one', 'ONE']), predicate('shop.name', 'IIN', []),
      ] },
    ] });
    expect(plan.where.terms[0].value).toBe(tags);
    expect(plan.where.terms[1].terms[0].value).toBe(ats);
    expect(plan.where.terms[1].terms[2].value).toBe(names);
  });

  it('plans IIN through a collection as a quantified ANY node, like IN', () => {
    const quantified = (operator, value) => ({
      kind: 'quantified', quantifier: 'ANY', path: ['reviews'], where: predicate('author', operator, value), scope: null,
    });
    expect(createQueryPlan(models, ITEM, grouped(condition('reviews.author', 'IIN', ['ana']))).where).toEqual(quantified('IIN', ['ana']));
    expect(createQueryPlan(models, ITEM, { reviews: { terms: [{ path: 'author', operator: 'IIN', value: ['ana'] }] } }).where).toEqual(quantified('IIN', ['ana']));
    expect(createQueryPlan(models, ITEM, grouped(condition('reviews.author', 'IN', ['ana']))).where).toEqual(quantified('IN', ['ana']));
  });

  it.each(['ANY', 'ALL', 'NONE'])('plans CONTAINS_ALL inside an explicit %s group and a quantified field filter', (quantifier) => {
    const expected = { kind: 'quantified', quantifier, path: ['reviews'], where: predicate('tags', 'CONTAINS_ALL', ['x', 'y']), scope: null };
    const group = { AND: [{ [quantifier]: [{ path: 'reviews', conditions: [condition('tags', 'CONTAINS_ALL', ['x', 'y'])] }] }] };
    expect(createQueryPlan(models, ITEM, group).where).toEqual(expected);
    const filter = { reviews: { quantifier, terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['x', 'y'] }] } };
    expect(createQueryPlan(models, ITEM, filter).where).toEqual(expected);
  });

  it('plans IIN on an aggregate J prefix as a row filter on the joined child', () => {
    const args = { aggregation: aggregation('reviews.author'), AND: [{ conditions: [condition('reviews.author', 'IIN', ['ANA', 'bob'])] }] };
    expect(createQueryPlan(models, ITEM, args, { mode: 'aggregate' }).where).toEqual(predicate('reviews.author', 'IIN', ['ANA', 'bob']));
  });

  it('guard: rejects CONTAINS_ALL through an aggregate J prefix with the shorthand reason', () => {
    const args = { aggregation: aggregation('reviews.author'), AND: [{ conditions: [condition('reviews.tags', 'CONTAINS_ALL', ['x'])] }] };
    expect(rejection(() => createQueryPlan(models, ITEM, args, { mode: 'aggregate' }))).toEqual({ code: 'INVALID_FILTER_PATH', status: 400, message: SHORTHAND });
  });

  it('plans IIN below a J prefix as a frame anchored at the prefix', () => {
    const args = { aggregation: aggregation('items.name'), AND: [{ conditions: [condition('items.reviews.author', 'IIN', ['ana'])] }] };
    const ctx = { ...enabled, models: plainModels, entity: types.Shop.name, operation: 'aggregate', J: new Set(['items']) };
    expect(frameCollectionPaths(args, ctx).AND).toEqual([{ conditions: [], ANY: [implicit('reviews', [condition('author', 'IIN', ['ana'])], { __anchor: ['items'] })] }]);
    expect(createQueryPlan(models, types.Shop.name, args, { mode: 'aggregate' }).where).toEqual({
      kind: 'quantified', quantifier: 'ANY', path: ['reviews'], where: predicate('author', 'IIN', ['ana']), scope: null, anchor: ['items'],
    });
  });

  it('rejects both with UNSUPPORTED_QUERY for the operators of 3.7.0', () => {
    for (const [field, operator, value] of [['tags', 'CONTAINS_ALL', ['A']], ['name', 'IIN', ['a']], ['reviews.author', 'IIN', ['a']]]) {
      expect(rejection(() => createQueryPlan(models, ITEM, grouped(condition(field, operator, value)), { operators: LEGACY })))
        .toEqual({ code: 'UNSUPPORTED_QUERY', status: 400, message: notSupported(operator) });
    }
  });

  it('without quantifiers, rejects CONTAINS_ALL through a collection with the shorthand reason and its quantified forms as unsupported', () => {
    const options = { operators: QLOperator.getValues().map((entry) => entry.value), quantifiers: false };
    const plan = (args) => createQueryPlan(models, ITEM, args, options);
    expect(rejection(() => plan(grouped(condition('reviews.tags', 'CONTAINS_ALL', ['x']))))).toEqual({ code: 'INVALID_FILTER_PATH', status: 400, message: SHORTHAND });
    expect(rejection(() => plan({ AND: [{ ANY: [{ path: 'reviews', conditions: [condition('tags', 'CONTAINS_ALL', ['x'])] }] }] })))
      .toEqual({ code: 'UNSUPPORTED_QUERY', status: 400, message: NO_QUANTIFIERS });
    expect(rejection(() => plan({ reviews: { quantifier: 'ANY', terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] } })))
      .toEqual({ code: 'UNSUPPORTED_QUERY', status: 400, message: NO_QUANTIFIERS });
    expect(plan(grouped(condition('tags', 'CONTAINS_ALL', ['A']))).where).toEqual(predicate('tags', 'CONTAINS_ALL', ['A']));
  });
});

// Hand-built implicit groups (maintainer answer 4, as revised): whatever operators they hold, a path that, after any
// anchor, ends at a collection, whatever it crosses first, or at a reference without crossing a list.
const IMPLICIT_END = 'An implicit quantified path must end at a collection, or at a reference without crossing a list';
const QUANTIFIERS = ['ANY', 'ALL', 'NONE'];
// Per path, a scalar leaf of the element for EQ, IN and IIN and a list leaf for CONTAINS_ALL, each valid on its own; the
// elements of the scalar end and of the scalar-list end have no fields, so their rows read the root's name and tags,
// which the check rejects first.
const implicitRows = (rows) => rows.flatMap(([path, scalar, list]) => [
  condition(scalar, 'EQ', 'a'), condition(scalar, 'IN', ['a']), condition(list, 'CONTAINS_ALL', ['a']), condition(scalar, 'IIN', ['a']),
].map((item) => [`${path}, with ${item.field} ${item.operator}`, path, item]));
// Embedded lists, one of them nested, a single embedded object, references after an embedded list and after a
// collection, a scalar and a scalar list.
const REJECTED_ROWS = implicitRows([
  ['lines', 'sku', 'notes'], ['parts', 'sku', 'codes'], ['lines.subs', 'code', 'notes'], ['box', 'label', 'tags'],
  ['parts.shop', 'name', 'tags'], ['reviews.item', 'name', 'tags'], ['name', 'name', 'tags'], ['tags', 'name', 'tags'],
]);
// The abstract carriers of QlCategory, an interface and a union field, in GraphQL contexts only, since describeModels
// rejects them; the conditions read QlCategory's name and tags.
const ABSTRACT_IMPLICIT_ITEMS = [
  condition('name', 'EQ', 'a'), condition('name', 'IN', ['a']), condition('tags', 'CONTAINS_ALL', ['a']), condition('name', 'IIN', ['a']),
];
// A reference without a list before it (after a single embedded object, which is not a list, for box.shop) and a
// collection after a collection; 7f12322 accepts and plans the EQ and IN rows alike, and knows neither CONTAINS_ALL nor IIN.
const ACCEPTED_ROWS = implicitRows([['shop', 'name', 'tags'], ['box.shop', 'name', 'tags'], ['reviews.item.reviews', 'author', 'tags']])
  .map(([name, path, item]) => [['EQ', 'IN'].includes(item.operator) ? `guard: ${name}` : name, path, item]);

describe('hand-built implicit groups', () => {
  describe.each(callers)('rejects a hand-built implicit group that does not end at a collection or at a reference without crossing a list, in both validator contexts and createQueryPlan (%s)', (label, call) => {
    it.each(REJECTED_ROWS)('over %s', (name, path, item) => {
      for (const quantifier of QUANTIFIERS) {
        expect(rejection(() => call({ AND: [{ [quantifier]: [implicit(path, [item])] }] })), quantifier)
          .toEqual({ code: 'INVALID_FILTER_PATH', status: 400, message: IMPLICIT_END });
      }
    });
  });

  it.each(['abstract', 'union'])('rejects a hand-built implicit group that ends at the abstract carrier %s, in GraphQL contexts', (path) => {
    for (const quantifier of QUANTIFIERS) {
      for (const item of ABSTRACT_IMPLICIT_ITEMS) {
        expect(rejection(() => validateQuantifiedGroups({ AND: [{ [quantifier]: [implicit(path, [item])] }] }, categoryContext)), `${quantifier} ${item.field} ${item.operator}`)
          .toEqual({ code: 'INVALID_FILTER_PATH', status: 400, message: IMPLICIT_END });
      }
    }
  });

  describe('accepts a hand-built implicit group that ends at a reference without a list before it or at a collection after a collection', () => {
    it.each(ACCEPTED_ROWS)('%s', (name, path, item) => {
      for (const quantifier of QUANTIFIERS) {
        const args = { AND: [{ [quantifier]: [implicit(path, [item])] }] };
        for (const [label, shape] of contexts) {
          expect(() => validateQuantifiedGroups(args, { ...enabled, ...shape }), `${quantifier} ${label}`).not.toThrow();
        }
        expect(createQueryPlan(models, ITEM, args).where, quantifier).toEqual({
          kind: 'quantified', quantifier, path: path.split('.'), where: predicate(item.field, item.operator, item.value), scope: null,
        });
      }
    });
  });

  // The groups that the rewrite writes for parts.shop.items.name and reviews.author on Item; for items.reviews.author
  // (the anchored frame of the spec's 9.3), items.shop.items.name and items.parts.shop.items.name on Shop below the J
  // prefix items of an aggregate grouped by items.name (anchors with a reference, and with an embedded list and a
  // reference, after their J prefix); and for parts.shop.items.reviews.author on Item below the J prefix
  // parts.shop.items of an aggregate grouped by parts.shop.items.name (a J prefix through an embedded list).
  const REWRITTEN = [
    { entity: ITEM, path: 'parts.shop.items', field: 'name' },
    { entity: ITEM, path: 'reviews', field: 'author' },
    { entity: SHOP, groupId: 'items.name', J: ['items'], anchor: ['items'], path: 'reviews', field: 'author' },
    { entity: SHOP, groupId: 'items.name', J: ['items'], anchor: ['items', 'shop'], path: 'items', field: 'name' },
    { entity: SHOP, groupId: 'items.name', J: ['items'], anchor: ['items', 'parts', 'shop'], path: 'items', field: 'name' },
    { entity: ITEM, groupId: 'parts.shop.items.name', J: ['parts.shop.items'], anchor: ['parts', 'shop', 'items'], path: 'reviews', field: 'author' },
  ];

  it('guard: implicit groups the rewrite writes keep validating', () => {
    for (const { entity, groupId, J, path, field, anchor } of REWRITTEN) {
      const aggregation = anchor && { groupId, facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] };
      const ctx = anchor ? { ...enabled, operation: 'aggregate', J: new Set(J) } : enabled;
      const shapes = [{ gqltype: types[entity.slice(2)] }, { models: plainModels, entity }];
      for (const quantifier of QUANTIFIERS) {
        for (const item of [condition(field, 'EQ', 'one'), condition(field, 'IN', ['one', 'two'])]) {
          const member = implicit(path, [item], anchor ? { __anchor: anchor } : {});
          const args = { ...(anchor ? { aggregation } : {}), AND: [{ [quantifier]: [member] }] };
          const label = `${quantifier} ${[...(anchor ?? []), path].join('.')}: ${field} ${item.operator}`;
          for (const shape of shapes) expect(() => validateQuantifiedGroups(args, { ...ctx, ...shape }), label).not.toThrow();
          expect(createQueryPlan(models, entity, args, anchor ? { mode: 'aggregate' } : {}).where, label).toEqual({
            kind: 'quantified', quantifier, path: path.split('.'), where: predicate(field, item.operator, item.value), scope: null,
            ...(anchor ? { anchor } : {}),
          });
        }
      }
      // The anchored groups are exactly what the rewrite writes for their shorthand in that aggregate.
      if (anchor) {
        const shorthand = { aggregation, AND: [{ conditions: [condition([...anchor, path, field].join('.'), 'EQ', 'one')] }] };
        for (const shape of shapes) {
          expect(frameCollectionPaths(shorthand, { ...ctx, ...shape }).AND, shorthand.AND[0].conditions[0].field)
            .toEqual([{ conditions: [], ANY: [implicit(path, [condition(field, 'EQ', 'one')], { __anchor: anchor })] }]);
        }
      }
    }
  });

  it('accepts CONTAINS_ALL and IIN in hand-built copies of the anchored groups the rewrite writes', () => {
    for (const { entity, groupId, J, path, field, anchor } of REWRITTEN.filter((row) => row.anchor)) {
      const aggregation = { groupId, facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] };
      const shapes = [{ gqltype: types[entity.slice(2)] }, { models: plainModels, entity }];
      for (const quantifier of QUANTIFIERS) {
        for (const item of [condition(field, 'IIN', ['a']), condition('tags', 'CONTAINS_ALL', ['a'])]) {
          const args = { aggregation, AND: [{ [quantifier]: [implicit(path, [item], { __anchor: anchor })] }] };
          const label = `${quantifier} ${[...anchor, path].join('.')}: ${item.field} ${item.operator}`;
          for (const shape of shapes) {
            expect(() => validateQuantifiedGroups(args, { ...enabled, operation: 'aggregate', J: new Set(J), ...shape }), label).not.toThrow();
          }
          expect(createQueryPlan(models, entity, args, { mode: 'aggregate' }).where, label).toEqual({
            kind: 'quantified', quantifier, path: path.split('.'), where: predicate(item.field, item.operator, item.value), scope: null, anchor,
          });
        }
      }
    }
  });

  // An __anchor that is null or undefined, the key present, reads as no anchor (maintainer answer 6): on Item, groups that
  // end at the collection reviews and at the reference shop, in a find, a count and an aggregate grouped by name, all
  // with J empty, validate in both contexts and plan with no anchor key.
  const UNANCHORED = [{ path: 'reviews', field: 'author' }, { path: 'shop', field: 'name' }];
  const UNANCHORED_OPERATIONS = [
    ['find', {}], ['count', {}], ['aggregate', { aggregation: { groupId: 'name', facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] } }],
  ];
  const expectUnanchored = (itemsOf) => {
    for (const { path, field } of UNANCHORED) {
      for (const anchor of [null, undefined]) {
        for (const [operation, extra] of UNANCHORED_OPERATIONS) {
          for (const quantifier of QUANTIFIERS) {
            for (const item of itemsOf(field)) {
              const member = implicit(path, [item], { __anchor: anchor });
              const args = { ...extra, AND: [{ [quantifier]: [member] }] };
              const label = `${quantifier} ${path} with __anchor ${anchor} in a ${operation}: ${item.field} ${item.operator}`;
              expect(Object.hasOwn(member, '__anchor'), label).toBe(true);
              for (const shape of [{ gqltype: types.Item }, { models: plainModels, entity: ITEM }]) {
                expect(() => validateQuantifiedGroups(args, { ...enabled, operation, J: new Set(), ...shape }), label).not.toThrow();
              }
              expect(createQueryPlan(models, ITEM, args, { mode: operation }).where, label).toStrictEqual({
                kind: 'quantified', quantifier, path: [path], where: predicate(item.field, item.operator, item.value), scope: null,
              });
            }
          }
        }
      }
    }
  };

  it('guard: a hand-built implicit group whose __anchor is null or undefined has no anchor', () => {
    expectUnanchored((field) => [condition(field, 'EQ', 'one'), condition(field, 'IN', ['one', 'two'])]);
  });

  it('accepts CONTAINS_ALL and IIN in a hand-built implicit group whose __anchor is null or undefined', () => {
    expectUnanchored((field) => [condition('tags', 'CONTAINS_ALL', ['a']), condition(field, 'IIN', ['a'])]);
  });
});

// Hand-built anchors (maintainer answer 6, as revised): an __anchor is valid only in exactly the shape the rewrite
// writes (cutAt): (i) in an aggregate, (ii) on a group at the root, (iii) a non-empty array of single path segments,
// (iv) whose steps cross at least one collection, every one a J prefix, (v) followed by exactly one step, a collection.
const ANCHOR = 'An implicit quantified anchor must name the aggregate\'s join prefixes';
// Per type a group ends at, a String field for EQ, IN and IIN and a list for CONTAINS_ALL, each valid on its own.
const END_FIELDS = { Item: ['name', 'tags'], Shop: ['name', 'tags'], Review: ['author', 'tags'] };
const anchorRows = (groups) => groups.flatMap(([name, row]) => {
  const [scalar, list] = END_FIELDS[row.end];
  return [condition(scalar, 'EQ', 'a'), condition(scalar, 'IN', ['a']), condition(list, 'CONTAINS_ALL', ['a']), condition(scalar, 'IIN', ['a'])]
    .map((item) => [`${name}, with ${item.field} ${item.operator}`, row, item]);
});
// A row's arguments: the aggregation of an aggregate, then the group under the quantifier, at the root or inside the
// explicit ANY frames the row lists, outermost first.
const anchorArgs = ({ groupId, frames = [], anchor, path }, quantifier, item) => {
  const group = { [quantifier]: [implicit(path, [item], { __anchor: anchor })] };
  return {
    ...(groupId ? { aggregation: { groupId, facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] } } : {}),
    AND: [frames.reduceRight((inner, frame) => ({ ANY: [{ path: frame, ...inner }] }), group)],
  };
};
// The shared validator in both contexts, with the operation and J of the row, and createQueryPlan in the matching mode,
// which derives J from the row's aggregation.
const anchorCallers = [
  ['GraphQL', (args, { entity, operation, J }) => validateQuantifiedGroups(args, { ...enabled, operation, J: new Set(J), gqltype: types[entity.slice(2)] })],
  ['models', (args, { entity, operation, J }) => validateQuantifiedGroups(args, { ...enabled, operation, J: new Set(J), models: plainModels, entity })],
  ['createQueryPlan', (args, { entity, operation }) => createQueryPlan(models, entity, args, { mode: operation })],
];
const SHOP_BY_ITEMS = { entity: SHOP, operation: 'aggregate', groupId: 'items.name', J: ['items'] };
const ITEM_BY_AUTHOR = { entity: ITEM, operation: 'aggregate', groupId: 'reviews.author', J: ['reviews'] };
const ITEM_BY_SHOP_ITEMS = { entity: ITEM, operation: 'aggregate', groupId: 'parts.shop.items.name', J: ['parts.shop.items'] };
// Each row fails the condition its name gives, every other condition holding, except where its comment says.
const ANCHOR_ROWS = anchorRows([
  // (i) J items in both validator contexts; createQueryPlan derives J only in aggregates, so (iv) fails there too.
  ['(i) [items] reviews on Shop in a find with J items', { entity: SHOP, operation: 'find', J: ['items'], anchor: ['items'], path: 'reviews', end: 'Review' }],
  ['(i) [items] reviews on Shop in a count with J items', { entity: SHOP, operation: 'count', J: ['items'], anchor: ['items'], path: 'reviews', end: 'Review' }],
  // (ii) The frame-relative anchor items is a root J prefix, so only the enclosing frames fail.
  ['(ii) [items] reviews inside ANY items, then ANY shop, on Shop grouped by items.name', { ...SHOP_BY_ITEMS, frames: ['items', 'shop'], anchor: ['items'], path: 'reviews', end: 'Review' }],
  // (iii) The rewrite's own anchors in another form, an empty anchor, a dotted element and an element that is not a
  // string. An empty or non-array anchor names no collection, so (iv) fails with it.
  ['(iii) Set [parts, shop, items] reviews on Item grouped by parts.shop.items.name', { ...ITEM_BY_SHOP_ITEMS, anchor: new Set(['parts', 'shop', 'items']), path: 'reviews', end: 'Review' }],
  ['(iii) the string parts.shop.items with reviews on Item grouped by parts.shop.items.name', { ...ITEM_BY_SHOP_ITEMS, anchor: 'parts.shop.items', path: 'reviews', end: 'Review' }],
  ['(iii) [] items on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: [], path: 'items', end: 'Item' }],
  ['(iii) [items.parts, shop] items on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: ['items.parts', 'shop'], path: 'items', end: 'Item' }],
  ['(iii) [String items] reviews on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: [new String('items')], path: 'reviews', end: 'Review' }],
  // (iii) before the implicit path rule: these groups also fail it (counted by elements, for the dotted one) and other
  // conditions, and report the anchor's form.
  ['(iii) before the path rule: Set [parts] parts.shop on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: new Set(['parts']), path: 'parts.shop', end: 'Shop' }],
  ['(iii) before the path rule: [] parts.shop on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: [], path: 'parts.shop', end: 'Shop' }],
  ['(iii) before the path rule: [items.parts] shop on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: ['items.parts'], path: 'shop', end: 'Shop' }],
  // (iv) No collection, a collection outside J, and one J collection then one outside J.
  ['(iv) [parts, shop] items on Item grouped by reviews.author, no collection', { ...ITEM_BY_AUTHOR, anchor: ['parts', 'shop'], path: 'items', end: 'Item' }],
  ['(iv) [items] reviews on Shop grouped by name, J empty', { entity: SHOP, operation: 'aggregate', groupId: 'name', J: [], anchor: ['items'], path: 'reviews', end: 'Review' }],
  ['(iv) [reviews, item] reviews on Item grouped by notes.key, J notes', { entity: ITEM, operation: 'aggregate', groupId: 'notes.key', J: ['notes'], anchor: ['reviews', 'item'], path: 'reviews', end: 'Review' }],
  ['(iv) [items, reviews, item] reviews on Shop grouped by items.name, a J collection then one outside J', { ...SHOP_BY_ITEMS, anchor: ['items', 'reviews', 'item'], path: 'reviews', end: 'Review' }],
  // (v) A reference end, more than one step ending at a collection, and both.
  ['(v) [items] shop on Shop grouped by items.name, a reference end', { ...SHOP_BY_ITEMS, anchor: ['items'], path: 'shop', end: 'Shop' }],
  ['(v) [reviews] item on Item grouped by reviews.author, a reference end', { ...ITEM_BY_AUTHOR, anchor: ['reviews'], path: 'item', end: 'Item' }],
  ['(v) [items] shop.items on Shop grouped by items.name, two steps', { ...SHOP_BY_ITEMS, anchor: ['items'], path: 'shop.items', end: 'Item' }],
  ['(v) [items] reviews.item.reviews on Shop grouped by items.name, three steps', { ...SHOP_BY_ITEMS, anchor: ['items'], path: 'reviews.item.reviews', end: 'Review' }],
  ['(v) [items] parts.shop.items on Shop grouped by items.name, three steps', { ...SHOP_BY_ITEMS, anchor: ['items'], path: 'parts.shop.items', end: 'Item' }],
  ['(v) [items] box.shop on Shop grouped by items.name, two steps and a reference end', { ...SHOP_BY_ITEMS, anchor: ['items'], path: 'box.shop', end: 'Shop' }],
  // The first version's rows, each failing more than one condition, and [items, parts] shop, now a (v) row.
  ['[reviews] item on Item in a find', { entity: ITEM, operation: 'find', anchor: ['reviews'], path: 'item', end: 'Item' }],
  ['[reviews] item on Item in a count', { entity: ITEM, operation: 'count', anchor: ['reviews'], path: 'item', end: 'Item' }],
  ['[reviews] item on Item grouped by name, J empty', { entity: ITEM, operation: 'aggregate', groupId: 'name', J: [], anchor: ['reviews'], path: 'item', end: 'Item' }],
  ['[reviews] item on Item grouped by notes.key, J notes', { entity: ITEM, operation: 'aggregate', groupId: 'notes.key', J: ['notes'], anchor: ['reviews'], path: 'item', end: 'Item' }],
  ['[reviews] item inside an items frame of Shop grouped by items.name', { ...SHOP_BY_ITEMS, frames: ['items'], anchor: ['reviews'], path: 'item', end: 'Item' }],
  ['[parts] shop on Item in a find', { entity: ITEM, operation: 'find', anchor: ['parts'], path: 'shop', end: 'Shop' }],
  ['[parts] shop on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: ['parts'], path: 'shop', end: 'Shop' }],
  ['[box] shop on Item in a find', { entity: ITEM, operation: 'find', anchor: ['box'], path: 'shop', end: 'Shop' }],
  ['[box] shop on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: ['box'], path: 'shop', end: 'Shop' }],
  ['Set [parts] shop on Item in a find', { entity: ITEM, operation: 'find', anchor: new Set(['parts']), path: 'shop', end: 'Shop' }],
  ['(v) [items, parts] shop on Shop grouped by items.name, a reference end', { ...SHOP_BY_ITEMS, anchor: ['items', 'parts'], path: 'shop', end: 'Shop' }],
]);
// Below the J prefix items of a Shop aggregate, parts.shop crosses an embedded list after the anchor: the implicit
// path rule runs before conditions (i), (ii), (iv) and (v), whose (v) this group also fails.
const CROSSING_ROWS = anchorRows([['[items] parts.shop', { ...SHOP_BY_ITEMS, anchor: ['items'], path: 'parts.shop', end: 'Shop' }]]);
// A non-array anchor reads as none in the validator, whose carrier then resolves the bare path reviews on Shop and
// fails before the quantified branch; the conditions read Shop's name and tags.
const UNRESOLVED_ROWS = anchorRows([['Set [items] reviews on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: new Set(['items']), path: 'reviews', end: 'Shop' }]]);

describe('hand-built anchors', () => {
  describe.each(anchorCallers)('rejects a hand-built implicit anchor that is not in the shape the rewrite writes, in both validator contexts and createQueryPlan (%s)', (label, call) => {
    it.each(ANCHOR_ROWS)('%s', (name, row, item) => {
      for (const quantifier of QUANTIFIERS) {
        expect(rejection(() => call(anchorArgs(row, quantifier, item), row)), quantifier)
          .toEqual({ code: 'INVALID_FILTER_PATH', status: 400, message: ANCHOR });
      }
    });
  });

  describe.each(anchorCallers)('rejects a hand-built implicit group whose path crosses an embedded list after its anchor, in both validator contexts and createQueryPlan (%s)', (label, call) => {
    it.each(CROSSING_ROWS)('%s', (name, row, item) => {
      for (const quantifier of QUANTIFIERS) {
        expect(rejection(() => call(anchorArgs(row, quantifier, item), row)), quantifier)
          .toEqual({ code: 'INVALID_FILTER_PATH', status: 400, message: IMPLICIT_END });
      }
    });
  });

  it('pin: a non-array anchor whose bare path does not resolve keeps the resolution\'s INVALID_FILTER_FIELD', () => {
    for (const [name, row, item] of UNRESOLVED_ROWS) {
      for (const quantifier of QUANTIFIERS) {
        for (const [label, call] of anchorCallers) {
          expect(rejection(() => call(anchorArgs(row, quantifier, item), row)), `${quantifier} ${label} ${name}`)
            .toEqual({ code: 'INVALID_FILTER_FIELD', status: 400, message: 'Unknown field reviews' });
        }
      }
    }
  });
});

describe('frames', () => {
  const ctx = { ...enabled, gqltype: types.Item };
  afterEach(() => configureQueryLimits());

  it('guard: frameCollectionPaths cuts reviews.author IIN', () => {
    expect(frameCollectionPaths(grouped(condition('reviews.author', 'IIN', ['ana'])), ctx))
      .toEqual({ AND: [{ conditions: [], ANY: [implicit('reviews', [condition('author', 'IIN', ['ana'])])] }] });
  });

  it('guard: CONTAINS_ALL is never cut', () => {
    for (const args of [grouped(condition('reviews.tags', 'CONTAINS_ALL', ['x'])), { reviews: { terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] } }]) {
      expect(frameCollectionPaths(args, ctx)).toEqual(args);
    }
  });

  it('guard: frameUnits counts the IIN frame', () => {
    expect(frameUnits(grouped(condition('reviews.author', 'IIN', ['ana'])), ctx)).toEqual({ count: 1, units: ['frame:root/1:ANY:reviews'] });
  });

  it.each([3, 4])('counts IIN shorthand frames toward maxFrameNesting on a chain of %s collections', (count) => {
    const error = rejection(() => validateQuantifiedGroups(grouped(condition(`${'children.'.repeat(count)}name`, 'IIN', ['x'])), categoryContext));
    if (count === 3) expect(error).toBeNull();
    else expect(error).toEqual({ code: 'FILTER_DEPTH_EXCEEDED', status: 400, message: 'Frame nesting too deep (maxFrameNesting)' });
  });
});

describe('the memory evaluator', () => {
  const store = listOperatorStore(models);
  const evaluate = createEvaluator(models, store);
  const keysOf = (entity, node) => store[entity].filter((record) => evaluate(entity, record, node)).map((record) => record._id).sort();
  const recordOf = (entity, key) => store[entity].find((record) => record._id === key);
  // Plan values arrive raw, so the store's enum values are sent where a row names the enum's names.
  const valueOf = (row, value) => {
    const raw = listOperatorArgs(value);
    return row.enumNames ? raw.map((name) => types.Kind.getValue(name).value) : raw;
  };
  const nodeOf = (row) => {
    if (row.condition) return predicate(row.condition.field, row.operator, valueOf(row, row.condition.value));
    const { quantifier, path, condition: inner } = row.frame;
    return { kind: 'quantified', quantifier, path: path.split('.'), where: predicate(inner.field, inner.operator, valueOf(row, inner.value)), scope: null };
  };
  const rows = LIST_OPERATOR_CASES.filter((row) => LIST.includes(row.operator) && !row.dateTime && row.rows.admin && (row.condition || row.frame));

  it.each(rows.map((row) => [row.name, row]))('returns the admin keys of %s', (name, row) => {
    expect(keysOf(ITEM, nodeOf(row))).toEqual([...new Set(row.rows.admin)]);
  });

  it('matches nothing on missing, null, [] and [null] values', () => {
    // I4 stores none of these fields, I5 holds null, I7 holds [null], and I3's emails and kinds are [].
    const misses = [
      ['I4', ['tags', ['A']], ['emails', ['x@y']], ['ranks', [1]], ['dims.codes', ['A']], ['lines.sku', ['A']], ['box.tags', ['p']]],
      ['I5', ['tags', ['A']], ['emails', ['x@y']], ['ranks', [1]], ['dims.codes', ['A']], ['lines.sku', ['A']], ['box.tags', ['p']]],
      ['I7', ['tags', ['A']], ['emails', ['x@y']], ['ids', ['u1']], ['ranks', [1]]],
      ['I3', ['emails', ['x@y']], ['kinds', ['one_v']]],
    ];
    for (const [key, ...paths] of misses) {
      for (const [path, value] of paths) {
        expect(evaluate(ITEM, recordOf(ITEM, key), predicate(path, 'CONTAINS_ALL', value)), `${key} ${path} CONTAINS_ALL`).toBe(false);
        if (typeof value[0] === 'string') expect(evaluate(ITEM, recordOf(ITEM, key), predicate(path, 'IIN', value)), `${key} ${path} IIN`).toBe(false);
      }
    }
    for (const key of ['I4', 'I5']) expect(evaluate(ITEM, recordOf(ITEM, key), predicate('name', 'IIN', ['a', 'null'])), key).toBe(false);
    // S3's tags are [] and S4's null.
    for (const key of ['S3', 'S4']) {
      expect(evaluate(types.Shop.name, recordOf(types.Shop.name, key), predicate('tags', 'CONTAINS_ALL', ['a'])), key).toBe(false);
      expect(evaluate(types.Shop.name, recordOf(types.Shop.name, key), predicate('tags', 'IIN', ['a'])), key).toBe(false);
    }
  });
});

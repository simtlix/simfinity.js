import { describe, expect, it } from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInterfaceType, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString,
  GraphQLUnionType, graphql, printSchema,
} from 'graphql';

import {
  QLOperator, createQueryPlan, createRuntime, createValidatedScalar, describeModels, resolveModelPath,
} from '../packages/core/src/index.js';
import { collectQueryOperators, collectQueryPathEntries, collectQueryPaths } from '../packages/core/src/query-plan.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import {
  EMPTINESS_CASES, createEmptinessTypes, emptinessQuery, postgresEmptinessStatements, registerEmptinessTypes, seedEmptiness,
  writeMongoEmptinessDocuments,
} from './helpers/query-emptiness.js';

// Preserve the pre-frame collector contract while the collection-frame suite checks new metadata.
const legacyEntries = (entries) => entries.map((entry) => {
  const legacy = { ...entry };
  for (const key of ['use', 'container', 'frames', 'relative', 'quantifier']) delete legacy[key];
  return legacy;
});

// #108 part 2a: the emptiness operators IS_EMPTY and IS_NOT_EMPTY on the queried record's own fields. This file holds
// the core rules that need no runtime: the shared module, the shape of what "empty" means for a path and the order of
// its checks, the collectors the runtime reads, and createQueryPlan. It also holds what the shared test helper does
// without a database. The runtime gate, joined scopes and member authorization are tested in
// query-emptiness-runtime.test.js, and each backend's forms with that backend. Part 2b lifts rule 6 for callers that
// support reference emptiness, which is the default here; its pins run with `referenceEmptiness: false`, the undeclared
// adapter's case, and reference-emptiness.test.js holds the rest of part 2b.

const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const TEXT = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
const EMPTINESS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
// Rule 6's message when the caller does not support reference emptiness (#108 part 2b).
const NOT_SUPPORTED = 'the database adapter does not support emptiness through references and collections';
const UNDECLARED = { referenceEmptiness: false };
// The list operators (#108 part 4) follow the emptiness operators; tests/list-operators.test.js covers them.
const LIST_OPERATORS = ['CONTAINS_ALL', 'IIN'];
const ENUM_ORDER = ['EQ', 'LT', 'GT', 'LTE', 'GTE', 'BTW', 'NE', 'IN', 'NIN', 'LIKE', ...TEXT, ...EMPTINESS, ...LIST_OPERATORS];

// Loaded on use, so that each test of the shared module fails on its own where the module lacks a name.
const OPERATORS_MODULE = '@simtlix/simfinity-core/internal/query-operators';
const loadOperators = () => import(/* @vite-ignore */ OPERATORS_MODULE);

const errorOf = (body) => {
  try {
    body();
  } catch (error) {
    return error;
  }
  return null;
};
const codeOf = (body) => {
  const error = errorOf(body);
  return error ? error.extensions?.code ?? error.message : null;
};

const fixture = createEmptinessTypes('Qc', { backend: 'postgres' });
const mongoFixture = createEmptinessTypes('Qd', { backend: 'mongodb' });
const registrationsOf = (types) => [types.Item, types.Shop, types.Review, types.Sid, ...Object.values(types.owned)]
  .map((gqltype) => ({ gqltype }))
  .concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
const models = describeModels(registrationsOf(fixture));
// The same description without GraphQL types, as a hand-built description may come.
const untypedModels = { entities: models.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
const plan = (input, options) => createQueryPlan(models, 'QcItem', input, options);
const predicate = (path, operator, value = null) => ({ kind: 'predicate', path: path.split('.'), operator, value });
const predicatesOf = (node) => {
  if (!node) return [];
  return node.kind === 'predicate' ? [node] : node.terms.flatMap(predicatesOf);
};
// A group condition `depth` AND levels below the groups listed in args.AND, which are at depth 0.
const nested = (condition, depth) => {
  let group = { conditions: [condition] };
  for (let level = 0; level < depth; level += 1) group = { AND: [group] };
  return { AND: [group] };
};
const owned = (name) => fixture.owned[name];
const OWNED_ROOT = owned('owned create values');

const STRING = { rule: 'string' };
const NULL = { rule: 'null' };
const LIST = { rule: 'list' };
const object = (members) => ({ rule: 'object', members: Object.entries(members).map(([name, shape]) => ({ name, shape })) });
const DIMS = object({ w: NULL, label: STRING, tags: LIST });
const INNER = object({ y: NULL, z: STRING });
const UDIM = object({ w: NULL, label: STRING, tags: LIST, dims: object({ a: NULL, tags: LIST }) });
const NEST = object({ w: NULL, meta: object({ code: STRING }), mlines: LIST });
const ref = (target) => ({ rule: 'reference', target });
const coll = (target, connectionField) => ({ rule: 'collection', target, connectionField });
const through = (shape, ...crossings) => ({ ...shape, crossings: crossings.map(([path, target]) => ({ path, target })) });

// Every path of the fixture that an emptiness condition accepts, with its shape.
const ACCEPTED = [
  ['QcItem', 'id', NULL], ['QcItem', 'note', STRING], ['QcItem', 'code', STRING], ['QcItem', 'count', NULL],
  ['QcItem', 'kind', NULL], ['QcItem', 'state', NULL], ['QcItem', 'ref', NULL], ['QcItem', 'at', NULL],
  ['QcItem', 'tags', LIST], ['QcItem', 'dims', DIMS], ['QcItem', 'dims.w', NULL], ['QcItem', 'dims.label', STRING],
  ['QcItem', 'dims.tags', LIST], ['QcItem', 'plain', object({ a: NULL, b: STRING })], ['QcItem', 'plain.b', STRING],
  // An embedded `id` member keeps the rule of its declared scalar.
  ['QcItem', 'ident', object({ id: NULL, label: STRING })], ['QcItem', 'ident.id', NULL],
  ['QcItem', 'sident', object({ id: STRING, label: STRING })], ['QcItem', 'sident.id', STRING],
  ['QcItem', 'outer', object({ x: STRING, inner: INNER })], ['QcItem', 'outer.inner', INNER], ['QcItem', 'outer.inner.z', STRING],
  ['QcItem', 'lines', LIST], ['QcItem', 'ghost', object({})], ['QcItem', 'odim.w', NULL], ['QcItem', 'odim.tags', LIST],
  ['QcItem', 'olines', LIST],
  // The record identity takes the null rule, also when it is declared String.
  ['QcSid', 'id', NULL], ['QcSid', 'name', STRING],
  [OWNED_ROOT.name, 'udim', UDIM], [OWNED_ROOT.name, 'udim.dims', object({ a: NULL, tags: LIST })], [OWNED_ROOT.name, 'ulist', LIST],
  [OWNED_ROOT.name, 'nest', NEST], [OWNED_ROOT.name, 'nest.meta', object({ code: STRING })], [OWNED_ROOT.name, 'nest.meta.code', STRING],
  [OWNED_ROOT.name, 'nest.mlines', LIST],
];
// Every path of the fixture that 2a rejects, with its code, in the order of the checks.
const REJECTED = [
  // Rule 1: syntax and fields.
  ['QcItem', 'nope', 'INVALID_FILTER_FIELD'], ['QcItem', 'shop.nope', 'INVALID_FILTER_FIELD'], ['QcItem', 'lines.nope', 'INVALID_FILTER_FIELD'],
  ['QcItem', 'note.x', 'INVALID_FILTER_PATH'], ['QcItem', 'shop.name.x', 'INVALID_FILTER_PATH'], ['QcItem', 'tags.x', 'INVALID_FILTER_PATH'],
  ['QcItem', 'dims..w', 'INVALID_FILTER_PATH'], ['QcItem', 'dims.w-x', 'INVALID_FILTER_PATH'], ['QcItem', 'ghost.label', 'INVALID_FILTER_FIELD'],
  // Rule 3: a value inside a list, before any reference crossing.
  ['QcItem', 'lines.qty', 'INVALID_FILTER_PATH'], ['QcItem', 'olines.qty', 'INVALID_FILTER_PATH'], ['QcItem', 'reviews.text', 'INVALID_FILTER_PATH'],
  ['QcItem', 'olines.shop', 'INVALID_FILTER_PATH'], ['QcItem', 'shop.items.note', 'INVALID_FILTER_PATH'],
  [OWNED_ROOT.name, 'ulist.sku', 'INVALID_FILTER_PATH'], [OWNED_ROOT.name, 'nest.mlines.sku', 'INVALID_FILTER_PATH'],
];
// Rule 6: references and collections, crossed, reached, or reached by member expansion. 2a rejected them with
// UNSUPPORTED_QUERY, which a caller without reference emptiness still gives; part 2b describes them.
const REFERENCES = [
  ['QcItem', 'shop', ref('QcShop')], ['QcItem', 'shop.name', through(STRING, ['shop', 'QcShop'])],
  ['QcItem', 'shop.items', through(coll('QcItem', 'shop'), ['shop', 'QcShop'])], ['QcItem', 'reviews', coll('QcReview', 'item')],
  ['QcItem', 'odim', object({ w: NULL, tags: LIST, shop: ref('QcShop') })], ['QcItem', 'odim.shop', ref('QcShop')],
  ['QcItem', 'odim.shop.name', through(STRING, ['odim.shop', 'QcShop'])], ['QcReview', 'item.note', through(STRING, ['item', 'QcItem'])],
  ['QcReview', 'item.dims', through(DIMS, ['item', 'QcItem'])], ['QcShop', 'items', coll('QcItem', 'shop')],
];
const typeNamed = (name) => models.entities.find((entity) => entity.name === name).gqltype;

// Types that describeModels rejects, which MongoDB's default mode and custom adapters can still serve.
const Shape = new GraphQLInterfaceType({ name: 'QcShape', fields: { label: { type: GraphQLString } } });
const Circle = new GraphQLObjectType({ name: 'QcCircle', interfaces: [Shape], fields: { label: { type: GraphQLString } } });
const Either = new GraphQLUnionType({ name: 'QcEither', types: [Circle] });
const Target = new GraphQLObjectType({ name: 'QcTarget', fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString } }) });
const embedded = { relation: { embedded: true } };
const reference = { relation: { embedded: false } };
const holder = (name, fields) => new GraphQLObjectType({ name, fields });
const WithInterface = holder('QcWithInterface', { label: { type: GraphQLString }, shape: { type: Shape } });
const WithUnionList = holder('QcWithUnionList', { tags: { type: new GraphQLList(GraphQLString) }, parts: { type: new GraphQLList(Either) } });
const WithCollection = holder('QcWithCollection', { title: { type: GraphQLString }, children: { type: new GraphQLList(Target), extensions: { relation: { embedded: false, connectionField: 'parent' } } } });
const WithBoth = holder('QcWithBoth', { owner: { type: Target, extensions: reference }, shape: { type: Shape } });
// A reference or an interface member one level further down, inside a nested single embedded object.
const DeepRef = holder('QcDeepRef', { owner: { type: Target, extensions: reference }, n: { type: GraphQLString } });
const DeepShape = holder('QcDeepShape', { shape: { type: Shape } });
const Mid = holder('QcMid', { x: { type: GraphQLString }, deep: { type: DeepRef, extensions: embedded } });
const MidShape = holder('QcMidShape', { deep: { type: DeepShape, extensions: embedded } });
const MidBoth = holder('QcMidBoth', { owner: { type: Target, extensions: reference }, deep: { type: DeepShape, extensions: embedded } });
const Node = new GraphQLObjectType({ name: 'QcNode', fields: () => ({ label: { type: GraphQLString }, child: { type: Node, extensions: { ...embedded, readOnly: true } } }) });
const RefNode = new GraphQLObjectType({ name: 'QcRefNode', fields: () => ({ owner: { type: Target, extensions: reference }, child: { type: RefNode, extensions: { ...embedded, readOnly: true } } }) });
const ShapeNode = new GraphQLObjectType({ name: 'QcShapeNode', fields: () => ({ child: { type: ShapeNode, extensions: { ...embedded, readOnly: true } }, shape: { type: Shape } }) });
const Left = new GraphQLObjectType({ name: 'QcLeft', fields: () => ({ right: { type: Right, extensions: { ...embedded, readOnly: true } } }) });
const Right = new GraphQLObjectType({ name: 'QcRight', fields: () => ({ n: { type: GraphQLString }, left: { type: Left, extensions: { ...embedded, readOnly: true } } }) });
const Tree = new GraphQLObjectType({ name: 'QcTree', fields: () => ({ label: { type: GraphQLString }, children: { type: new GraphQLList(Tree), extensions: embedded } }) });
const Root = new GraphQLObjectType({
  name: 'QcRoot',
  fields: {
    id: { type: GraphQLID },
    shape: { type: Shape },
    shapes: { type: new GraphQLList(Shape) },
    either: { type: new GraphQLList(Either) },
    withInterface: { type: WithInterface, extensions: embedded },
    withUnionList: { type: WithUnionList, extensions: embedded },
    withCollection: { type: WithCollection, extensions: embedded },
    withBoth: { type: WithBoth, extensions: embedded },
    mid: { type: Mid, extensions: embedded },
    midShape: { type: MidShape, extensions: embedded },
    midBoth: { type: MidBoth, extensions: embedded },
    node: { type: Node, extensions: embedded },
    refNode: { type: RefNode, extensions: embedded },
    shapeNode: { type: ShapeNode, extensions: embedded },
    left: { type: Left, extensions: embedded },
    tree: { type: Tree, extensions: embedded },
    // An object field without a relation is read as embedded, as MongoDB reads paths.
    loose: { type: holder('QcLoose', { a: { type: GraphQLString } }) },
    virtualShape: { type: Shape, resolve: () => null, extensions: { virtual: true } },
  },
});
const describeOn = async (path, options = {}) => {
  const { describeEmptiness } = await loadOperators();
  return codeOf(() => describeEmptiness(Root, path.split('.'), { operator: 'IS_EMPTY', ...options }));
};

// Shapes describeModels accepts, for both derivations: a reference member inside a nested single embedded object
// (owned tables on PostgreSQL), and embedded `id` members declared String and ID under a root `id: String`. Only the
// record identity takes the null rule; an embedded `id` member keeps its declared scalar's rule.
const DeepOwner = holder('QcDeepOwner', { owner: { type: Target, extensions: reference }, n: { type: GraphQLString } });
const MidOwner = holder('QcMidOwner', { x: { type: GraphQLString }, deep: { type: DeepOwner, extensions: embedded } });
const StringIdent = holder('QcStringIdent', { id: { type: GraphQLString }, label: { type: GraphQLString } });
const NestedIdent = holder('QcNestedIdent', { sident: { type: StringIdent, extensions: embedded }, ident: { type: holder('QcIdIdent', { id: { type: GraphQLID } }), extensions: embedded } });
const ModelRoot = holder('QcModelRoot', {
  id: { type: GraphQLString },
  mid: { type: MidOwner, extensions: embedded },
  sident: { type: StringIdent, extensions: embedded },
  nested: { type: NestedIdent, extensions: embedded },
});
const rootModels = describeModels([ModelRoot, Target].map((gqltype) => ({ gqltype }))
  .concat([DeepOwner, MidOwner, StringIdent, NestedIdent, NestedIdent.getFields().ident.type].map((gqltype) => ({ gqltype, endpoint: false }))));
const untypedRootModels = { entities: rootModels.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };

describe('QLOperator', () => {
  it('adds IS_EMPTY and IS_NOT_EMPTY after the text operators', () => {
    expect(QLOperator.getValues().map((entry) => entry.value)).toEqual(ENUM_ORDER);
    expect(QLOperator.getValues().map((entry) => entry.name)).toEqual(ENUM_ORDER);
  });

  it('publishes them in the generated SDL and in introspection', async () => {
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
    const Thing = new GraphQLObjectType({ name: 'QcThing', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    runtime.connect(null, Thing, 'qcThing', 'qcThings');
    const schema = runtime.createSchema();
    expect(printSchema(schema)).toContain(`enum QLOperator {\n${ENUM_ORDER.map((name) => `  ${name}`).join('\n')}\n}`);
    const result = await graphql({ schema, source: '{ __type(name: "QLOperator") { enumValues { name } } }' });
    expect(result.data.__type.enumValues.map((value) => value.name).slice(-4, -2)).toEqual(EMPTINESS);
  });
});

describe('shared emptiness helpers', () => {
  it('lists the emptiness operators, and keeps the 3.7.0 set apart', async () => {
    const operators = await loadOperators();
    expect(operators.EMPTINESS_QUERY_OPERATORS).toEqual(EMPTINESS);
    expect(Object.isFrozen(operators.EMPTINESS_QUERY_OPERATORS)).toBe(true);
    expect(operators.QUERY_OPERATORS).toEqual(ENUM_ORDER);
    expect(operators.LEGACY_QUERY_OPERATORS).toEqual(LEGACY);
    expect(EMPTINESS.every(operators.isEmptinessOperator)).toBe(true);
    expect([...LEGACY, ...TEXT, 'is_empty', 'BAD', '', null, undefined, 'toString'].some(operators.isEmptinessOperator)).toBe(false);
    expect([...operators.resolveQueryFeatures({ operators: ['IS_EMPTY', 'IS_NOT_EMPTY', 'SOUNDS_LIKE'] }).operators]).toEqual(EMPTINESS);
  });

  it('accepts only an omitted or null value, with INVALID_FILTER_VALUE for any other', async () => {
    const { validateEmptinessValue } = await loadOperators();
    for (const operator of EMPTINESS) {
      expect(validateEmptinessValue(operator, undefined, 'note')).toBeNull();
      expect(validateEmptinessValue(operator, null, ['dims', 'w'])).toBeNull();
      for (const value of ['', 'x', ' ', [], [null], {}, false, true, 0, 1, new Date(0)]) {
        expect(codeOf(() => validateEmptinessValue(operator, value, 'note')), JSON.stringify(value)).toBe('INVALID_FILTER_VALUE');
      }
    }
    expect(errorOf(() => validateEmptinessValue('IS_EMPTY', 0, ['dims', 'w']))).toMatchObject({
      message: 'IS_EMPTY takes no value on dims.w: omit it or pass null',
      extensions: { code: 'INVALID_FILTER_VALUE', status: 400 },
    });
  });

  it('names the effective scalar of a field type without ever throwing', async () => {
    const { effectiveScalarName } = await loadOperators();
    const Email = createValidatedScalar('QcEmail', 'An email', GraphQLString, () => {});
    const WorkEmail = createValidatedScalar('QcWorkEmail', 'A work email', Email, () => {});
    const DateScalar = new GraphQLScalarType({ name: 'Date' });
    const Day = new GraphQLScalarType({ name: 'QcDay' });
    Day.baseScalarType = DateScalar;
    const Json = new GraphQLScalarType({ name: 'QcJson' });
    const First = new GraphQLScalarType({ name: 'QcFirst' });
    const Second = new GraphQLScalarType({ name: 'QcSecond' });
    First.baseScalarType = Second;
    Second.baseScalarType = First;
    const Kind = new GraphQLEnumType({ name: 'QcKindEnum', values: { A: {} } });
    expect([GraphQLString, GraphQLID, Email, WorkEmail, DateScalar, Day, Json, Kind].map(effectiveScalarName))
      .toEqual(['String', 'ID', 'String', 'String', 'Date', 'Date', 'QcJson', 'QcKindEnum']);
    // A repeated link stops the walk where the chain repeats, as MongoDB's own helper does.
    expect(effectiveScalarName(First)).toBe('QcFirst');
    expect(effectiveScalarName(Second)).toBe('QcSecond');
    expect(effectiveScalarName(undefined)).toBeUndefined();
  });

  it('keeps describeModels rejecting cyclic and unsupported scalars (regression pin, passes on 3.9.0)', () => {
    const First = new GraphQLScalarType({ name: 'QcLoopA' });
    const Second = new GraphQLScalarType({ name: 'QcLoopB' });
    First.baseScalarType = Second;
    Second.baseScalarType = First;
    const entity = (name, type) => [{ gqltype: new GraphQLObjectType({ name, fields: { id: { type: GraphQLID }, value: { type } } }) }];
    expect(errorOf(() => describeModels(entity('QcLoop', First)))).toMatchObject({ message: 'Cyclic base scalar QcLoopA', extensions: { code: 'INVALID_MODEL' } });
    expect(errorOf(() => describeModels(entity('QcRaw', new GraphQLScalarType({ name: 'QcRawJson' })))))
      .toMatchObject({ message: 'Unsupported scalar QcRawJson: declare a supported baseScalarType', extensions: { code: 'INVALID_MODEL' } });
    const Code = createValidatedScalar('QcCodeScalar', 'A code', GraphQLString, () => {});
    expect(describeModels(entity('QcCoded', Code)).entities[0].fields.at(-1)).toMatchObject({ name: 'value', kind: 'scalar', scalar: 'String' });
  });
});

describe('describeEmptiness', () => {
  it.each(ACCEPTED)('describes %s.%s', async (typeName, path, shape) => {
    const { describeEmptiness } = await loadOperators();
    expect(describeEmptiness(typeNamed(typeName), path.split('.'), { operator: 'IS_EMPTY' })).toEqual(shape);
    expect(describeEmptiness(typeNamed(typeName), path.split('.'), { operator: 'IS_NOT_EMPTY', value: null })).toEqual(shape);
  });

  it('describes the kinds only MongoDB stores: an application scalar takes the null rule', async () => {
    const { describeEmptiness } = await loadOperators();
    expect(describeEmptiness(mongoFixture.Item, ['meta'], { operator: 'IS_EMPTY' })).toEqual(NULL);
  });

  it.each(REJECTED)('rejects %s.%s with %s', async (typeName, path, code) => {
    const { describeEmptiness } = await loadOperators();
    expect(codeOf(() => describeEmptiness(typeNamed(typeName), path.split('.'), { operator: 'IS_EMPTY' }))).toBe(code);
    expect(codeOf(() => describeEmptiness(typeNamed(typeName), path.split('.'), { operator: 'IS_EMPTY', ...UNDECLARED }))).toBe(code);
  });

  it.each(REFERENCES)('describes %s.%s through references and collections, and rejects it with UNSUPPORTED_QUERY without reference emptiness', async (typeName, path, shape) => {
    const { describeEmptiness } = await loadOperators();
    expect(describeEmptiness(typeNamed(typeName), path.split('.'), { operator: 'IS_EMPTY' })).toEqual(shape);
    expect(describeEmptiness(typeNamed(typeName), path.split('.'), { operator: 'IS_NOT_EMPTY', referenceEmptiness: true })).toEqual(shape);
    expect(codeOf(() => describeEmptiness(typeNamed(typeName), path.split('.'), { operator: 'IS_EMPTY', ...UNDECLARED }))).toBe('UNSUPPORTED_QUERY');
  });

  it('explains each rejection', async () => {
    const { describeEmptiness } = await loadOperators();
    const message = (path, options = {}) => errorOf(() => describeEmptiness(fixture.Item, path.split('.'), { operator: 'IS_EMPTY', path, ...options })).message;
    expect(message('lines.qty')).toBe('IS_EMPTY cannot test lines.qty: emptiness of a value inside a list is not defined, and lines is an embedded list');
    expect(message('reviews.text')).toBe('IS_EMPTY cannot test reviews.text: emptiness of a value inside a list is not defined, and reviews is a collection');
    expect(message('shop.name', UNDECLARED)).toBe(`IS_EMPTY on shop.name crosses the reference shop: ${NOT_SUPPORTED}`);
    expect(message('reviews', UNDECLARED)).toBe(`IS_EMPTY on reviews ends at the collection reviews: ${NOT_SUPPORTED}`);
    expect(message('odim', UNDECLARED)).toBe(`IS_EMPTY on odim reads the reference member odim.shop: ${NOT_SUPPORTED}`);
    // Rule 1 reports what resolveModelPath reports.
    expect(message('shop.nope')).toBe('Unknown field shop.nope');
    expect(message('note.x')).toBe('Field note cannot be traversed');
    expect(message('dims..w')).toBe('Invalid filter path');
    expect(message('ghost.label')).toBe('Query path ghost.label uses the virtual field QcGhost.label, which is not stored');
  });

  it('accepts only an omitted or null value, after the path rules and before rule 6', async () => {
    const { describeEmptiness } = await loadOperators();
    for (const value of ['x', '', [], {}, false, 0]) {
      for (const path of ['shop', 'odim', 'reviews']) {
        expect(codeOf(() => describeEmptiness(fixture.Item, [path], { operator: 'IS_EMPTY', value, ...UNDECLARED }))).toBe('INVALID_FILTER_VALUE');
      }
      expect(codeOf(() => describeEmptiness(fixture.Item, ['note'], { operator: 'IS_EMPTY', value }))).toBe('INVALID_FILTER_VALUE');
      expect(codeOf(() => describeEmptiness(fixture.Item, ['dims'], { operator: 'IS_NOT_EMPTY', value }))).toBe('INVALID_FILTER_VALUE');
      // Rule 3 comes before the value, and the value before rule 6.
      expect(codeOf(() => describeEmptiness(fixture.Item, ['lines', 'qty'], { operator: 'IS_EMPTY', value }))).toBe('INVALID_FILTER_PATH');
      expect(codeOf(() => describeEmptiness(fixture.Item, ['shop'], { operator: 'IS_EMPTY', value }))).toBe('INVALID_FILTER_VALUE');
      expect(codeOf(() => describeEmptiness(fixture.Item, ['odim'], { operator: 'IS_EMPTY', value }))).toBe('INVALID_FILTER_VALUE');
      expect(codeOf(() => describeEmptiness(fixture.Item, ['reviews'], { operator: 'IS_EMPTY', value }))).toBe('INVALID_FILTER_VALUE');
    }
    expect(codeOf(() => describeEmptiness(fixture.Item, ['nope'], { operator: 'IS_EMPTY', value: 'x' }))).toBe('INVALID_FILTER_FIELD');
  });

  it('rejects interface and union fields and members with INVALID_FILTER_PATH, before references (rule 3)', async () => {
    for (const path of ['shape', 'shapes', 'either', 'shape.label', 'withInterface', 'withUnionList', 'withBoth']) {
      expect(await describeOn(path), path).toBe('INVALID_FILTER_PATH');
    }
    expect(await describeOn('withInterface', { value: 'x' })).toBe('INVALID_FILTER_PATH');
    const { describeEmptiness } = await loadOperators();
    expect(errorOf(() => describeEmptiness(Root, ['withBoth'], { operator: 'IS_EMPTY' })).message)
      .toBe('IS_EMPTY cannot test withBoth: withBoth.shape is an interface or union field, whose emptiness is not defined');
    expect(describeEmptiness(Root, ['withInterface', 'label'], { operator: 'IS_EMPTY' })).toEqual(STRING);
  });

  it('reads a collection member by the collection rule, never as a list, and rejects it with UNSUPPORTED_QUERY without reference emptiness (rule 6)', async () => {
    const { describeEmptiness } = await loadOperators();
    expect(describeEmptiness(Root, ['withCollection'], { operator: 'IS_EMPTY' })).toEqual(object({ title: STRING, children: coll('QcTarget', 'parent') }));
    expect(await describeOn('withCollection', UNDECLARED)).toBe('UNSUPPORTED_QUERY');
    expect(await describeOn('withCollection', { value: 1 })).toBe('INVALID_FILTER_VALUE');
    expect(await describeOn('withCollection', { value: 1, ...UNDECLARED })).toBe('INVALID_FILTER_VALUE');
    expect(await describeOn('withCollection.title')).toBeNull();
  });

  it('reads a reference member inside a nested single embedded object as one at the top, and rejects an interface member (rules 3 and 6)', async () => {
    const { describeEmptiness } = await loadOperators();
    const deep = object({ owner: ref('QcTarget'), n: STRING });
    expect(describeEmptiness(Root, ['mid'], { operator: 'IS_EMPTY' })).toEqual(object({ x: STRING, deep }));
    expect(describeEmptiness(Root, ['mid', 'deep'], { operator: 'IS_EMPTY' })).toEqual(deep);
    expect(describeEmptiness(Root, ['mid', 'deep', 'owner'], { operator: 'IS_EMPTY' })).toEqual(ref('QcTarget'));
    for (const path of ['mid', 'mid.deep', 'mid.deep.owner']) expect(await describeOn(path, UNDECLARED), path).toBe('UNSUPPORTED_QUERY');
    expect(errorOf(() => describeEmptiness(Root, ['mid'], { operator: 'IS_EMPTY', ...UNDECLARED })).message)
      .toBe(`IS_EMPTY on mid reads the reference member mid.deep.owner: ${NOT_SUPPORTED}`);
    expect(errorOf(() => describeEmptiness(Root, ['mid', 'deep'], { operator: 'IS_NOT_EMPTY', ...UNDECLARED })).message)
      .toBe(`IS_NOT_EMPTY on mid.deep reads the reference member mid.deep.owner: ${NOT_SUPPORTED}`);
    expect(await describeOn('mid', { value: 'x' })).toBe('INVALID_FILTER_VALUE');
    expect(describeEmptiness(Root, ['mid', 'x'], { operator: 'IS_EMPTY' })).toEqual(STRING);
    expect(describeEmptiness(Root, ['mid', 'deep', 'n'], { operator: 'IS_EMPTY' })).toEqual(STRING);
    for (const path of ['midShape', 'midShape.deep', 'midBoth']) {
      expect(await describeOn(path), path).toBe('INVALID_FILTER_PATH');
      expect(await describeOn(path, UNDECLARED), path).toBe('INVALID_FILTER_PATH');
    }
    // Rule 3 at any depth comes before the value and before a reference member met earlier.
    expect(await describeOn('midShape', { value: 'x' })).toBe('INVALID_FILTER_PATH');
    expect(errorOf(() => describeEmptiness(Root, ['midShape'], { operator: 'IS_EMPTY' })).message)
      .toBe('IS_EMPTY cannot test midShape: midShape.deep.shape is an interface or union field, whose emptiness is not defined');
    expect(errorOf(() => describeEmptiness(Root, ['midBoth'], { operator: 'IS_EMPTY' })).message)
      .toBe('IS_EMPTY cannot test midBoth: midBoth.deep.shape is an interface or union field, whose emptiness is not defined');
  });

  it('reads a nested reference member from model descriptions too, with and without GraphQL types, and rejects it without reference emptiness', async () => {
    const { describeModelEmptiness } = await loadOperators();
    for (const described of [rootModels, untypedRootModels]) {
      const planOn = (input, options) => createQueryPlan(described, 'QcModelRoot', input, options);
      expect(planOn({ mid: { terms: [{ operator: 'IS_EMPTY' }] } }).where).toEqual(predicate('mid', 'IS_EMPTY'));
      expect(errorOf(() => planOn({ mid: { terms: [{ operator: 'IS_EMPTY' }] } }, UNDECLARED))).toMatchObject({
        message: `IS_EMPTY on mid reads the reference member mid.deep.owner: ${NOT_SUPPORTED}`, extensions: { code: 'UNSUPPORTED_QUERY' },
      });
      expect(errorOf(() => planOn({ AND: [{ conditions: [{ field: 'mid', path: 'deep', operator: 'IS_NOT_EMPTY' }] }] }, UNDECLARED))).toMatchObject({
        message: `IS_NOT_EMPTY on mid.deep reads the reference member mid.deep.owner: ${NOT_SUPPORTED}`, extensions: { code: 'UNSUPPORTED_QUERY' },
      });
      expect(codeOf(() => planOn({ mid: { terms: [{ operator: 'IS_EMPTY', value: 'x' }] } }))).toBe('INVALID_FILTER_VALUE');
      expect(codeOf(() => planOn({ mid: { terms: [{ operator: 'IS_EMPTY', value: 'x' }] } }, UNDECLARED))).toBe('INVALID_FILTER_VALUE');
      expect(predicatesOf(planOn({ mid: { terms: [{ path: 'x', operator: 'IS_EMPTY' }, { path: 'deep.n', operator: 'IS_NOT_EMPTY' }] } }, UNDECLARED).where))
        .toEqual([predicate('mid.x', 'IS_EMPTY'), predicate('mid.deep.n', 'IS_NOT_EMPTY')]);
    }
    const steps = resolveModelPath(rootModels, 'QcModelRoot', 'mid');
    expect(describeModelEmptiness(steps, { operator: 'IS_EMPTY' })).toEqual(object({ x: STRING, deep: object({ owner: ref('QcTarget'), n: STRING }) }));
    expect(codeOf(() => describeModelEmptiness(steps, { operator: 'IS_EMPTY', ...UNDECLARED }))).toBe('UNSUPPORTED_QUERY');
  });

  it('keeps an embedded id member under its declared scalar, and the null rule for the record identity only', async () => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    const IDENT = object({ id: STRING, label: STRING });
    for (const [path, shape] of [
      ['id', NULL], ['sident', IDENT], ['sident.id', STRING], ['nested', object({ sident: IDENT, ident: object({ id: NULL }) })],
      ['nested.sident', IDENT], ['nested.sident.id', STRING], ['nested.ident.id', NULL],
    ]) {
      expect(describeEmptiness(ModelRoot, path.split('.'), { operator: 'IS_EMPTY' }), path).toEqual(shape);
      expect(describeModelEmptiness(resolveModelPath(rootModels, 'QcModelRoot', path), { operator: 'IS_NOT_EMPTY' }), path).toEqual(shape);
    }
  });

  it('rejects re-entry through single embedded members with INVALID_FILTER_OPERATOR (rule 4)', async () => {
    const { describeEmptiness } = await loadOperators();
    for (const path of ['node', 'node.child', 'left', 'left.right', 'refNode']) expect(await describeOn(path), path).toBe('INVALID_FILTER_OPERATOR');
    // Rule 4 comes before the value and rule 6, and after rule 3.
    expect(await describeOn('node', { value: 'x' })).toBe('INVALID_FILTER_OPERATOR');
    expect(await describeOn('refNode', { value: 'x' })).toBe('INVALID_FILTER_OPERATOR');
    expect(await describeOn('shapeNode')).toBe('INVALID_FILTER_PATH');
    expect(errorOf(() => describeEmptiness(Root, ['node'], { operator: 'IS_EMPTY' })).message)
      .toBe('IS_EMPTY cannot test node: the embedded type QcNode reaches itself through the single embedded member node.child');
    // Leaves expand nothing.
    expect(describeEmptiness(Root, ['node', 'label'], { operator: 'IS_EMPTY' })).toEqual(STRING);
    expect(describeEmptiness(Root, ['node', 'child', 'child', 'label'], { operator: 'IS_EMPTY' })).toEqual(STRING);
  });

  it('accepts a type that reaches itself only through a list member', async () => {
    const { describeEmptiness } = await loadOperators();
    expect(describeEmptiness(Root, ['tree'], { operator: 'IS_EMPTY' })).toEqual(object({ label: STRING, children: LIST }));
    expect(describeEmptiness(Root, ['tree', 'children'], { operator: 'IS_NOT_EMPTY' })).toEqual(LIST);
    expect(await describeOn('tree.children.label')).toBe('INVALID_FILTER_PATH');
  });

  it('reads an object field without a relation as embedded, and rejects virtual fields as unknown', async () => {
    const { describeEmptiness } = await loadOperators();
    expect(describeEmptiness(Root, ['loose'], { operator: 'IS_EMPTY' })).toEqual(object({ a: STRING }));
    expect(await describeOn('virtualShape')).toBe('INVALID_FILTER_FIELD');
    expect(await describeOn('')).toBe('INVALID_FILTER_PATH');
  });

  it('agrees with the description of the models for every path of the fixture', async () => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    const outcome = (body) => {
      try {
        return { shape: body() };
      } catch (error) {
        return { code: error.extensions?.code, message: error.message };
      }
    };
    const paths = [
      ...ACCEPTED.map(([typeName, path]) => [typeName, path]),
      ...REJECTED.filter(([, path]) => !['ghost.label'].includes(path)).map(([typeName, path]) => [typeName, path]),
      ...REFERENCES.map(([typeName, path]) => [typeName, path]),
      ...EMPTINESS_CASES.flatMap((item) => Object.keys(item.expectEmpty).filter((path) => path !== 'meta')
        .map((path) => [item.root === 'owned' ? owned(item.name).name : { item: 'QcItem', sid: 'QcSid' }[item.root], path])),
    ];
    for (const [typeName, path] of paths) {
      for (const value of [undefined, 'x']) {
        for (const referenceEmptiness of [true, false]) {
          const options = {
            operator: 'IS_EMPTY', value, path, referenceEmptiness,
          };
          const fromTypes = outcome(() => describeEmptiness(typeNamed(typeName), path.split('.'), options));
          const fromModels = outcome(() => describeModelEmptiness(resolveModelPath(models, typeName, path), options));
          expect(fromModels, `${typeName}.${path} ${value} ${referenceEmptiness}`).toEqual(fromTypes);
        }
      }
    }
  });
});

describe('emptinessMemberPaths', () => {
  it('lists the stored member paths of an embedded object, through single embedded members only', async () => {
    const { emptinessMemberPaths } = await loadOperators();
    const members = (path) => emptinessMemberPaths(fixture.Item, path.split('.')).map((segments) => segments.join('.'));
    expect(members('dims')).toEqual(['dims.w', 'dims.label', 'dims.tags']);
    expect(members('outer')).toEqual(['outer.x', 'outer.inner', 'outer.inner.y', 'outer.inner.z']);
    expect(members('outer.inner')).toEqual(['outer.inner.y', 'outer.inner.z']);
    // A reference member is listed and not entered; virtual members are left out.
    expect(members('odim')).toEqual(['odim.w', 'odim.tags', 'odim.shop']);
    expect(members('ghost')).toEqual([]);
    // Paths through a reference are listed too, so that their members are checked before 2a rejects them.
    expect(emptinessMemberPaths(fixture.Review, ['item', 'plain']).map((segments) => segments.join('.'))).toEqual(['item.plain.a', 'item.plain.b']);
    for (const path of ['note', 'tags', 'lines', 'olines', 'shop', 'reviews', 'odim.shop', 'nope', 'dims.nope', 'note.x', 'ghost.label']) {
      expect(members(path), path).toEqual([]);
    }
  });

  it('never throws', async () => {
    const { emptinessMemberPaths } = await loadOperators();
    for (const [type, segments] of [[undefined, ['dims']], [null, null], [fixture.Item, undefined], [fixture.Item, 'dims'], [fixture.Item, []], [fixture.Item, [null]], [GraphQLString, ['x']]]) {
      expect(emptinessMemberPaths(type, segments)).toEqual([]);
    }
  });

  it('lists reference, collection, interface and union members without entering them, at any depth', async () => {
    const { emptinessMemberPaths } = await loadOperators();
    const members = (path) => emptinessMemberPaths(Root, path.split('.')).map((segments) => segments.join('.'));
    expect(members('withInterface')).toEqual(['withInterface.label', 'withInterface.shape']);
    expect(members('withUnionList')).toEqual(['withUnionList.tags', 'withUnionList.parts']);
    expect(members('withCollection')).toEqual(['withCollection.title', 'withCollection.children']);
    expect(members('withBoth')).toEqual(['withBoth.owner', 'withBoth.shape']);
    expect(members('mid')).toEqual(['mid.x', 'mid.deep', 'mid.deep.owner', 'mid.deep.n']);
    expect(members('midShape')).toEqual(['midShape.deep', 'midShape.deep.shape']);
    expect(members('midBoth')).toEqual(['midBoth.owner', 'midBoth.deep', 'midBoth.deep.shape']);
    for (const path of ['shape', 'shapes', 'either', 'withInterface.shape', 'withCollection.children', 'virtualShape']) expect(members(path), path).toEqual([]);
    // The collector marks them as members, so that their checks run before the 400 codes.
    const paths = collectQueryPathEntries({
      withInterface: { terms: [{ operator: 'IS_EMPTY' }] },
      AND: [{ conditions: [{ field: 'withCollection', operator: 'IS_NOT_EMPTY' }, { field: 'withUnionList', path: '', operator: 'IS_EMPTY' }] }],
    }, 'find', { gqltype: Root, expandMembers: true }).map(({ segments, member }) => `${segments.join('.')}${member ? '*' : ''}`);
    expect(paths).toEqual([
      'withInterface', 'withInterface.label*', 'withInterface.shape*', 'withCollection', 'withCollection.title*', 'withCollection.children*',
      'withUnionList', 'withUnionList.tags*', 'withUnionList.parts*',
    ]);
  });

  it('stops at a type already on its chain, and lists only what lists hold', async () => {
    const { emptinessMemberPaths } = await loadOperators();
    const MemberNode = new GraphQLObjectType({ name: 'QcMemberNode', fields: () => ({ label: { type: GraphQLString }, child: { type: MemberNode, extensions: { relation: { embedded: true }, readOnly: true } } }) });
    const MemberTree = new GraphQLObjectType({ name: 'QcMemberTree', fields: () => ({ label: { type: GraphQLString }, children: { type: new GraphQLList(MemberTree), extensions: { relation: { embedded: true } } } }) });
    const MemberHolder = new GraphQLObjectType({ name: 'QcMemberHolder', fields: { node: { type: MemberNode, extensions: { relation: { embedded: true } } }, tree: { type: MemberTree, extensions: { relation: { embedded: true } } } } });
    expect(emptinessMemberPaths(MemberHolder, ['node'])).toEqual([['node', 'label'], ['node', 'child']]);
    expect(emptinessMemberPaths(MemberHolder, ['tree'])).toEqual([['tree', 'label'], ['tree', 'children']]);
  });
});

describe('collectQueryOperators', () => {
  it('pin: reports the form, raw field and path, value, group depth and construct of each condition', () => {
    // The construct is the term or condition object itself, and null for a field filter's own operator.
    const entry = (fields, construct = null) => ({
      rawPath: undefined, value: undefined, hasValue: false, ambiguous: false, depth: 0, ...fields, segments: fields.path.split('.'),
      construct, emptiness: EMPTINESS.includes(fields.operator),
    });
    const args = {
      note: { operator: 'IS_EMPTY' },
      dims: { terms: [{ operator: 'IS_EMPTY' }, { path: 'w', operator: 'EQ', value: 1 }, { path: '', operator: 'IS_NOT_EMPTY', value: null }] },
      shop: { operator: 'IS_EMPTY', terms: [{ path: 'name', value: 'a' }] },
      lines: { operator: 'IS_NOT_EMPTY' },
      AND: [{
        conditions: [
          { field: 'shop.name', path: 'x', operator: 'IS_EMPTY' }, { field: 'plain', path: '', operator: 'IS_EMPTY' },
          // A dotted field is ambiguous only next to a non-empty path.
          { field: 'outer.inner.z', operator: 'IS_EMPTY' }, { field: 'outer.inner', path: '', operator: 'IS_NOT_EMPTY' },
          { field: 'outer.inner', path: null, operator: 'IS_EMPTY' }, { field: 'shop.name', path: 'y', value: 'a' },
        ],
        OR: [{ conditions: [{ field: 'outer', path: 'inner', value: 2 }] }],
      }],
      sort: { terms: [{ field: 'note', order: 'ASC' }] },
    };
    const terms = args.dims.terms;
    const conditions = args.AND[0].conditions;
    const entries = collectQueryOperators(args);
    expect(legacyEntries(entries)).toEqual([
      entry({ operator: 'IS_EMPTY', path: 'note', form: 'filter', field: 'note' }),
      // A term without a path names the field itself.
      entry({ operator: 'IS_EMPTY', path: 'dims', form: 'term', field: 'dims' }, terms[0]),
      entry({ operator: 'EQ', path: 'dims.w', form: 'term', field: 'dims', rawPath: 'w', value: 1, hasValue: true }, terms[1]),
      entry({ operator: 'IS_NOT_EMPTY', path: 'dims', form: 'term', field: 'dims', rawPath: '', value: null, hasValue: true }, terms[2]),
      entry({ operator: 'IS_EMPTY', path: 'shop', form: 'beside-terms', field: 'shop' }),
      entry({ operator: 'EQ', path: 'shop.name', form: 'term', field: 'shop', rawPath: 'name', value: 'a', hasValue: true }, args.shop.terms[0]),
      entry({ operator: 'IS_NOT_EMPTY', path: 'lines', form: 'filter', field: 'lines' }),
      entry({ operator: 'IS_EMPTY', path: 'shop.name.x', form: 'condition', field: 'shop.name', rawPath: 'x', ambiguous: true }, conditions[0]),
      entry({ operator: 'IS_EMPTY', path: 'plain', form: 'condition', field: 'plain', rawPath: '' }, conditions[1]),
      entry({ operator: 'IS_EMPTY', path: 'outer.inner.z', form: 'condition', field: 'outer.inner.z' }, conditions[2]),
      entry({ operator: 'IS_NOT_EMPTY', path: 'outer.inner', form: 'condition', field: 'outer.inner', rawPath: '' }, conditions[3]),
      entry({ operator: 'IS_EMPTY', path: 'outer.inner', form: 'condition', field: 'outer.inner', rawPath: null }, conditions[4]),
      entry({ operator: 'EQ', path: 'shop.name.y', form: 'condition', field: 'shop.name', rawPath: 'y', value: 'a', hasValue: true, ambiguous: true }, conditions[5]),
      entry({ operator: 'EQ', path: 'outer.inner', form: 'condition', field: 'outer', rawPath: 'inner', value: 2, hasValue: true, depth: 1 }, args.AND[0].OR[0].conditions[0]),
    ]);
    expect(entries[1].construct).toBe(terms[0]);
    expect(entries[7].construct).toBe(conditions[0]);
  });

  it('reads each group once, at the deepest level it appears at', () => {
    const shared = { conditions: [{ field: 'note', operator: 'IS_EMPTY' }] };
    const entries = collectQueryOperators({ AND: [shared, { AND: [{ OR: [shared] }] }] });
    expect(entries.map(({ path, depth }) => [path, depth])).toEqual([['note', 2]]);
    const loop = { conditions: [{ field: 'tags', operator: 'IS_NOT_EMPTY' }] };
    loop.AND = [loop];
    expect(collectQueryOperators({ OR: [loop] }).map(({ path, depth }) => [path, depth])).toEqual([['tags', 0]]);
    const deep = nested({ field: 'shop', path: 'name', operator: 'IS_EMPTY' }, 6);
    expect(collectQueryOperators(deep).map(({ path, depth }) => [path, depth])).toEqual([['shop.name', 6]]);
  });

  it('pin: keeps skipping malformed entries', () => {
    expect(collectQueryOperators(null)).toEqual([]);
    expect(collectQueryOperators({ note: 'x', dims: { terms: [null, 'x', [1]] }, AND: [null, { conditions: [null, 5] }] })).toEqual([]);
    const condition = { operator: 'IS_EMPTY' };
    expect(legacyEntries(collectQueryOperators({ AND: [{ conditions: [condition] }] }))).toEqual([{
      operator: 'IS_EMPTY', path: undefined, segments: [], form: 'condition', field: undefined, rawPath: undefined,
      value: undefined, hasValue: false, ambiguous: false, depth: 0, construct: condition, emptiness: true,
    }]);
  });
});

describe('collectQueryPathEntries', () => {
  it('pin: adds the field of every emptiness term without a path, next to the paths of its sibling terms', () => {
    const args = {
      dims: { terms: [{ operator: 'IS_EMPTY' }, { path: 'w', operator: 'EQ', value: 1 }] },
      plain: { terms: [{ path: 'a', operator: 'EQ', value: 1 }, { path: '', operator: 'IS_NOT_EMPTY' }, { path: null, operator: 'IS_EMPTY' }] },
      // Other operators keep today's paths.
      tags: { terms: [{ operator: 'EQ', value: 'x' }, { path: 'x', operator: 'EQ', value: 1 }] },
      lines: { terms: [{ operator: 'EQ', value: 1 }] },
    };
    const entry = (path, operator, construct = null) => ({
      segments: path.split('.'), group: null, operator, construct,
    });
    expect(legacyEntries(collectQueryPathEntries(args))).toEqual([
      entry('dims', 'IS_EMPTY', args.dims.terms[0]), entry('dims.w', 'EQ', args.dims.terms[1]),
      entry('plain.a', 'EQ', args.plain.terms[0]), entry('plain', 'IS_NOT_EMPTY', args.plain.terms[1]),
      entry('tags.x', 'EQ', args.tags.terms[1]), entry('lines', 'EQ'),
    ]);
    expect(collectQueryPaths({ dims: { terms: [{ path: 'w', operator: 'EQ', value: 1 }, { path: '', operator: 'IS_EMPTY' }] } }))
      .toEqual([['dims', 'w'], ['dims']]);
  });

  it('pin: expands the members an emptiness condition reads when asked, marked as members, after the named path', () => {
    const args = {
      dims: { terms: [{ path: 'w', operator: 'EQ', value: 1 }, { operator: 'IS_EMPTY' }] },
      AND: [{ conditions: [{ field: 'odim', operator: 'IS_NOT_EMPTY' }, { field: 'outer', path: 'inner', operator: 'IS_EMPTY' }] }],
      sort: { terms: [{ field: 'note', order: 'ASC' }] },
    };
    const group = args.AND[0];
    const [dimsW, dims] = args.dims.terms;
    const [odim, inner] = group.conditions;
    // Members carry the operator and the construct of the condition that reads them.
    const entry = (path, owner, operator, construct) => ({
      segments: path.split('.'), group: owner, operator, construct,
    });
    const member = (path, owner, operator, construct) => ({ ...entry(path, owner, operator, construct), member: true });
    expect(legacyEntries(collectQueryPathEntries(args, 'find', { gqltype: fixture.Item, expandMembers: true }))).toEqual([
      entry('dims.w', null, 'EQ', dimsW),
      entry('dims', null, 'IS_EMPTY', dims), member('dims.w', null, 'IS_EMPTY', dims), member('dims.label', null, 'IS_EMPTY', dims),
      member('dims.tags', null, 'IS_EMPTY', dims),
      entry('odim', group, 'IS_NOT_EMPTY', odim), member('odim.w', group, 'IS_NOT_EMPTY', odim), member('odim.tags', group, 'IS_NOT_EMPTY', odim),
      member('odim.shop', group, 'IS_NOT_EMPTY', odim),
      entry('outer.inner', group, 'IS_EMPTY', inner), member('outer.inner.y', group, 'IS_EMPTY', inner), member('outer.inner.z', group, 'IS_EMPTY', inner),
      // Sort, groupId and fact paths have no operator and no construct.
      entry('note', null, null, null),
    ]);
    // Without the flag or the type, and for other operators, nothing is expanded.
    expect(collectQueryPathEntries(args)).toEqual(collectQueryPathEntries(args, 'find', { gqltype: fixture.Item }));
    expect(collectQueryPathEntries(args, 'find', { expandMembers: true }).some((item) => item.member)).toBe(false);
    expect(legacyEntries(collectQueryPathEntries({ AND: [{ conditions: [{ field: 'dims', operator: 'EQ', value: 1 }] }] }, 'find', { gqltype: fixture.Item, expandMembers: true })))
      .toEqual([{
        segments: ['dims'], group: expect.any(Object), operator: 'EQ', construct: expect.any(Object),
      }]);
  });

  it('pin: expands fields filters and pathed terms too, and nothing for lists, scalars and virtual members', () => {
    const paths = (args) => collectQueryPathEntries(args, 'find', { gqltype: fixture.Item, expandMembers: true })
      .map(({ segments, member }) => `${segments.join('.')}${member ? '*' : ''}`);
    expect(paths({
      ghost: { terms: [{ operator: 'IS_EMPTY' }] },
      lines: { terms: [{ operator: 'IS_EMPTY' }] },
      tags: { operator: 'IS_NOT_EMPTY' },
      outer: { terms: [{ path: 'inner', operator: 'IS_EMPTY' }] },
      plain: { operator: 'IS_EMPTY', terms: [{ path: 'a', operator: 'EQ', value: 1 }] },
    })).toEqual(['ghost', 'lines', 'tags', 'outer.inner', 'outer.inner.y*', 'outer.inner.z*', 'plain.a', 'plain', 'plain.a*', 'plain.b*']);
    // The commonest form, a term without a path and without siblings, with `path` omitted, "" or null, and the
    // operator written on the filter itself, which the compilers reject later.
    for (const value of [
      { terms: [{ operator: 'IS_EMPTY' }] }, { terms: [{ path: '', operator: 'IS_NOT_EMPTY' }] }, { terms: [{ path: null, operator: 'IS_EMPTY', value: null }] },
      { operator: 'IS_EMPTY' }, { operator: 'IS_NOT_EMPTY', terms: [] },
    ]) {
      expect(paths({ dims: value }), JSON.stringify(value)).toEqual(['dims', 'dims.w*', 'dims.label*', 'dims.tags*']);
    }
    expect(paths({ outer: { terms: [{ operator: 'IS_EMPTY' }] } })).toEqual(['outer', 'outer.x*', 'outer.inner*', 'outer.inner.y*', 'outer.inner.z*']);
    expect(paths({ aggregation: { groupId: 'dims', facts: [{ path: 'dims.w' }] } })).toEqual(['aggregation']);
    expect(legacyEntries(collectQueryPathEntries({ aggregation: { groupId: 'dims', facts: [{ path: 'dims.w' }] } }, 'aggregate', { gqltype: fixture.Item, expandMembers: true })))
      .toEqual([{
        segments: ['dims'], group: null, operator: null, construct: null,
      }, {
        segments: ['dims', 'w'], group: null, operator: null, construct: null,
      }]);
  });
});

describe('query plans with emptiness operators', () => {
  it('plans field filters, terms with and without a path, and group conditions', () => {
    const result = plan({
      note: { operator: 'IS_EMPTY' },
      tags: { operator: 'IS_NOT_EMPTY', value: null },
      dims: { terms: [{ operator: 'IS_EMPTY' }, { path: 'w', operator: 'IS_NOT_EMPTY' }, { path: '', operator: 'IS_EMPTY', value: null }, { path: null, operator: 'IS_NOT_EMPTY' }] },
      lines: { terms: [{ operator: 'IS_NOT_EMPTY' }] },
      odim: { terms: [{ path: 'tags', operator: 'IS_EMPTY' }] },
      AND: [{ conditions: [
        { field: 'outer', operator: 'IS_EMPTY' }, { field: 'outer', path: 'inner', operator: 'IS_NOT_EMPTY' },
        { field: 'outer.inner.z', operator: 'IS_EMPTY' }, { field: 'plain', path: '', operator: 'IS_EMPTY' },
      ] }],
      OR: [{ conditions: [{ field: 'ghost', operator: 'IS_EMPTY' }] }, { conditions: [{ field: 'id', operator: 'IS_NOT_EMPTY' }] }],
    });
    expect(predicatesOf(result.where)).toEqual([
      predicate('note', 'IS_EMPTY'), predicate('tags', 'IS_NOT_EMPTY'),
      predicate('dims', 'IS_EMPTY'), predicate('dims.w', 'IS_NOT_EMPTY'), predicate('dims', 'IS_EMPTY'), predicate('dims', 'IS_NOT_EMPTY'),
      predicate('lines', 'IS_NOT_EMPTY'), predicate('odim.tags', 'IS_EMPTY'),
      predicate('outer', 'IS_EMPTY'), predicate('outer.inner', 'IS_NOT_EMPTY'), predicate('outer.inner.z', 'IS_EMPTY'), predicate('plain', 'IS_EMPTY'),
      predicate('ghost', 'IS_EMPTY'), predicate('id', 'IS_NOT_EMPTY'),
    ]);
    // Every plan predicate has a null value and no other key.
    for (const node of predicatesOf(result.where)) expect(Object.keys(node)).toEqual(['kind', 'path', 'operator', 'value']);
  });

  it('plans path-less emptiness terms next to terms of other operators', () => {
    expect(predicatesOf(plan({ dims: { terms: [{ operator: 'IS_EMPTY' }, { path: 'w', operator: 'EQ', value: 1 }] } }).where))
      .toEqual([predicate('dims', 'IS_EMPTY'), predicate('dims.w', 'EQ', 1)]);
  });

  it('plans them in count and aggregate plans, on owned storage and on a String identity', () => {
    expect(plan({ dims: { terms: [{ operator: 'IS_EMPTY' }] } }, { mode: 'count' }).where).toEqual(predicate('dims', 'IS_EMPTY'));
    const aggregate = plan({ note: { operator: 'IS_NOT_EMPTY' }, aggregation: { groupId: 'kind', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] } }, { mode: 'aggregate' });
    expect(aggregate.where).toEqual(predicate('note', 'IS_NOT_EMPTY'));
    expect(predicatesOf(createQueryPlan(models, OWNED_ROOT.name, {
      udim: { terms: [{ operator: 'IS_EMPTY' }] }, nest: { terms: [{ path: 'meta', operator: 'IS_NOT_EMPTY' }, { path: 'mlines', operator: 'IS_EMPTY' }] },
    }).where)).toEqual([predicate('udim', 'IS_EMPTY'), predicate('nest.meta', 'IS_NOT_EMPTY'), predicate('nest.mlines', 'IS_EMPTY')]);
    expect(createQueryPlan(models, 'QcSid', { id: { operator: 'IS_EMPTY' } }).where).toEqual(predicate('id', 'IS_EMPTY'));
  });

  it('rejects an emptiness operator on an object filter without terms, or beside terms, with MISSING_FILTER_PATH', () => {
    for (const field of ['dims', 'lines', 'odim', 'shop', 'reviews']) {
      for (const value of [
        { operator: 'IS_EMPTY' }, { operator: 'IS_NOT_EMPTY', value: null }, { operator: 'IS_EMPTY', terms: [] },
        { operator: 'IS_EMPTY', terms: [{ path: field === 'shop' ? 'name' : 'w', operator: 'EQ', value: 1 }] },
        { operator: 'IS_NOT_EMPTY', terms: [{ operator: 'IS_EMPTY' }] }, { operator: 'IS_EMPTY', value: 1 },
      ]) {
        const input = { [field]: value };
        expect(codeOf(() => plan(input)), JSON.stringify(input)).toBe('MISSING_FILTER_PATH');
        expect(codeOf(() => plan(input, { operators: LEGACY })), JSON.stringify(input)).toBe('MISSING_FILTER_PATH');
      }
    }
    expect(() => plan({ dims: { operator: 'IS_EMPTY' } })).toThrow('use a term without a path: dims: { terms: [{ operator: IS_EMPTY }] }');
    // Other operators beside terms are still left out, as before.
    expect(plan({ dims: { operator: 'EQ', terms: [{ path: 'w', value: 1 }] } }).where).toEqual(predicate('dims.w', 'EQ', 1));
  });

  it('applies the order of checks', () => {
    const IS_EMPTY = { operator: 'IS_EMPTY' };
    const condition = (field, path, extra = {}) => ({ AND: [{ conditions: [{ field, ...(path === undefined ? {} : { path }), ...IS_EMPTY, ...extra }] }] });
    const cases = [
      // Rule 1: form, syntax, fields and depth.
      [condition('shop.name', 'x'), 'AMBIGUOUS_FILTER_FIELD'], [condition('outer.inner', 'z'), 'AMBIGUOUS_FILTER_FIELD'],
      [{ shop: { terms: [{ path: 'nope', ...IS_EMPTY }] } }, 'INVALID_FILTER_FIELD'], [{ shop: { terms: [{ path: 'name.x', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH'],
      [condition('ghost', 'label'), 'INVALID_FILTER_FIELD'], [{ lines: { terms: [{ path: 'nope', ...IS_EMPTY }] } }, 'INVALID_FILTER_FIELD'],
      [nested({ field: 'shop', path: 'name', ...IS_EMPTY }, 6), 'FILTER_DEPTH_EXCEEDED'],
      [nested({ field: 'lines', path: 'qty', ...IS_EMPTY }, 6), 'FILTER_DEPTH_EXCEEDED'],
      // Rule 3: leaves through lists and collections.
      [{ lines: { terms: [{ path: 'qty', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH'], [condition('reviews', 'text'), 'INVALID_FILTER_PATH'],
      [condition('shop', 'items.note'), 'INVALID_FILTER_PATH'], [{ olines: { terms: [{ path: 'shop', ...IS_EMPTY, value: 'x' }] } }, 'INVALID_FILTER_PATH'],
      // Rule 5: the value, before rule 6.
      [{ note: { ...IS_EMPTY, value: 'x' } }, 'INVALID_FILTER_VALUE'], [{ odim: { terms: [{ ...IS_EMPTY, value: 'x' }] } }, 'INVALID_FILTER_VALUE'],
      [condition('shop', undefined, { value: '' }), 'INVALID_FILTER_VALUE'], [{ dims: { terms: [{ ...IS_EMPTY, value: [] }] } }, 'INVALID_FILTER_VALUE'],
      [{ tags: { ...IS_EMPTY, value: [] } }, 'INVALID_FILTER_VALUE'], [{ plain: { terms: [{ path: 'a', ...IS_EMPTY, value: 0 }] } }, 'INVALID_FILTER_VALUE'],
      [{ dims: { terms: [{ ...IS_EMPTY, value: false }] } }, 'INVALID_FILTER_VALUE'], [{ outer: { terms: [{ ...IS_EMPTY, value: {} }] } }, 'INVALID_FILTER_VALUE'],
    ];
    for (const [input, code] of cases) {
      expect(codeOf(() => plan(input)), JSON.stringify(input)).toBe(code);
      expect(codeOf(() => plan(input, UNDECLARED)), JSON.stringify(input)).toBe(code);
    }
    // Rule 6: references and collections, crossed, reached, or members. Without reference emptiness they fail last.
    const references = [
      { shop: { terms: [IS_EMPTY] } }, condition('shop'), condition('shop', 'name'), { reviews: { terms: [IS_EMPTY] } }, { odim: { terms: [IS_EMPTY] } },
      { odim: { terms: [{ path: 'shop', ...IS_EMPTY }] } }, condition('shop', 'items'), nested({ field: 'shop', path: 'name', ...IS_EMPTY }, 5),
    ];
    for (const input of references) {
      expect(predicatesOf(plan(input).where).map((node) => node.operator), JSON.stringify(input)).toEqual(['IS_EMPTY']);
      expect(codeOf(() => plan(input, UNDECLARED)), JSON.stringify(input)).toBe('UNSUPPORTED_QUERY');
    }
    const review = { item: { terms: [{ path: 'dims', ...IS_EMPTY }] } };
    expect(createQueryPlan(models, 'QcReview', review).where).toEqual(predicate('item.dims', 'IS_EMPTY'));
    expect(codeOf(() => createQueryPlan(models, 'QcReview', review, UNDECLARED))).toBe('UNSUPPORTED_QUERY');
  });

  it('rejects an operator the compiler does not declare after rule 1 and before the other rules (rule 2)', () => {
    const operators = LEGACY;
    for (const input of [
      { dims: { terms: [{ operator: 'IS_EMPTY' }] } }, { note: { operator: 'IS_NOT_EMPTY' } },
      { lines: { terms: [{ path: 'qty', operator: 'IS_EMPTY' }] } }, { shop: { terms: [{ path: 'name', operator: 'IS_EMPTY', value: 'x' }] } },
      { AND: [{ conditions: [{ field: 'odim', operator: 'IS_EMPTY', value: 1 }] }] },
    ]) expect(codeOf(() => plan(input, { operators })), JSON.stringify(input)).toBe('UNSUPPORTED_QUERY');
    expect(codeOf(() => plan({ nope: { operator: 'IS_EMPTY' } }, { operators }))).toBe('INVALID_FILTER_FIELD');
    expect(codeOf(() => plan({ shop: { terms: [{ path: 'name.x', operator: 'IS_EMPTY' }] } }, { operators }))).toBe('INVALID_FILTER_PATH');
    expect(codeOf(() => plan(nested({ field: 'note', operator: 'IS_EMPTY' }, 6), { operators }))).toBe('FILTER_DEPTH_EXCEEDED');
    expect(plan({ note: { operator: 'IS_EMPTY' } }, { operators: [...LEGACY, 'IS_EMPTY'] }).where).toEqual(predicate('note', 'IS_EMPTY'));
    expect(codeOf(() => plan({ note: { operator: 'IS_NOT_EMPTY' } }, { operators: [...LEGACY, 'IS_EMPTY'] }))).toBe('UNSUPPORTED_QUERY');
    expect(errorOf(() => plan({ note: { operator: 'IS_NOT_EMPTY' } }, { operators })).message)
      .toBe('The IS_NOT_EMPTY filter operator is not supported by this query compiler');
  });

  it('gives the same predicates and codes from a description without GraphQL types', () => {
    const inputs = [
      ...ACCEPTED.filter(([typeName]) => typeName === 'QcItem').map(([, path]) => {
        const [head, ...rest] = path.split('.');
        return { AND: [{ conditions: [{ field: head, path: rest.join('.'), operator: 'IS_EMPTY' }] }] };
      }),
      ...[...REJECTED, ...REFERENCES].filter(([typeName]) => typeName === 'QcItem')
        .map(([, path]) => ({ AND: [{ conditions: [{ field: path, operator: 'IS_NOT_EMPTY' }] }] })),
      { odim: { terms: [{ operator: 'IS_EMPTY', value: 'x' }] } },
    ];
    for (const input of inputs) {
      for (const options of [undefined, UNDECLARED]) {
        const typed = errorOf(() => plan(input, options)) ?? plan(input, options);
        const untyped = errorOf(() => createQueryPlan(untypedModels, 'QcItem', input, options)) ?? createQueryPlan(untypedModels, 'QcItem', input, options);
        if (typed instanceof Error) expect([untyped.extensions?.code, untyped.message], JSON.stringify(input)).toEqual([typed.extensions?.code, typed.message]);
        else expect(untyped, JSON.stringify(input)).toEqual(typed);
      }
    }
    expect(createQueryPlan(untypedModels, 'QcSid', { id: { operator: 'IS_EMPTY' } }).where).toEqual(predicate('id', 'IS_EMPTY'));
  });

  it('reads an inferred inverse reference as an ID scalar', async () => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    const Note = new GraphQLObjectType({ name: 'QcNote', fields: { id: { type: GraphQLID }, parentId: { type: GraphQLID }, text: { type: GraphQLString } } });
    const Parent = new GraphQLObjectType({ name: 'QcParent', fields: { id: { type: GraphQLID }, notes: { type: new GraphQLList(Note), extensions: { relation: { embedded: false, connectionField: 'parentId' } } } } });
    const described = describeModels([{ gqltype: Parent }, { gqltype: Note }]);
    expect(resolveModelPath(described, 'QcNote', 'parentId')[0]).toMatchObject({ kind: 'reference', inferred: true });
    expect(createQueryPlan(described, 'QcNote', { parentId: { operator: 'IS_EMPTY' } }).where).toEqual(predicate('parentId', 'IS_EMPTY'));
    expect(describeEmptiness(Note, ['parentId'], { operator: 'IS_EMPTY' })).toEqual(NULL);
    expect(describeModelEmptiness(resolveModelPath(described, 'QcNote', 'parentId'), { operator: 'IS_EMPTY' })).toEqual(NULL);
  });

  it('rejects longer filter paths that end at an object with INVALID_FILTER_PATH, and keeps MISSING_FILTER_PATH for a bare field', () => {
    for (const input of [
      { AND: [{ conditions: [{ field: 'outer', path: 'inner', value: 1 }] }] },
      { AND: [{ conditions: [{ field: 'outer.inner', operator: 'NE', value: null }] }] },
      { outer: { terms: [{ path: 'inner', value: 1 }] } },
      { odim: { terms: [{ path: 'shop', value: 1 }] } },
      { shop: { terms: [{ path: 'items', value: 1 }] } },
      { reviews: { terms: [{ path: 'item', operator: 'ILIKE', value: 'a' }] } },
    ]) expect(codeOf(() => plan(input)), JSON.stringify(input)).toBe('INVALID_FILTER_PATH');
    for (const input of [
      { AND: [{ conditions: [{ field: 'dims', value: 1 }] }] }, { AND: [{ conditions: [{ field: 'shop', operator: 'EQ', value: 1 }] }] },
      { AND: [{ conditions: [{ field: 'dims', operator: 'BAD', value: 1 }] }] }, { dims: { operator: 'ILIKE', value: 'a' } }, { shop: { value: 1 } },
    ]) expect(codeOf(() => plan(input)), JSON.stringify(input)).toBe('MISSING_FILTER_PATH');
  });

  it('keeps the codes of path-less terms of other operators, and of sort, groupId and fact paths (regression pins, pass on 3.9.0)', () => {
    for (const term of [{ operator: 'EQ', value: 1 }, { path: '', operator: 'EQ', value: 1 }, { path: null, value: 1 }, { path: 5, operator: 'IS_EMPTY' }]) {
      expect(codeOf(() => plan({ dims: { terms: [term] } })), JSON.stringify(term)).toBe('INVALID_FILTER_PATH');
    }
    expect(codeOf(() => plan({ sort: { terms: [{ field: 'dims', order: 'ASC' }] } }))).toBe('INVALID_FILTER_PATH');
    expect(plan({ aggregation: { groupId: 'dims', facts: [{ operation: 'COUNT', factName: 'n', path: 'outer.inner' }] } }, { mode: 'aggregate' }).aggregation)
      .toEqual({ groupId: ['dims'], facts: [{ operation: 'COUNT', factName: 'n', path: ['outer', 'inner'] }] });
    expect(codeOf(() => plan({ ghost: { terms: [{ path: 'label', operator: 'EQ', value: 'x' }] } }))).toBe('INVALID_FILTER_FIELD');
  });
});

describe('the emptiness test helper', () => {
  // Keeps records in memory and leaves the state of a state machine to the runtime, which then stores its name, as
  // MongoDB's default adapter does.
  const createMemoryAdapter = () => {
    const records = new Map();
    let next = 0;
    const tableOf = (Model) => {
      if (!records.has(Model.name)) records.set(Model.name, new Map());
      return records.get(Model.name);
    };
    const copy = (record) => (record ? structuredClone(record) : null);
    return {
      records,
      prepare() {},
      createModel: (gqltype) => ({ name: gqltype.name }),
      castId: String,
      withTransaction: async (session, body) => body(session || {}),
      newRecord: (Model, data) => ({ ...data, _id: String(next += 1) }),
      async saveRecord(Model, record) {
        tableOf(Model).set(record._id, copy(record));
        return copy(record);
      },
      toObject: (record) => ({ ...record }),
      getById: async (Model, id) => copy(tableOf(Model).get(String(id))),
      prepareUpdate: (set, unset) => ({ set, unset }),
      async update(Model, id, update) {
        const current = tableOf(Model).get(String(id));
        if (!current) return null;
        for (const key of Object.keys(update.unset)) delete current[key];
        Object.assign(current, structuredClone(update.set));
        return copy(current);
      },
      find: async (Model) => [...tableOf(Model).values()].map(copy),
      count: async (Model) => tableOf(Model).size,
      aggregate: async () => [],
      findChildren: async () => [],
    };
  };

  it('seeds every case through generated mutations, and its state reads back where the state name is stored', async () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const types = createEmptinessTypes('Qh', { backend: 'mongodb' });
    registerEmptinessTypes(runtime, types);
    const schema = runtime.createSchema();
    const seeded = await seedEmptiness(schema, types);
    expect(Object.keys(seeded)).toEqual(EMPTINESS_CASES.map((item) => item.name));
    const itemKeys = EMPTINESS_CASES.filter((item) => item.root === 'item').map((item) => item.name).sort();
    expect([...adapter.records.get('QhItem').values()].map((record) => record.state)).toEqual(itemKeys.map(() => 'OPEN'));
    const { source, variables } = emptinessQuery(types, 'item', {}, 'key state');
    const result = await graphql({ schema, source, variableValues: variables, contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data.qhItems.map(({ key }) => key).sort()).toEqual(itemKeys);
    expect(result.data.qhItems.map(({ state }) => state)).toEqual(itemKeys.map(() => 'OPEN'));
  });

  it('builds native PostgreSQL writes on root columns, owned rows and owned states, in one statement each', () => {
    const database = describeDatabase(registrationsOf(fixture), { schema: 'app' });
    const id = '0b5a1d2e-3c4f-4a6b-8c7d-9e0f1a2b3c4d';
    const writes = (rootKey, list, options) => postgresEmptinessStatements(database, fixture, rootKey, id, list, options);
    const on = (text) => ({ text, values: [id] });
    expect(writes('item', [
      { path: 'dims', sql: '\'null\'::jsonb', present: true }, { path: 'plain', sql: '\'{"a":null}\'::jsonb' },
      { path: 'tags', sql: 'ARRAY[NULL]::text[]' }, { path: 'note', sql: '\' \'' }, { path: 'olines', state: 'null' },
      { path: 'odim', state: 'missing' }, { path: 'odim.w', sql: 'NULL', present: false },
    ])).toEqual([
      on('UPDATE "app"."QcItem" SET "dims" = \'null\'::jsonb, "__field__dims__present" = TRUE WHERE "id" = $1'),
      on('UPDATE "app"."QcItem" SET "plain" = \'{"a":null}\'::jsonb WHERE "id" = $1'),
      on('UPDATE "app"."QcItem" SET "tags" = ARRAY[NULL]::text[] WHERE "id" = $1'),
      on('UPDATE "app"."QcItem" SET "note" = \' \' WHERE "id" = $1'),
      on('DELETE FROM "app"."QcItem__olines" WHERE "__owner_id" = $1'),
      on('UPDATE "app"."QcItem" SET "__olines_state" = \'null\' WHERE "id" = $1'),
      on('DELETE FROM "app"."QcItem__odim" WHERE "__owner_id" = $1'),
      on('UPDATE "app"."QcItem" SET "__odim_state" = \'missing\' WHERE "id" = $1'),
      on('UPDATE "app"."QcItem__odim" SET "w" = NULL, "__field__w__present" = FALSE WHERE "__owner_id" = $1'),
    ]);
    // Rows of owned objects inside owned objects.
    const nest = '(SELECT "__id" FROM "app"."QcOwnCreateValues__nest" WHERE "__owner_id" = $1)';
    expect(writes('owned:owned create values', [
      { path: 'udim.dims', sql: '\'{"tags":null}\'::jsonb' }, { path: 'nest.meta.code', sql: '\'\'', present: true },
      { path: 'nest.mlines', state: 'null' }, { path: 'nest.meta', state: 'missing' },
    ])).toEqual([
      on('UPDATE "app"."QcOwnCreateValues__udim" SET "dims" = \'{"tags":null}\'::jsonb WHERE "__owner_id" = $1'),
      on(`UPDATE "app"."QcOwnCreateValues__nest__meta" SET "code" = '', "__field__code__present" = TRUE WHERE "__owner_id" = ${nest}`),
      on(`DELETE FROM "app"."QcOwnCreateValues__nest__mlines" WHERE "__owner_id" = ${nest}`),
      on('UPDATE "app"."QcOwnCreateValues__nest" SET "__mlines_state" = \'null\' WHERE "__owner_id" = $1'),
      on(`DELETE FROM "app"."QcOwnCreateValues__nest__meta" WHERE "__owner_id" = ${nest}`),
      on('UPDATE "app"."QcOwnCreateValues__nest" SET "__meta_state" = \'missing\' WHERE "__owner_id" = $1'),
    ]);
    // An owned single object present without a row, which only a write with the root's user triggers disabled stores.
    const triggered = ['QcOwnCreateValues', 'QcOwnCreateValues__nest', 'QcOwnCreateValues__nest__meta', 'QcOwnCreateValues__nest__mlines', 'QcOwnCreateValues__udim', 'QcOwnCreateValues__ulist'];
    const alter = (action, names = triggered) => names.map((name) => ({ text: `ALTER TABLE "app"."${name}" ${action} TRIGGER USER`, values: [] }));
    expect(writes('owned:owned create values', [{ path: 'udim', state: 'present' }], { triggers: false })).toEqual([
      ...alter('DISABLE'),
      on('DELETE FROM "app"."QcOwnCreateValues__udim" WHERE "__owner_id" = $1'),
      on('UPDATE "app"."QcOwnCreateValues" SET "__udim_state" = \'present\' WHERE "id" = $1'),
      ...alter('ENABLE'),
    ]);
    // With refreshTriggers: 'perRoot' the deferred trigger is on the root's guard table, which is disabled too.
    const perRoot = describeDatabase(registrationsOf(fixture), { schema: 'app', refreshTriggers: 'perRoot' });
    const guarded = [triggered[0], 'QcOwnCreateValues__guard', ...triggered.slice(1)];
    expect(postgresEmptinessStatements(perRoot, fixture, 'owned:owned create values', id, [{ path: 'udim', state: 'present' }], { triggers: false })
      .filter(({ text }) => text.startsWith('ALTER'))).toEqual([...alter('DISABLE', guarded), ...alter('ENABLE', guarded)]);
    // Paths it cannot write natively.
    for (const [path, write, message] of [
      ['nope', { sql: 'NULL' }, 'No column nope on QcItem'],
      ['dims.w', { sql: 'NULL' }, 'dims is not an owned single object of item: write the whole column'],
      ['olines.qty', { sql: 'NULL' }, 'olines is an owned list: native writes reach owned rows through owned single objects only'],
      ['odim', { sql: 'NULL' }, 'odim is an owned field of item: write its state'],
      ['dims', { state: 'null' }, 'dims is not an owned field of item'],
      ['olines', { state: 'gone' }, 'Unknown owned state gone'],
      ['note', { sql: 'NULL', present: true }, 'note has no presence column'],
    ]) expect(() => writes('item', [{ path, ...write }]), path).toThrow(message);
    expect(() => writes('nope', [])).toThrow('No root nope');
  });

  it('writes MongoDB documents natively, as given, into the model of each root (pins the existing writer)', async () => {
    const inserted = [];
    const api = { getModel: (type) => ({ collection: { insertMany: async (documents) => { inserted.push([type.name, documents]); } } }) };
    const documents = [{ key: 'raw', meta: { x: 1 }, note: ' ', tags: [null], dims: {}, plain: { a: null, b: null } }, { key: 'blank', meta: {}, tags: [''] }];
    await writeMongoEmptinessDocuments(api, mongoFixture, { item: documents, sid: [] });
    expect(inserted).toEqual([['QdItem', documents]]);
    expect(inserted[0][1][0]).not.toBe(documents[0]);
  });
});

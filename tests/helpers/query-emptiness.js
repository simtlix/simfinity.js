// The fixture, cases and seeding of the emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, part 2a), shared by the
// core, MongoDB, PostgreSQL, parity and MCP tests. Every case is a record written through the generated create
// mutation, or created from a base record and then changed through the generated update mutation, so each backend
// stores what its own mutations store.
//
// Fixture (type names start with the prefix):
// - Item: `note` String, `code` a validated String scalar, `count` Int, `kind` enum, `state` the state machine's enum
//   (set by every create; its values equal their names, since MongoDB stores the name), `ref` ID, `at` DateTime (a
//   scalar named DateTime, so one fixture per schema), `meta` an application scalar without a supported base (MongoDB
//   only; never stored by generated writes), `tags` [String], `dims` { w, label, tags } (a list member), `plain`
//   { a, b } (no list member), `ident` { id: ID, label } (create inputs leave `id` out, update inputs require it),
//   `sident` { id: String, label } (create inputs leave `id` out, update inputs accept it), `outer` { x, inner { y,
//   z } }, `lines` [{ sku, qty }], `ghost` (every member virtual, readOnly), `odim` { w, tags, shop } and `olines`
//   [{ qty, shop }] (owned tables on PostgreSQL, by their reference member), `shop` a reference and `reviews` a
//   collection. jsonb on PostgreSQL for the embedded fields without owned members.
// - Sid: the record identity declared as `id: String`, and `name` String.
// - One owned root per owned case: `udim` { w unique, label, tags, dims { a, tags } } (an owned single object with a
//   native-array member and a jsonb member), `ulist` [{ sku unique, qty }] (an owned list), `nest` { w, meta { code
//   unique }, mlines [{ sku unique }] } (an owned object and an owned list inside an owned object).
// - With `inverse: true`, an inferred inverse reference: Card's plain `ownerId: ID`, which no relation declares and
//   Owner's collection `cards` names as its connectionField. GraphQL exposes it as a scalar ID; describeModels infers
//   a reference to Owner, which PostgreSQL stores as one.
//
// Exports:
// - createEmptinessTypes(prefix = 'Qe', { backend = 'postgres', scopes = {}, inverse = false } = {}) -> types. Fresh
//   GraphQL types for one runtime (relation fields bind their types to it). `backend: 'mongodb'` adds the kinds only
//   MongoDB stores (`meta`). `scopes.item` and `scopes.shop`, when given, are the `extensions.scope` of Item and Shop.
//   `types` holds `backend`, `prefix`, the entity types `Item`, `Shop`, `Review` and `Sid`, `owned` (one root type per
//   owned case, by case name), `State` and `stateMachine` (Item's), `embedded` (every embedded type) and `roots`
//   (below); `inverse: true` adds the entity types `Owner` and `Card`, and the root 'card'.
// - registerEmptinessTypes(api, types): registers the embedded types and connects every entity, Item with its state
//   machine; each endpoint is named after its type with a lower-case first letter.
// - types.roots: `{ [rootKey]: { key, type, single, plural, paths } }`. `single` and `plural` are the endpoint names
//   (`add${single}`, `update${single}`, `${plural}(...)`), `paths` every path an emptiness condition accepts on that
//   root on this backend. `rootKey` is 'item', 'sid', `owned:<case name>` for the owned cases, or 'card' with
//   `inverse: true`.
// - EMPTINESS_CASES: `[{ name, root, input, mutation: 'create' | 'update', base?, expectEmpty: { [path]: boolean } }]`.
//   `root` is 'item', 'sid' or 'owned'; each owned case has a root type of its own, because a nullable unique member
//   accepts one null per collection on both backends, and an empty owned object always has one. `name` is also the
//   record's `key`. An update case creates `base` (by default the root's fully populated record) and then sends
//   `input` to the update mutation. `expectEmpty` names, for every path of the root, whether IS_EMPTY holds for the
//   record; `meta` (MongoDB only) is listed on every item case and is always empty, because generated writes never
//   store it (write a value natively). Paths that 2a rejects (references, collections, leaves through lists, objects
//   with a reference member) are not listed.
// - EMPTINESS_INVERSE_CASES: the cases of the root 'card', in the same shape, which need types made with
//   `inverse: true`: Card records without an owner, with one, and changed from one to the other.
// - EMPTINESS_ID: a placeholder for an identifier value inside case inputs; seeding replaces it with
//   emptinessSampleId(backend), a valid MongoDB ObjectId or PostgreSQL UUID.
// - EMPTINESS_OWNER: a placeholder for an Owner's identifier inside case inputs; seeding replaces it with the id of an
//   Owner record (key 'owner') that it creates through the generated create mutation before the first case that
//   holds the placeholder.
// - seedEmptiness(runtime, types, cases = EMPTINESS_CASES) -> Promise<{ [case name]: { id, key, root } }>. `runtime`
//   is a GraphQLSchema, an object with a `schema`, or a function `(source, variables) => result`. Throws on any
//   GraphQL error.
// - readMongoEmptinessDocuments(api, types) -> Promise<{ [rootKey]: documents }> and
//   writeMongoEmptinessDocuments(api, types, { [rootKey]: documents }): generated mutations need transactions, which a
//   standalone MongoDB server does not have, so seed a replica set, read its stored documents, and insert them
//   natively on the standalone server, into the models of types made with the same cases (any prefix). The writer is
//   also MongoDB's native writer: it inserts the given documents as they are into each root's collection, so it
//   stores what generated writes never store (missing, `null`, `""`, `" "`, `[]`, `[null]`, `[""]`, `{}`, all-null
//   members, a value of `meta`).
// - postgresEmptinessStatements(database, types, rootKey, id, writes, { triggers = true } = {}) -> [{ text, values }]
//   and writePostgresEmptiness(pool, database, types, rootKey, id, writes, options): PostgreSQL's native writer, which
//   runs the statements in one transaction on a pg Pool. `database` is the runtime's describeDatabase(), and `id` the
//   record, bound as $1. Each write is one of:
//   - `{ path, sql, present? }`: sets a column to the SQL expression `sql`. `path` names a root column (a scalar, a
//     native array or a jsonb column, whose members are written as a whole jsonb value) or a column of an owned single
//     object reached through owned single objects (`udim.w`, `nest.meta.code`); `present` also sets its presence
//     column, which jsonb columns and owned columns have (missing is `NULL` with `present: false`, null `NULL` with
//     `present: true`).
//   - `{ path, state }`: sets an owned field's state ('missing', 'null' or 'present') and deletes its rows, so
//     `present` stores an owned list or object without rows.
//   An owned single object present without a row breaks the root's owned check; `triggers: false` disables the user
//   triggers of the root and its owned tables around the writes, in the same transaction, so write it only on a
//   record that nothing writes later. An owned field whose state is not present gives its unique members a null, and
//   a unique member takes one null per collection, so such a write fails when another record of the root already has
//   a null there.
// - rootOf(types, emptinessCase) -> the root descriptor the case is stored on.
// - emptinessArgs(types, rootKey, path, operator, form = 'field') -> list arguments for one emptiness condition:
//   `form: 'field'` writes a field filter (a scalar field) or a term (an object field, without `path` for the field
//   itself), `'condition'` an AND group condition with `field` and an optional `path`.
// - emptinessQuery(types, rootKey, args, selection = 'key') -> { source, variables }: a list query on the root that
//   passes each argument as a variable and sorts by key. emptinessArgumentType(types, rootKey, name) is the GraphQL
//   type of that variable: `[QLFilterGroup]` for AND and OR, `QLTypeFilterExpression` for an object field, otherwise
//   `QLFilter`.
// - expectedEmptinessKeys(rootKey, path, operator, cases = EMPTINESS_CASES) -> the keys, sorted, of the cases on that
//   root that `path operator` returns; an owned root's key is `owned:<case name>`.
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType,
  GraphQLSchema, GraphQLString, getNamedType, graphql, isObjectType,
} from 'graphql';
import { createValidatedScalar } from '../../packages/core/src/index.js';

const embedded = { relation: { embedded: true } };
const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
const unique = { unique: true };
const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);

export const EMPTINESS_ID = '<emptiness-id>';
export const EMPTINESS_OWNER = '<emptiness-owner>';
export const emptinessSampleId = (backend) => (backend === 'mongodb' ? '64b7f0c2a1b2c3d4e5f60718' : '0b5a1d2e-3c4f-4a6b-8c7d-9e0f1a2b3c4d');

const ITEM_PATHS = [
  'id', 'note', 'code', 'count', 'kind', 'state', 'ref', 'at', 'meta', 'tags',
  'dims', 'dims.w', 'dims.label', 'dims.tags', 'plain', 'plain.a', 'plain.b', 'ident', 'ident.id', 'ident.label',
  'sident', 'sident.id', 'sident.label', 'outer', 'outer.x', 'outer.inner', 'outer.inner.y', 'outer.inner.z', 'lines',
  'ghost', 'odim.w', 'odim.tags', 'olines',
];
const SID_PATHS = ['id', 'name'];
const OWNED_PATHS = [
  'id', 'udim', 'udim.w', 'udim.label', 'udim.tags', 'udim.dims', 'udim.dims.a', 'udim.dims.tags', 'ulist',
  'nest', 'nest.w', 'nest.meta', 'nest.meta.code', 'nest.mlines',
];
const CARD_PATHS = ['id', 'ownerId'];
const PATHS = { item: ITEM_PATHS, sid: SID_PATHS, owned: OWNED_PATHS, card: CARD_PATHS };

// The fully populated records that update cases start from.
const ITEM_BASE = {
  note: 'n', code: 'C-1', count: 3, kind: 'ONE', ref: EMPTINESS_ID, at: '2026-01-02T03:04:05.000Z', tags: ['a'],
  dims: { w: 2, label: 'L', tags: ['t'] }, plain: { a: 1, b: 'B' }, ident: { label: 'I' }, sident: { label: 'S' },
  outer: { x: 'X', inner: { y: 1, z: 'Z' } }, lines: [{ sku: 'a', qty: 1 }], odim: { w: 1, tags: ['o'] }, olines: [{ qty: 1 }],
};
const OWNED_BASE = {
  udim: { w: 7, label: 'U', tags: ['u'], dims: { a: 1, tags: ['j'] } }, ulist: [{ sku: 'b', qty: 2 }],
  nest: { w: 1, meta: { code: 'b' }, mlines: [{ sku: 'bm' }] },
};
const BASES = { item: ITEM_BASE, sid: { name: 'S' }, owned: OWNED_BASE, card: { ownerId: EMPTINESS_OWNER } };
const ITEM_NULLS = {
  note: null, code: null, count: null, kind: null, ref: null, at: null, tags: null,
  dims: null, plain: null, ident: null, sident: null, outer: null, lines: null, odim: null, olines: null,
};
// Update inputs require an embedded `id: ID` member, which create inputs leave out, so updates leave `ident` alone.
const ITEM_NULL_MEMBERS = {
  dims: { w: null, label: null, tags: null }, plain: { a: null, b: null }, sident: { label: null },
  outer: { x: null, inner: { y: null, z: null } }, odim: { w: null, tags: null },
};
const OWNED_NULL_MEMBERS = {
  udim: { w: null, label: null, tags: null, dims: null }, nest: { w: null, meta: { code: null }, mlines: null },
};
// Every path of ITEM_BASE that holds a value. Generated creates cannot write an embedded `id` member.
const ITEM_BASE_VALUES = ITEM_PATHS.filter((path) => !['meta', 'ghost', 'ident.id', 'sident.id'].includes(path));
const OWNED_BASE_VALUES = OWNED_PATHS;

// `[name, root, mutation, input, paths that are not empty, base?]`; every other path of the root is empty. An update
// case without a base starts from the root's fully populated record.
const CASES = [
  // Generated creates store an omitted, null or `{}` embedded object whose type has a list member as `{ tags: [] }`,
  // and an owned object as a row with null members: the member rule makes them empty.
  ['item create omitted', 'item', 'create', {}, ['id', 'state']],
  ['item create null', 'item', 'create', ITEM_NULLS, ['id', 'state']],
  ['item create empty values', 'item', 'create', {
    note: '', code: '', tags: [], dims: {}, plain: {}, ident: {}, sident: {}, outer: {}, lines: [], odim: {}, olines: [],
  }, ['id', 'state']],
  ['item create null members', 'item', 'create', { ...ITEM_NULL_MEMBERS, ident: { label: null } }, ['id', 'state']],
  // `" "` and `[""]` are not empty; an object whose only String member is `""` is.
  ['item create blank strings', 'item', 'create', {
    note: ' ', code: ' ', tags: [''], dims: { label: ' ' }, plain: { b: '' }, ident: { label: '' }, outer: { inner: { z: '' } },
  }, ['id', 'state', 'note', 'code', 'tags', 'dims', 'dims.label']],
  ['item create values', 'item', 'create', ITEM_BASE, ITEM_BASE_VALUES],
  // Zero is a value, and `[null]` has an item.
  ['item create zeros and null items', 'item', 'create', {
    count: 0, dims: { w: 0 }, plain: { a: 0 }, outer: { inner: { y: 0 } }, odim: { w: 0 }, tags: [null], lines: [null], olines: [null],
  }, ['id', 'state', 'count', 'dims', 'dims.w', 'plain', 'plain.a', 'outer', 'outer.inner', 'outer.inner.y', 'odim.w', 'tags', 'lines', 'olines']],
  // `[{}]` has an item.
  ['item create list members', 'item', 'create', { dims: { tags: [null] }, lines: [{}], olines: [{}] },
    ['id', 'state', 'dims', 'dims.tags', 'lines', 'olines']],
  // Generated updates remove a nulled field, and store all-null members as written: both are empty.
  ['item update null', 'item', 'update', ITEM_NULLS, ['id', 'state']],
  ['item update null members', 'item', 'update', ITEM_NULL_MEMBERS,
    ['id', 'state', 'note', 'code', 'count', 'kind', 'ref', 'at', 'tags', 'ident', 'ident.label', 'lines', 'olines']],
  // An update merges `{}` into the stored object, which keeps its members.
  ['item update empty values', 'item', 'update', { note: '', code: '', tags: [], lines: [], olines: [], dims: {} },
    ITEM_BASE_VALUES.filter((path) => !['note', 'code', 'tags', 'lines', 'olines'].includes(path))],
  // A nested object in an update replaces the stored one: `inner` loses `z` on both backends.
  ['item update some members', 'item', 'update', { dims: { w: null, label: '' }, plain: { a: null }, outer: { inner: { y: null } } },
    ITEM_BASE_VALUES.filter((path) => !['dims.w', 'dims.label', 'plain.a', 'outer.inner', 'outer.inner.y', 'outer.inner.z'].includes(path))],
  // `{ id: X }` in a type with an `id` member is not empty; only update inputs can write the member. An `id` member
  // declared String keeps the String rule: `""` is empty and `" "` is not.
  ['item update embedded id', 'item', 'update', { ident: { id: EMPTINESS_ID }, sident: { id: '' } },
    ['id', 'state', 'ident', 'ident.id'], {}],
  ['item update embedded String id', 'item', 'update', { sident: { id: ' ' } }, ['id', 'state', 'sident', 'sident.id'], {}],
  // The record identity is never empty, also when it is declared String.
  ['sid create empty name', 'sid', 'create', { name: '' }, ['id']],
  ['sid create name', 'sid', 'create', { name: 'S' }, ['id', 'name']],
  ['owned create omitted', 'owned', 'create', {}, ['id']],
  ['owned create null', 'owned', 'create', { udim: null, ulist: null, nest: null }, ['id']],
  ['owned create empty values', 'owned', 'create', { udim: {}, ulist: [], nest: { meta: {}, mlines: [] } }, ['id']],
  ['owned create null members', 'owned', 'create', OWNED_NULL_MEMBERS, ['id']],
  // An owned object whose only value is in an owned object inside it is not empty.
  ['owned create inner value only', 'owned', 'create', { nest: { meta: { code: 'c' } } }, ['id', 'nest', 'nest.meta', 'nest.meta.code']],
  ['owned create values', 'owned', 'create', {
    udim: { w: 1, label: ' ', tags: [''], dims: { a: 0 } }, ulist: [null], nest: { w: 0, mlines: [{ sku: 'm' }] },
  }, ['id', 'udim', 'udim.w', 'udim.label', 'udim.tags', 'udim.dims', 'udim.dims.a', 'ulist', 'nest', 'nest.w', 'nest.mlines']],
  ['owned create empty strings', 'owned', 'create', { udim: { label: '', dims: { tags: [] } }, ulist: [{ sku: 's' }] }, ['id', 'ulist']],
  ['owned update null', 'owned', 'update', { udim: null, ulist: null, nest: null }, ['id']],
  ['owned update null members', 'owned', 'update', { ...OWNED_NULL_MEMBERS, ulist: [], nest: { w: null, meta: { code: null }, mlines: [] } }, ['id']],
  ['owned update inner null', 'owned', 'update', { nest: { meta: null } },
    OWNED_BASE_VALUES.filter((path) => !['nest.meta', 'nest.meta.code'].includes(path))],
];

// An inferred inverse reference takes the null rule of the scalar ID that GraphQL exposes: an omitted or null owner,
// and one that a generated update nulls, are empty.
const INVERSE_CASES = [
  ['card create omitted', 'card', 'create', {}, ['id']],
  ['card create null', 'card', 'create', { ownerId: null }, ['id']],
  ['card create owner', 'card', 'create', { ownerId: EMPTINESS_OWNER }, ['id', 'ownerId']],
  ['card update null', 'card', 'update', { ownerId: null }, ['id']],
  ['card update owner', 'card', 'update', { ownerId: EMPTINESS_OWNER }, ['id', 'ownerId'], {}],
];

const freezeCases = (cases) => Object.freeze(cases.map(([name, root, mutation, input, notEmpty, base = BASES[root]]) => {
  const unknown = notEmpty.filter((path) => !PATHS[root].includes(path));
  if (unknown.length) throw new Error(`Emptiness case ${name} names unknown paths: ${unknown.join(', ')}`);
  return Object.freeze({
    name,
    root,
    mutation,
    input,
    ...(mutation === 'update' ? { base } : {}),
    expectEmpty: Object.freeze(Object.fromEntries(PATHS[root].map((path) => [path, !notEmpty.includes(path)]))),
  });
}));
export const EMPTINESS_CASES = freezeCases(CASES);
export const EMPTINESS_INVERSE_CASES = freezeCases(INVERSE_CASES);

const OWNED_CASE_NAMES = EMPTINESS_CASES.filter((item) => item.root === 'owned').map((item) => item.name);
const pascal = (name) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');

export const createEmptinessTypes = (prefix = 'Qe', { backend = 'postgres', scopes = {}, inverse = false } = {}) => {
  const mongodb = backend === 'mongodb';
  const scoped = (name) => (scopes[name] ? { extensions: { scope: scopes[name] } } : {});
  const DateTime = new GraphQLScalarType({
    name: 'DateTime',
    serialize: (value) => new Date(value).toISOString(),
    parseValue: (value) => new Date(value),
    parseLiteral: (node) => new Date(node.value),
  });
  const Code = createValidatedScalar(`${prefix}Code`, 'A validated String', GraphQLString, () => {});
  // An application scalar with no supported base, which only MongoDB's default mode stores (as nothing).
  const Json = new GraphQLScalarType({ name: `${prefix}Json`, serialize: (value) => value, parseValue: (value) => value });
  const Kind = new GraphQLEnumType({ name: `${prefix}Kind`, values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
  // State values equal their names, since MongoDB stores the name (docs/guide/state-machines.md).
  const State = new GraphQLEnumType({ name: `${prefix}State`, values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });

  const Dims = new GraphQLObjectType({ name: `${prefix}Dims`, fields: { w: { type: GraphQLInt }, label: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) } } });
  const Plain = new GraphQLObjectType({ name: `${prefix}Plain`, fields: { a: { type: GraphQLInt }, b: { type: GraphQLString } } });
  const Ident = new GraphQLObjectType({ name: `${prefix}Ident`, fields: { id: { type: GraphQLID }, label: { type: GraphQLString } } });
  const SIdent = new GraphQLObjectType({ name: `${prefix}SIdent`, fields: { id: { type: GraphQLString }, label: { type: GraphQLString } } });
  const Inner = new GraphQLObjectType({ name: `${prefix}Inner`, fields: { y: { type: GraphQLInt }, z: { type: GraphQLString } } });
  const Outer = new GraphQLObjectType({ name: `${prefix}Outer`, fields: { x: { type: GraphQLString }, inner: { type: Inner, extensions: embedded } } });
  const Line = new GraphQLObjectType({ name: `${prefix}Line`, fields: { sku: { type: GraphQLString }, qty: { type: GraphQLInt } } });
  // Every member is virtual, so nothing is stored and the object is always empty.
  const Ghost = new GraphQLObjectType({
    name: `${prefix}Ghost`,
    fields: { label: { type: GraphQLString, resolve: () => 'ghost', extensions: { virtual: true } } },
  });
  const Shop = new GraphQLObjectType({
    name: `${prefix}Shop`,
    ...scoped('shop'),
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString },
      items: { type: new GraphQLList(Item), extensions: reference('shop') },
    }),
  });
  // A reference member makes these owned tables on PostgreSQL.
  const ODim = new GraphQLObjectType({
    name: `${prefix}ODim`,
    fields: () => ({ w: { type: GraphQLInt }, tags: { type: new GraphQLList(GraphQLString) }, shop: { type: Shop, extensions: reference() } }),
  });
  const OLine = new GraphQLObjectType({
    name: `${prefix}OLine`,
    fields: () => ({ qty: { type: GraphQLInt }, shop: { type: Shop, extensions: reference() } }),
  });
  const Review = new GraphQLObjectType({
    name: `${prefix}Review`,
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, text: { type: GraphQLString },
      item: { type: Item, extensions: reference('item') },
    }),
  });
  const Item = new GraphQLObjectType({
    name: `${prefix}Item`,
    ...scoped('item'),
    fields: () => ({
      id: { type: GraphQLID },
      key: { type: new GraphQLNonNull(GraphQLString) },
      note: { type: GraphQLString },
      code: { type: Code },
      count: { type: GraphQLInt },
      kind: { type: Kind },
      state: { type: State },
      ref: { type: GraphQLID },
      at: { type: DateTime },
      ...(mongodb ? { meta: { type: Json } } : {}),
      tags: { type: new GraphQLList(GraphQLString) },
      dims: { type: Dims, extensions: embedded },
      plain: { type: Plain, extensions: embedded },
      ident: { type: Ident, extensions: embedded },
      sident: { type: SIdent, extensions: embedded },
      outer: { type: Outer, extensions: embedded },
      lines: { type: new GraphQLList(Line), extensions: embedded },
      ghost: { type: Ghost, extensions: { ...embedded, readOnly: true } },
      odim: { type: ODim, extensions: embedded },
      olines: { type: new GraphQLList(OLine), extensions: embedded },
      shop: { type: Shop, extensions: reference('shop') },
      reviews: { type: new GraphQLList(Review), extensions: reference('item') },
    }),
  });
  // The record identity declared as a String.
  const Sid = new GraphQLObjectType({
    name: `${prefix}Sid`,
    fields: { id: { type: GraphQLString }, key: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString } },
  });
  // Unique members make owned tables on PostgreSQL without any reference: an owned single object with a scalar-list
  // member and a jsonb member, an owned list, and an owned object and an owned list inside an owned object.
  const UJson = new GraphQLObjectType({ name: `${prefix}UJson`, fields: { a: { type: GraphQLInt }, tags: { type: new GraphQLList(GraphQLString) } } });
  const UDim = new GraphQLObjectType({
    name: `${prefix}UDim`,
    fields: {
      w: { type: GraphQLInt, extensions: unique }, label: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) },
      dims: { type: UJson, extensions: embedded },
    },
  });
  const ULine = new GraphQLObjectType({ name: `${prefix}ULine`, fields: { sku: { type: GraphQLString, extensions: unique }, qty: { type: GraphQLInt } } });
  const Meta = new GraphQLObjectType({ name: `${prefix}Meta`, fields: { code: { type: GraphQLString, extensions: unique } } });
  const MLine = new GraphQLObjectType({ name: `${prefix}MLine`, fields: { sku: { type: GraphQLString, extensions: unique } } });
  const Nest = new GraphQLObjectType({
    name: `${prefix}Nest`,
    fields: { w: { type: GraphQLInt }, meta: { type: Meta, extensions: embedded }, mlines: { type: new GraphQLList(MLine), extensions: embedded } },
  });
  const owned = Object.fromEntries(OWNED_CASE_NAMES.map((name) => [name, new GraphQLObjectType({
    name: `${prefix}Own${pascal(name.replace(/^owned /, ''))}`,
    fields: {
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) },
      udim: { type: UDim, extensions: embedded }, ulist: { type: new GraphQLList(ULine), extensions: embedded },
      nest: { type: Nest, extensions: embedded },
    },
  })]));
  // An inferred inverse reference: Owner.cards names Card's plain `ownerId: ID`, which no relation declares, as its
  // connectionField.
  const Card = inverse ? new GraphQLObjectType({
    name: `${prefix}Card`,
    fields: { id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, ownerId: { type: GraphQLID } },
  }) : null;
  const Owner = inverse ? new GraphQLObjectType({
    name: `${prefix}Owner`,
    fields: {
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) },
      cards: { type: new GraphQLList(Card), extensions: reference('ownerId') },
    },
  }) : null;

  const describe = (key, type, paths) => ({
    key, type, single: lowerFirst(type.name), plural: `${lowerFirst(type.name)}s`, paths: Object.freeze(paths),
  });
  const roots = {
    item: describe('item', Item, ITEM_PATHS.filter((path) => mongodb || path !== 'meta')),
    sid: describe('sid', Sid, SID_PATHS),
    ...(inverse ? { card: describe('card', Card, CARD_PATHS) } : {}),
    ...Object.fromEntries(Object.entries(owned).map(([name, type]) => [`owned:${name}`, describe(`owned:${name}`, type, OWNED_PATHS)])),
  };
  return {
    backend,
    prefix,
    Item,
    Shop,
    Review,
    Sid,
    ...(inverse ? { Owner, Card } : {}),
    owned,
    State,
    stateMachine: { initialState: State.getValue('OPEN'), actions: { close: { from: State.getValue('OPEN'), to: State.getValue('CLOSED') } } },
    embedded: [Dims, Plain, Ident, SIdent, Inner, Outer, Line, Ghost, ODim, OLine, UJson, UDim, ULine, Meta, MLine, Nest],
    roots,
  };
};

export const registerEmptinessTypes = (api, types) => {
  for (const type of types.embedded) api.addNoEndpointType(type);
  const connect = (type, stateMachine) => {
    const name = lowerFirst(type.name);
    api.connect(null, type, name, `${name}s`, null, null, stateMachine);
  };
  connect(types.Shop);
  connect(types.Item, types.stateMachine);
  connect(types.Review);
  connect(types.Sid);
  if (types.Owner) {
    connect(types.Owner);
    connect(types.Card);
  }
  for (const type of Object.values(types.owned)) connect(type);
};

export const rootOf = (types, emptinessCase) => {
  const key = emptinessCase.root === 'owned' ? `owned:${emptinessCase.name}` : emptinessCase.root;
  const root = types.roots[key];
  if (!root) throw new Error(`No root ${key} for the emptiness case ${emptinessCase.name}`);
  return root;
};

// `value` with each placeholder that `ids` names replaced by its identifier.
const withIds = (value, ids) => {
  if (typeof value === 'string' && Object.hasOwn(ids, value)) return ids[value];
  if (Array.isArray(value)) return value.map((item) => withIds(item, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withIds(item, ids)]));
  return value;
};
const holds = (value, placeholder) => value === placeholder
  || (!!value && typeof value === 'object' && Object.values(value).some((item) => holds(item, placeholder)));

const executorOf = (runtime) => {
  if (typeof runtime === 'function') return runtime;
  const schema = runtime instanceof GraphQLSchema ? runtime : runtime?.schema;
  if (!(schema instanceof GraphQLSchema)) throw new Error('seedEmptiness needs a GraphQLSchema, an object with a schema, or an execute function');
  return (source, variableValues) => graphql({ schema, source, variableValues, contextValue: {} });
};

export const seedEmptiness = async (runtime, types, cases = EMPTINESS_CASES) => {
  const execute = executorOf(runtime);
  const run = async (source, input) => {
    const result = await execute(source, { input });
    if (result.errors) throw new Error(`${source} ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`);
    return Object.values(result.data)[0];
  };
  const ids = { [EMPTINESS_ID]: emptinessSampleId(types.backend) };
  const seeded = {};
  for (const item of cases) {
    const root = rootOf(types, item);
    if (!Object.hasOwn(ids, EMPTINESS_OWNER) && holds([item.input, item.base], EMPTINESS_OWNER)) {
      if (!types.Owner) throw new Error(`The emptiness case ${item.name} needs an Owner: make the types with inverse: true`);
      const owner = types.Owner.name;
      ids[EMPTINESS_OWNER] = (await run(`mutation($input:${owner}Input!){add${lowerFirst(owner)}(input:$input){id}}`, { key: 'owner' })).id;
    }
    const create = withIds(item.mutation === 'update' ? item.base : item.input, ids);
    const record = await run(`mutation($input:${root.type.name}Input!){add${root.single}(input:$input){id key}}`, { ...create, key: item.name });
    if (item.mutation === 'update') {
      await run(`mutation($input:${root.type.name}InputForUpdate!){update${root.single}(input:$input){id}}`, { ...withIds(item.input, ids), id: record.id });
    }
    seeded[item.name] = { id: record.id, key: item.name, root: root.key };
  }
  return seeded;
};

export const readMongoEmptinessDocuments = async (api, types) => {
  const documents = {};
  for (const [key, root] of Object.entries(types.roots)) documents[key] = await api.getModel(root.type).collection.find({}).toArray();
  return documents;
};

export const writeMongoEmptinessDocuments = async (api, types, documents) => {
  for (const [key, list] of Object.entries(documents)) {
    if (list.length) await api.getModel(types.roots[key].type).collection.insertMany(list.map((document) => ({ ...document })));
  }
};

const OWNED_STATES = ['missing', 'null', 'present'];
const quoteName = (name) => `"${String(name).replaceAll('"', '""')}"`;

export const postgresEmptinessStatements = (database, types, rootKey, id, writes, { triggers = true } = {}) => {
  const root = types.roots[rootKey];
  if (!root) throw new Error(`No root ${rootKey}`);
  const byName = new Map(database.tables.map((table) => [table.name, table]));
  const rootTable = byName.get(root.type.name);
  if (!rootTable || rootTable.ownership) throw new Error(`No root table ${root.type.name}`);
  const ownerOf = (table) => {
    let owner = table;
    while (owner?.ownership) owner = byName.get(owner.ownership.ownerTable);
    return owner;
  };
  // The root's owned tables by their dotted path from the root.
  const owned = new Map(database.tables.filter((table) => table.ownership && ownerOf(table) === rootTable)
    .map((table) => [table.ownership.path.join('.'), table]));
  const relation = (table) => `${quoteName(database.schema)}.${quoteName(table.name)}`;
  // The table that stores the members of `segments` ([] for the root), reached through owned single objects only.
  const tableAt = (segments) => {
    if (!segments.length) return rootTable;
    const path = segments.join('.');
    const table = owned.get(path);
    if (!table) throw new Error(`${path} is not an owned single object of ${rootKey}: write the whole column`);
    if (table.ownership.list) throw new Error(`${path} is an owned list: native writes reach owned rows through owned single objects only`);
    tableAt(segments.slice(0, -1));
    return table;
  };
  // The key that the rows stored at `segments` point to: the record's id, or the `__id` of an owned row.
  const keyOf = (segments) => (segments.length
    ? `(SELECT "__id" FROM ${relation(tableAt(segments))} WHERE "__owner_id" = ${keyOf(segments.slice(0, -1))})`
    : '$1');
  const rowOf = (segments) => (segments.length ? `"__owner_id" = ${keyOf(segments.slice(0, -1))}` : '"id" = $1');
  const statements = [];
  const run = (text) => statements.push({ text, values: [id] });
  for (const { path, sql, present, state } of writes) {
    const segments = path.split('.');
    const parent = segments.slice(0, -1);
    const name = segments.at(-1);
    const table = tableAt(parent);
    if (state !== undefined) {
      const ownedTable = owned.get(path);
      if (!ownedTable) throw new Error(`${path} is not an owned field of ${rootKey}`);
      if (!OWNED_STATES.includes(state)) throw new Error(`Unknown owned state ${state}`);
      run(`DELETE FROM ${relation(ownedTable)} WHERE "__owner_id" = ${keyOf(parent)}`);
      run(`UPDATE ${relation(table)} SET ${quoteName(ownedTable.ownership.stateColumn)} = '${state}' WHERE ${rowOf(parent)}`);
      continue;
    }
    if (owned.has(path)) throw new Error(`${path} is an owned field of ${rootKey}: write its state`);
    const column = table.columns.find((item) => item.name === name);
    if (!column) throw new Error(`No column ${name} on ${table.name}`);
    const sets = [`${quoteName(column.name)} = ${sql}`];
    if (present !== undefined) {
      if (!column.presenceColumn) throw new Error(`${path} has no presence column`);
      sets.push(`${quoteName(column.presenceColumn)} = ${present ? 'TRUE' : 'FALSE'}`);
    }
    run(`UPDATE ${relation(table)} SET ${sets.join(', ')} WHERE ${rowOf(parent)}`);
  }
  if (triggers) return statements;
  // The root, its owned tables and its guard table, which holds the deferred trigger with refreshTriggers: 'perRoot'.
  const guard = database.maintenance?.find((item) => item.rootTable === rootTable.name)?.guardTable;
  const family = new Set([rootTable.name, ...[...owned.values()].map((table) => table.name), ...(guard ? [guard] : [])]);
  const triggered = database.tables.filter((table) => family.has(table.name) && database.triggers.some((trigger) => trigger.table === table.name));
  const alter = (action) => triggered.map((table) => ({ text: `ALTER TABLE ${relation(table)} ${action} TRIGGER USER`, values: [] }));
  return [...alter('DISABLE'), ...statements, ...alter('ENABLE')];
};

export const writePostgresEmptiness = async (pool, database, types, rootKey, id, writes, options) => {
  const statements = postgresEmptinessStatements(database, types, rootKey, id, writes, options);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { text, values } of statements) await client.query(text, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const emptinessArgs = (types, rootKey, path, operator, form = 'field') => {
  const [head, ...rest] = path.split('.');
  const field = types.roots[rootKey].type.getFields()[head];
  if (!field) throw new Error(`Unknown field ${head} on ${rootKey}`);
  const tail = rest.join('.');
  if (form === 'condition') return { AND: [{ conditions: [{ field: head, ...(tail ? { path: tail } : {}), operator }] }] };
  if (isObjectType(getNamedType(field.type))) return { [head]: { terms: [{ ...(tail ? { path: tail } : {}), operator }] } };
  return { [head]: { operator } };
};

export const emptinessArgumentType = (types, rootKey, name) => {
  if (['AND', 'OR'].includes(name)) return '[QLFilterGroup]';
  const field = types.roots[rootKey].type.getFields()[name];
  return field && isObjectType(getNamedType(field.type)) ? 'QLTypeFilterExpression' : 'QLFilter';
};

export const emptinessQuery = (types, rootKey, args, selection = 'key') => {
  const { plural } = types.roots[rootKey];
  const names = Object.keys(args);
  const declared = names.map((name) => `$${name}:${emptinessArgumentType(types, rootKey, name)}`).join(',');
  const passed = [...names.map((name) => `${name}:$${name}`), 'sort:{terms:[{field:"key",order:ASC}]}'].join(',');
  return { source: `query${declared ? `(${declared})` : ''}{${plural}(${passed}){${selection}}}`, variables: args };
};

export const expectedEmptinessKeys = (rootKey, path, operator, cases = EMPTINESS_CASES) => {
  const empty = operator === 'IS_EMPTY';
  return cases
    .filter((item) => (item.root === 'owned' ? `owned:${item.name}` : item.root) === rootKey)
    .filter((item) => Object.hasOwn(item.expectEmpty, path) && item.expectEmpty[path] === empty)
    .map((item) => item.name)
    .sort();
};

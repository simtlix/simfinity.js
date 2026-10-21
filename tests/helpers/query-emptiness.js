// The fixture, cases and seeding of the emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, part 2a), shared by the
// core, MongoDB, PostgreSQL, parity and MCP tests. Every case is a record written through the generated create
// mutation, or created from a base record and then changed through the generated update mutation, so each backend
// stores what its own mutations store. The fixture of reference and collection emptiness (#108, part 2b) is a separate
// one, described before its code at the end of this file.
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

// Reference and collection emptiness (#108, part 2b): the second fixture of the issue (6.5), extended with Pro, `odim`
// and a collection whose connectionField names a child reference stored under another name. Its records are written
// through generated create mutations, apart from MongoDB's dangling reference, which is written natively.
//
// Fixture (type names start with the prefix):
// - Shop { id: String, key, name, state: String, minStock, products: [Product] } (a collection whose connectionField
//   is Product.shop). Its identity is declared String, so `shop.id`, `pro.shop.id` and `odim.shop.id` test the record
//   identity after a reference, which PostgreSQL stores as a uuid.
// - Pro { key, name, shop: Shop }.
// - Product { key, name, stock, shop: Shop, pro: Pro, odim { w, shop: Shop }, olines [{ qty, shop: Shop }], reviews:
//   [Review] }. `odim` and `olines` are owned tables on PostgreSQL, by their reference member. `reviews` declares the
//   connectionField `product`, the GraphQL name of Review.product, which stores itself as `productId`, so the
//   collection's storage column is `productId`.
// - Review { key, rating, author, product: Product (connectionField `productId`) }.
// Every entity has a NonNull `key`, unique among all records, which the rows name; `name` repeats it where it exists.
//
// Data (REFERENCE_DATA), by type key, references by key:
// - Shops S1 (OPEN, minStock 4), S2 (CLOSED, 50) and S3 (no state, 1).
// - Pros P1 -> S1, P2 -> S1, P3 -> S2, and P4 without a shop.
// - Products Ka (stock 5, shop S1, pro P1, odim { w: 1 }, olines (1, S1) and (9, no shop)), c (5, S2, P2, odim { shop:
//   S1 }, (1, S2)), C (5, no shop, P3, odim { shop: S2 }, (1, no shop)), D (0, S3, P4, odim { shop: S3 }, no olines)
//   and E (3, S1, no pro, no odim, (2, S3)).
// - Reviews Ka:5:x, c:1:hidden, D:1:x, D:5:hidden, E:5:x and E:1:hidden (`<product>:<rating>:<author>`).
// - On MongoDB only, the dangling product Dg (REFERENCE_DANGLING_KEY): stock 1, and `shop`, `pro`, `odim.shop` and
//   `olines[0].shop` pointing to an ObjectId no record has. PostgreSQL's foreign keys keep references from dangling.
//
// Scopes, driven by the request context's `shape` (REFERENCE_SHAPES; omitted reads as 'admin'). Each one appends one
// AND group with one condition to the arguments of the type's find and aggregate scopes; get_by_id scopes add nothing,
// so reference fields still read records that the find scopes hide.
// - 'admin': none.
// - 'NE' (null-accepting): Shop `name NE "S2"`, Review `author NE "hidden"`, Pro `name NE "P2"`.
// - 'EQ' (null-rejecting): Shop `state EQ "OPEN"`, Review `author EQ "x"`, Pro `name EQ "P1"`.
// - 'proOnly': Pro `name NE "P2"`, with Shop and Review unscoped.
// - 'shopNE' and 'shopEQ': the Shop condition of 'NE' or 'EQ' alone, with Pro, Product and Review unscoped. They give
//   the probe's two-hop rows (map-probe.md section 1), which read Review.product.shop with the Review root unscoped, and
//   chains whose unscoped first hop is followed by a scoped one (Review.product.shop, Product.pro.shop).
//
// Exports:
// - REFERENCE_SHAPES, REFERENCE_SCOPES ({ [shape]: { [type key]: condition } }), REFERENCE_DATA and
//   REFERENCE_DANGLING_KEY, as above.
// - createReferenceEmptinessTypes(prefix = 'Qr', { backend = 'postgres', scopes = {} } = {}) -> types. Fresh GraphQL
//   types for one runtime. Every entity has an `extensions.scope` with find, aggregate and get_by_id functions that
//   apply the shape and then call `scopes[typeKey][operation](params)`, when given, with the runtime's scope
//   parameters `{ type, args, operation, context }`; type keys are 'shop', 'pro', 'product' and 'review'. `types`
//   holds `backend`, `prefix`, `Shop`, `Pro`, `Product`, `Review`, `embedded` ([ODim, OLine]) and `roots`, which 2a's
//   readMongoEmptinessDocuments, writeMongoEmptinessDocuments, emptinessArgs and emptinessQuery also read:
//   `{ [type key]: { key, type, single, plural, paths } }`, with `paths` the case paths of that root.
// - registerReferenceEmptinessTypes(api, types): registers the embedded types and connects every entity; each
//   endpoint is named after its type with a lower-case first letter (`qrProduct`, `qrProducts`).
// - seedReferenceEmptiness(runtime, types) -> Promise<{ [key]: id }>: creates every record of REFERENCE_DATA through
//   generated create mutations (shops, pros, products, reviews) and returns each record's id by key. `runtime` is what
//   seedEmptiness takes.
// - writeMongoDanglingReference(api, types, { id } = {}) -> Promise<document>: inserts the dangling product natively
//   with writeMongoEmptinessDocuments; `id` is the ObjectId it points to, a new one by default.
// - REFERENCE_CASES: `[{ name, root, path?, operator?, args?, scopeArgs?, rows, trusted?, dangling }]`, the expected
//   rows of each case for each shape, as sorted keys of the root's records.
//   - A case with `path` and `operator` is one client construct (a term or a group condition; referenceCaseArgs
//     writes either), and `trusted` gives its rows when the same construct comes from trusted code (stored semantics:
//     middleware, the root's own scope), which the root's own find scope still restricts.
//   - A case with `args` holds client arguments as a whole, with each identifier written as `<id:KEY>`, and
//     `scopeArgs`, when present, are trusted arguments that the root's own find scope appends to the query.
//   - `dangling` lists the shapes in which MongoDB's dangling product also matches.
//   Cases are frozen: referenceCaseArgs returns fresh arguments, and `scopeArgs` should be copied (structuredClone)
//   before a scope appends them.
//   Paths: on Product shop, shop.id, shop.name, shop.state, shop.products, reviews, pro, pro.name, pro.shop,
//   pro.shop.id, pro.shop.state, odim, odim.w, odim.shop, odim.shop.id and odim.shop.state; on Review product (a
//   reference stored as productId), product.shop and product.shop.state; on Shop products; each with IS_EMPTY and
//   IS_NOT_EMPTY. The compound cases are gap 5, a legacy
//   branch beside a marked construct in an OR and in the same group, a sort beside a marked construct, and Pro chains
//   beside a trusted condition on the same path and beside a legacy condition in an earlier OR branch.
// - referenceCaseArgs(item, ids = {}, form = 'field') -> client arguments: for a construct case, a term
//   (`form: 'field'`) or an AND group condition (`'condition'`); for an `args` case, its arguments with the
//   identifiers of `ids` (seedReferenceEmptiness's result) in place.
// - expectedReferenceRows(item, shape, { trusted = false, dangling = false } = {}) -> sorted keys; `dangling` adds the
//   dangling product where it matches (MongoDB).
// - referenceQuery(types, rootKey, args, selection = 'key') -> { source, variables }: a list query on the root that
//   passes each argument as a variable, `sort` and `pagination` included, sorted by key unless `args.sort` is given.
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

export const REFERENCE_SHAPES = Object.freeze(['admin', 'NE', 'EQ', 'proOnly', 'shopNE', 'shopEQ']);
export const REFERENCE_SCOPES = deepFreeze({
  admin: {},
  NE: {
    shop: { field: 'name', operator: 'NE', value: 'S2' },
    review: { field: 'author', operator: 'NE', value: 'hidden' },
    pro: { field: 'name', operator: 'NE', value: 'P2' },
  },
  EQ: {
    shop: { field: 'state', operator: 'EQ', value: 'OPEN' },
    review: { field: 'author', operator: 'EQ', value: 'x' },
    pro: { field: 'name', operator: 'EQ', value: 'P1' },
  },
  proOnly: { pro: { field: 'name', operator: 'NE', value: 'P2' } },
  shopNE: { shop: { field: 'name', operator: 'NE', value: 'S2' } },
  shopEQ: { shop: { field: 'state', operator: 'EQ', value: 'OPEN' } },
});

export const REFERENCE_DATA = deepFreeze({
  shop: [
    { key: 'S1', name: 'S1', state: 'OPEN', minStock: 4 },
    { key: 'S2', name: 'S2', state: 'CLOSED', minStock: 50 },
    { key: 'S3', name: 'S3', minStock: 1 },
  ],
  pro: [
    { key: 'P1', name: 'P1', shop: 'S1' }, { key: 'P2', name: 'P2', shop: 'S1' }, { key: 'P3', name: 'P3', shop: 'S2' },
    { key: 'P4', name: 'P4' },
  ],
  product: [
    { key: 'Ka', name: 'Ka', stock: 5, shop: 'S1', pro: 'P1', odim: { w: 1 }, olines: [{ qty: 1, shop: 'S1' }, { qty: 9 }] },
    { key: 'c', name: 'c', stock: 5, shop: 'S2', pro: 'P2', odim: { shop: 'S1' }, olines: [{ qty: 1, shop: 'S2' }] },
    { key: 'C', name: 'C', stock: 5, pro: 'P3', odim: { shop: 'S2' }, olines: [{ qty: 1 }] },
    { key: 'D', name: 'D', stock: 0, shop: 'S3', pro: 'P4', odim: { shop: 'S3' } },
    { key: 'E', name: 'E', stock: 3, shop: 'S1', olines: [{ qty: 2, shop: 'S3' }] },
  ],
  review: [
    { key: 'Ka:5:x', rating: 5, author: 'x', product: 'Ka' }, { key: 'c:1:hidden', rating: 1, author: 'hidden', product: 'c' },
    { key: 'D:1:x', rating: 1, author: 'x', product: 'D' }, { key: 'D:5:hidden', rating: 5, author: 'hidden', product: 'D' },
    { key: 'E:5:x', rating: 5, author: 'x', product: 'E' }, { key: 'E:1:hidden', rating: 1, author: 'hidden', product: 'E' },
  ],
});
export const REFERENCE_DANGLING_KEY = 'Dg';

const REFERENCE_TYPE_KEYS = ['shop', 'pro', 'product', 'review'];
const SCOPE_OPERATIONS = ['find', 'aggregate', 'get_by_id'];

// Appends the shape's condition for the type, as one AND group, to the scope's arguments.
const restrictToShape = (typeKey, args, shape = 'admin') => {
  const restrictions = REFERENCE_SCOPES[shape];
  if (!restrictions) throw new Error(`Unknown reference emptiness shape ${shape}`);
  const condition = restrictions[typeKey];
  if (condition) args.AND = [...(Array.isArray(args.AND) ? args.AND : []), { conditions: [{ ...condition }] }];
};
const referenceScope = (typeKey, extra = {}) => Object.fromEntries(SCOPE_OPERATIONS.map((operation) => [operation, (params) => {
  if (operation !== 'get_by_id') restrictToShape(typeKey, params.args, params.context?.shape ?? 'admin');
  extra[operation]?.(params);
}]));

// Every (root, path) pair of the construct cases below, so that `roots[...].paths` lists them.
const CASE_PATHS = {
  product: [
    'shop', 'shop.id', 'shop.name', 'shop.state', 'shop.products', 'reviews', 'pro', 'pro.name', 'pro.shop', 'pro.shop.id',
    'pro.shop.state', 'odim', 'odim.w', 'odim.shop', 'odim.shop.id', 'odim.shop.state',
  ],
  review: ['product', 'product.shop', 'product.shop.state'],
  shop: ['products'],
  pro: [],
};

export const createReferenceEmptinessTypes = (prefix = 'Qr', { backend = 'postgres', scopes = {} } = {}) => {
  const unknown = Object.keys(scopes).filter((key) => !REFERENCE_TYPE_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown reference emptiness type keys: ${unknown.join(', ')}`);
  const scoped = (typeKey) => ({ extensions: { scope: referenceScope(typeKey, scopes[typeKey]) } });
  const Shop = new GraphQLObjectType({
    name: `${prefix}Shop`,
    ...scoped('shop'),
    fields: () => ({
      id: { type: GraphQLString },
      key: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      state: { type: GraphQLString },
      minStock: { type: GraphQLInt },
      products: { type: new GraphQLList(Product), extensions: reference('shop') },
    }),
  });
  const Pro = new GraphQLObjectType({
    name: `${prefix}Pro`,
    ...scoped('pro'),
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString },
      shop: { type: Shop, extensions: reference('shop') },
    }),
  });
  // A reference member makes these owned tables on PostgreSQL.
  const ODim = new GraphQLObjectType({
    name: `${prefix}ODim`,
    fields: () => ({ w: { type: GraphQLInt }, shop: { type: Shop, extensions: reference() } }),
  });
  const OLine = new GraphQLObjectType({
    name: `${prefix}OLine`,
    fields: () => ({ qty: { type: GraphQLInt }, shop: { type: Shop, extensions: reference() } }),
  });
  const Review = new GraphQLObjectType({
    name: `${prefix}Review`,
    ...scoped('review'),
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, rating: { type: GraphQLInt },
      author: { type: GraphQLString },
      // Stored as productId: Product.reviews names this field, and reads the storage column.
      product: { type: Product, extensions: reference('productId') },
    }),
  });
  const Product = new GraphQLObjectType({
    name: `${prefix}Product`,
    ...scoped('product'),
    fields: () => ({
      id: { type: GraphQLID },
      key: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      stock: { type: GraphQLInt },
      shop: { type: Shop, extensions: reference('shop') },
      pro: { type: Pro, extensions: reference() },
      odim: { type: ODim, extensions: embedded },
      olines: { type: new GraphQLList(OLine), extensions: embedded },
      reviews: { type: new GraphQLList(Review), extensions: reference('product') },
    }),
  });
  const describe = (key, type) => ({
    key, type, single: lowerFirst(type.name), plural: `${lowerFirst(type.name)}s`, paths: Object.freeze([...CASE_PATHS[key]]),
  });
  return {
    backend,
    prefix,
    Shop,
    Pro,
    Product,
    Review,
    embedded: [ODim, OLine],
    roots: {
      shop: describe('shop', Shop), pro: describe('pro', Pro), product: describe('product', Product), review: describe('review', Review),
    },
  };
};

export const registerReferenceEmptinessTypes = (api, types) => {
  for (const type of types.embedded) api.addNoEndpointType(type);
  for (const type of [types.Shop, types.Pro, types.Product, types.Review]) {
    const name = lowerFirst(type.name);
    api.connect(null, type, name, `${name}s`);
  }
};

export const seedReferenceEmptiness = async (runtime, types) => {
  const execute = executorOf(runtime);
  const ids = {};
  const link = (key) => (key ? { id: ids[key] } : undefined);
  const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  const inputs = {
    shop: (record) => record,
    pro: ({ shop, ...record }) => defined({ ...record, shop: link(shop) }),
    product: ({
      shop, pro, odim, olines, ...record
    }) => defined({
      ...record,
      shop: link(shop),
      pro: link(pro),
      odim: odim && defined({ w: odim.w, shop: link(odim.shop) }),
      olines: olines?.map((line) => defined({ qty: line.qty, shop: link(line.shop) })),
    }),
    review: ({ product, ...record }) => defined({ ...record, product: link(product) }),
  };
  for (const typeKey of REFERENCE_TYPE_KEYS) {
    const root = types.roots[typeKey];
    for (const record of REFERENCE_DATA[typeKey]) {
      const source = `mutation($input:${root.type.name}Input!){add${root.single}(input:$input){id}}`;
      const input = inputs[typeKey](record);
      const result = await execute(source, { input });
      if (result.errors) throw new Error(`${source} ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`);
      ids[record.key] = Object.values(result.data)[0].id;
    }
  }
  return ids;
};

export const writeMongoDanglingReference = async (api, types, { id } = {}) => {
  const missing = id ?? new (await import('mongoose')).default.Types.ObjectId();
  const document = {
    key: REFERENCE_DANGLING_KEY, name: REFERENCE_DANGLING_KEY, stock: 1, shop: missing, pro: missing, odim: { shop: missing },
    olines: [{ qty: 1, shop: missing }],
  };
  await writeMongoEmptinessDocuments(api, types, { product: [document] });
  return document;
};

// The expected rows. Rows are sorted keys; the builders derive what the definitions fix: IS_NOT_EMPTY is the
// complement of IS_EMPTY among the root records the shape reads, and a trusted construct reads stored data, which is
// what an admin's client construct reads, restricted by the root's own scope.
const ALL_ROOT_KEYS = Object.fromEntries(['product', 'review', 'shop'].map((root) => [root, REFERENCE_DATA[root].map((record) => record.key).sort()]));
// The root records each shape reads: only the NE and EQ shapes scope Review, and every shape but admin and proOnly
// scopes Shop; no shape scopes Product.
const VISIBLE = {
  product: {
    admin: ALL_ROOT_KEYS.product, NE: ALL_ROOT_KEYS.product, EQ: ALL_ROOT_KEYS.product, proOnly: ALL_ROOT_KEYS.product,
    shopNE: ALL_ROOT_KEYS.product, shopEQ: ALL_ROOT_KEYS.product,
  },
  review: {
    admin: ALL_ROOT_KEYS.review, NE: ['D:1:x', 'E:5:x', 'Ka:5:x'], EQ: ['D:1:x', 'E:5:x', 'Ka:5:x'], proOnly: ALL_ROOT_KEYS.review,
    shopNE: ALL_ROOT_KEYS.review, shopEQ: ALL_ROOT_KEYS.review,
  },
  shop: {
    admin: ALL_ROOT_KEYS.shop, NE: ['S1', 'S3'], EQ: ['S1'], proOnly: ALL_ROOT_KEYS.shop, shopNE: ['S1', 'S3'], shopEQ: ['S1'],
  },
};
const byShape = (root, rows) => deepFreeze(Object.fromEntries(REFERENCE_SHAPES.map((shape) => {
  if (!Object.hasOwn(rows, shape)) throw new Error(`Rows on ${root} give nothing for the ${shape} shape`);
  const keys = (rows[shape] ? rows[shape].split(' ') : []).sort();
  const outside = keys.filter((key) => !VISIBLE[root][shape].includes(key));
  if (outside.length) throw new Error(`Rows ${outside.join(', ')} are not read by the ${shape} shape on ${root}`);
  return [shape, keys];
})));
const mapShapes = (body) => deepFreeze(Object.fromEntries(REFERENCE_SHAPES.map((shape) => [shape, body(shape)])));
const constructCases = (root, path, emptyRows) => {
  const empty = byShape(root, emptyRows);
  const rest = (rows) => mapShapes((shape) => VISIBLE[root][shape].filter((key) => !rows[shape].includes(key)));
  const trustedEmpty = mapShapes((shape) => empty.admin.filter((key) => VISIBLE[root][shape].includes(key)));
  const name = (operator) => `${root === 'product' ? '' : `${root}: `}${path} ${operator}`;
  // The dangling product reads as empty on every path of these cases.
  const dangling = root === 'product' ? REFERENCE_SHAPES : [];
  return [
    {
      name: name('IS_EMPTY'), root, path, operator: 'IS_EMPTY', rows: empty, trusted: trustedEmpty, dangling,
    },
    {
      name: name('IS_NOT_EMPTY'), root, path, operator: 'IS_NOT_EMPTY', rows: rest(empty), trusted: rest(trustedEmpty), dangling: [],
    },
  ];
};
const argsCase = (name, args, rows, dangling, scopeArgs) => ({
  name, root: 'product', args, ...(scopeArgs ? { scopeArgs } : {}), rows: byShape('product', rows), dangling,
});
const condition = (field, path, operator, value) => ({
  field, ...(path ? { path } : {}), operator, ...(value === undefined ? {} : { value }),
});

export const REFERENCE_CASES = deepFreeze([
  // A hidden record reads as missing: S2 is hidden under NE, EQ, shopNE and shopEQ, S3 under EQ and shopEQ.
  ...constructCases('product', 'shop', {
    admin: 'C', NE: 'C c', EQ: 'C D c', proOnly: 'C', shopNE: 'C c', shopEQ: 'C D c',
  }),
  // The record identity after a reference takes the null rule, so it reads like the reference.
  ...constructCases('product', 'shop.id', {
    admin: 'C', NE: 'C c', EQ: 'C D c', proOnly: 'C', shopNE: 'C c', shopEQ: 'C D c',
  }),
  ...constructCases('product', 'shop.name', {
    admin: 'C', NE: 'C c', EQ: 'C D c', proOnly: 'C', shopNE: 'C c', shopEQ: 'C D c',
  }),
  // A leaf through a scoped join: S3 has no state.
  ...constructCases('product', 'shop.state', {
    admin: 'C D', NE: 'C D c', EQ: 'C D c', proOnly: 'C D', shopNE: 'C D c', shopEQ: 'C D c',
  }),
  // A collection end through a scoped join: every shop has products, so a hidden or absent shop is what empties it.
  ...constructCases('product', 'shop.products', {
    admin: 'C', NE: 'C c', EQ: 'C D c', proOnly: 'C', shopNE: 'C c', shopEQ: 'C D c',
  }),
  // A collection whose storage column is productId: the reviews by "hidden" are hidden under NE and EQ.
  ...constructCases('product', 'reviews', {
    admin: 'C', NE: 'C c', EQ: 'C c', proOnly: 'C', shopNE: 'C', shopEQ: 'C',
  }),
  ...constructCases('product', 'pro', {
    admin: 'E', NE: 'E c', EQ: 'C D E c', proOnly: 'E c', shopNE: 'E', shopEQ: 'E',
  }),
  ...constructCases('product', 'pro.name', {
    admin: 'E', NE: 'E c', EQ: 'C D E c', proOnly: 'E c', shopNE: 'E', shopEQ: 'E',
  }),
  // A hidden Pro (P2 under NE and proOnly; all but P1 under EQ) empties the second hop, also when Shop is unscoped;
  // trusted constructs keep P2's stored shop. Under shopNE and shopEQ the unscoped first hop is followed by a scoped
  // one: C's P3 points to the hidden S2.
  ...constructCases('product', 'pro.shop', {
    admin: 'D E', NE: 'C D E c', EQ: 'C D E c', proOnly: 'D E c', shopNE: 'C D E', shopEQ: 'C D E',
  }),
  ...constructCases('product', 'pro.shop.id', {
    admin: 'D E', NE: 'C D E c', EQ: 'C D E c', proOnly: 'D E c', shopNE: 'C D E', shopEQ: 'C D E',
  }),
  ...constructCases('product', 'pro.shop.state', {
    admin: 'D E', NE: 'C D E c', EQ: 'C D E c', proOnly: 'D E c', shopNE: 'C D E', shopEQ: 'C D E',
  }),
  // The member rule with a reference member: Ka has `w`, and c's S1 is never hidden.
  ...constructCases('product', 'odim', {
    admin: 'E', NE: 'C E', EQ: 'C D E', proOnly: 'E', shopNE: 'C E', shopEQ: 'C D E',
  }),
  ...constructCases('product', 'odim.w', {
    admin: 'C D E c', NE: 'C D E c', EQ: 'C D E c', proOnly: 'C D E c', shopNE: 'C D E c', shopEQ: 'C D E c',
  }),
  ...constructCases('product', 'odim.shop', {
    admin: 'E Ka', NE: 'C E Ka', EQ: 'C D E Ka', proOnly: 'E Ka', shopNE: 'C E Ka', shopEQ: 'C D E Ka',
  }),
  ...constructCases('product', 'odim.shop.id', {
    admin: 'E Ka', NE: 'C E Ka', EQ: 'C D E Ka', proOnly: 'E Ka', shopNE: 'C E Ka', shopEQ: 'C D E Ka',
  }),
  ...constructCases('product', 'odim.shop.state', {
    admin: 'D E Ka', NE: 'C D E Ka', EQ: 'C D E Ka', proOnly: 'D E Ka', shopNE: 'C D E Ka', shopEQ: 'C D E Ka',
  }),
  // A reference frame on a reference stored under another name: Review.product is stored as productId. Every review
  // has a product and no shape scopes Product, so none is empty; IS_NOT_EMPTY gives every review the root reads.
  ...constructCases('review', 'product', {
    admin: '', NE: '', EQ: '', proOnly: '', shopNE: '', shopEQ: '',
  }),
  // Two hops from Review. Its own scope hides the reviews by "hidden" under NE and EQ; shopNE and shopEQ leave the
  // root and Product unscoped and give the probe's rows (map-probe.md section 1), where the scoped Shop hop follows
  // the unscoped Product one.
  ...constructCases('review', 'product.shop', {
    admin: '', NE: '', EQ: 'D:1:x', proOnly: '', shopNE: 'c:1:hidden', shopEQ: 'D:1:x D:5:hidden c:1:hidden',
  }),
  ...constructCases('review', 'product.shop.state', {
    admin: 'D:1:x D:5:hidden',
    NE: 'D:1:x',
    EQ: 'D:1:x',
    proOnly: 'D:1:x D:5:hidden',
    shopNE: 'D:1:x D:5:hidden c:1:hidden',
    shopEQ: 'D:1:x D:5:hidden c:1:hidden',
  }),
  // A collection frame on a scoped root: every shop has products.
  ...constructCases('shop', 'products', {
    admin: '', NE: '', EQ: '', proOnly: '', shopNE: '', shopEQ: '',
  }),
  // Gap 5: the legacy branch keeps its joined scope, and the marked branch reads hidden as missing.
  argsCase('gap 5: OR [legacy shop.id EQ S1, shop IS_EMPTY]', {
    OR: [{ conditions: [condition('shop', 'id', 'EQ', '<id:S1>')] }, { conditions: [condition('shop', null, 'IS_EMPTY')] }],
  }, {
    admin: 'C E Ka', NE: 'C E Ka c', EQ: 'C D E Ka c', proOnly: 'C E Ka', shopNE: 'C E Ka c', shopEQ: 'C D E Ka c',
  }, REFERENCE_SHAPES),
  // A legacy branch in an OR beside a marked construct: c never appears for a restricted caller.
  argsCase('OR [legacy shop.name EQ "S2", shop IS_NOT_EMPTY]', {
    OR: [{ conditions: [condition('shop', 'name', 'EQ', 'S2')] }, { conditions: [condition('shop', null, 'IS_NOT_EMPTY')] }],
  }, {
    admin: 'D E Ka c', NE: 'D E Ka', EQ: 'E Ka', proOnly: 'D E Ka c', shopNE: 'D E Ka', shopEQ: 'E Ka',
  }, []),
  // The same group: the legacy condition's joined scope restricts the marked construct too.
  argsCase('one group [legacy shop.name EQ "S2", shop IS_NOT_EMPTY]', {
    AND: [{ conditions: [condition('shop', 'name', 'EQ', 'S2'), condition('shop', null, 'IS_NOT_EMPTY')] }],
  }, {
    admin: 'c', NE: '', EQ: '', proOnly: 'c', shopNE: '', shopEQ: '',
  }, []),
  argsCase('one group [legacy shop.name EQ "S2", shop IS_EMPTY]', {
    AND: [{ conditions: [condition('shop', 'name', 'EQ', 'S2'), condition('shop', null, 'IS_EMPTY')] }],
  }, {
    admin: '', NE: '', EQ: '', proOnly: '', shopNE: '', shopEQ: '',
  }, []),
  // A sort keeps a joined scope on the whole query: under EQ it removes the products without a shop and those with a
  // hidden one, under NE only those with a hidden one.
  argsCase('sort shop.name beside shop IS_EMPTY', {
    shop: { terms: [{ operator: 'IS_EMPTY' }] }, sort: { terms: [{ field: 'shop.name', order: 'ASC' }] },
  }, {
    admin: 'C', NE: 'C', EQ: '', proOnly: 'C', shopNE: 'C', shopEQ: '',
  }, ['admin', 'NE', 'proOnly', 'shopNE']),
  // A client chain beside a trusted condition on the same path, which the root's own scope adds: P2's stored shop
  // keeps c in the trusted condition while the client's hidden P2 empties the chain.
  argsCase('pro.shop IS_EMPTY beside a trusted pro.shop IS_NOT_EMPTY', {
    pro: { terms: [{ path: 'shop', operator: 'IS_EMPTY' }] },
  }, {
    admin: '', NE: 'C c', EQ: 'C c', proOnly: 'c', shopNE: 'C', shopEQ: 'C',
  }, [], { AND: [{ conditions: [condition('pro', 'shop', 'IS_NOT_EMPTY')] }] }),
  // A client chain after a legacy branch on the same path, whose joins and joined scopes it must not share.
  argsCase('OR [legacy pro.shop.name EQ "S2", pro.shop.state IS_EMPTY]', {
    OR: [{ conditions: [condition('pro', 'shop.name', 'EQ', 'S2')] }, { conditions: [condition('pro', 'shop.state', 'IS_EMPTY')] }],
  }, {
    admin: 'C D E', NE: 'C D E c', EQ: 'C D E c', proOnly: 'C D E c', shopNE: 'C D E', shopEQ: 'C D E',
  }, REFERENCE_SHAPES),
]);

const ID_PLACEHOLDER = /^<id:([^>]+)>$/;
const withReferenceIds = (value, ids) => {
  if (typeof value === 'string') {
    const match = ID_PLACEHOLDER.exec(value);
    if (!match) return value;
    if (!Object.hasOwn(ids, match[1])) throw new Error(`No id for ${match[1]}`);
    return ids[match[1]];
  }
  if (Array.isArray(value)) return value.map((item) => withReferenceIds(item, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withReferenceIds(item, ids)]));
  return value;
};

export const referenceCaseArgs = (item, ids = {}, form = 'field') => {
  if (item.args) return withReferenceIds(item.args, ids);
  const [head, ...rest] = item.path.split('.');
  const tail = rest.join('.');
  if (form === 'condition') return { AND: [{ conditions: [condition(head, tail, item.operator)] }] };
  // Every construct case starts at an object field, so the field form is a term.
  return { [head]: { terms: [{ ...(tail ? { path: tail } : {}), operator: item.operator }] } };
};

export const expectedReferenceRows = (item, shape, { trusted = false, dangling = false } = {}) => {
  const rows = trusted ? item.trusted?.[shape] : item.rows[shape];
  if (!rows) throw new Error(`The case ${item.name} has no ${trusted ? 'trusted ' : ''}rows for ${shape}`);
  return [...rows, ...(dangling && item.dangling.includes(shape) ? [REFERENCE_DANGLING_KEY] : [])].sort();
};

const REFERENCE_ARGUMENT_TYPES = {
  AND: '[QLFilterGroup]', OR: '[QLFilterGroup]', sort: 'QLSortExpression', pagination: 'QLPagination',
};
export const referenceQuery = (types, rootKey, args, selection = 'key') => {
  const root = types.roots[rootKey];
  if (!root) throw new Error(`No root ${rootKey}`);
  const typeOf = (name) => REFERENCE_ARGUMENT_TYPES[name] ?? emptinessArgumentType(types, rootKey, name);
  const names = Object.keys(args);
  const declared = names.map((name) => `$${name}:${typeOf(name)}`).join(',');
  const passed = [...names.map((name) => `${name}:$${name}`), ...(Object.hasOwn(args, 'sort') ? [] : ['sort:{terms:[{field:"key",order:ASC}]}'])];
  return { source: `query${declared ? `(${declared})` : ''}{${root.plural}(${passed.join(',')}){${selection}}}`, variables: args };
};

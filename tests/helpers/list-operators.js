// The fixture, data and cases of the list operators CONTAINS_ALL and IIN (#108, part 4), shared by the core, runtime,
// MongoDB, PostgreSQL, parity and MCP tests. It imports only what the release before part 4 already has, so that a
// suite that imports it loads there and fails test by test.
//
// Fixture (type names start with the prefix, `Ql` on PostgreSQL and `Qlm` on MongoDB unless one is given):
// - Kind, an enum whose names differ from its values (ONE is 'one_v'); Email, a validated String scalar that requires
//   an `@`; DateTime, a scalar named DateTime, so one fixture per schema.
// - Embedded types: SLine { sku }, Sub { code, notes }, PSub { code }, Dims { label, codes } and Line { id: ID, sku,
//   qty, at, notes, subs: [Sub] } (jsonb on PostgreSQL), Box { label, tags, shop } and Part { sku, at, codes, subs:
//   [PSub], shop } (owned tables on PostgreSQL, by their reference member).
// - Entities, each with `id: ID` and a required `key`: Shop { name, tags, slines, items }, Review { author, tags, item },
//   Note { itemId } (a plain ID that Item.notes names as its connectionField, so describeModels infers a reference),
//   Label { name } (its record identity declared as `id: String`) and Item { name, tags, emails, ids, ranks, scores,
//   flags, kinds, ats, dims, box, lines, parts, shop, label, reviews, notes }, whose lists are [String], [Email], [ID],
//   [Int], [Float], [Boolean], [Kind] and [DateTime].
//
// Exports:
// - createListOperatorTypes(prefix, { backend = 'postgres', scopes = false } = {}) -> types. Fresh GraphQL types for
//   one runtime; a null or undefined `prefix` takes the backend's. `types` holds `backend`, `prefix`, the scalars
//   `Kind`, `Email` and `DateTime`, the entity types `Shop`, `Review`, `Note`, `Label` and `Item`, `embedded` (every
//   embedded type) and `roots`: `{ [typeKey]: { key, type, single, plural } }` for 'shop', 'label', 'item', 'review'
//   and 'note', where `single` and `plural` are the endpoint names (`add${single}`, `update${single}`,
//   `${plural}(...)`). `scopes: true` gives Shop and Review a `find` scope, and Item a `find` and a `get_by_id` scope,
//   which apply the named scopes of LIST_OPERATOR_SCOPES that `context.scopes` lists (an array, so that several apply
//   together; without it the caller is an admin, and 'admin' in it adds nothing). An object applies the named scopes
//   too and adds its own scope functions by type key and operation (`{ item: { find, get_by_id, aggregate } }`), each
//   called with the runtime's parameters after the named scopes of that type and operation.
// - registerListOperatorTypes(api, types): registers the embedded types and connects every entity.
// - LIST_OPERATOR_SCOPES: `{ [name]: { type, operation, condition } }`, the named scopes; each appends its condition,
//   as one AND group, to the scope's arguments.
// - LIST_OPERATOR_DATA: the records by type key, in input form (enum names, ISO dates, references and the connection
//   field of Note by the target's key, `<id:u1>`, `<id:u2>` and `<line:L1>` to `<line:L3>` for the identifiers that
//   each backend generates); LIST_OPERATOR_DATES: `{ d1, d2 }`.
// - seedListOperators(execute, backend = 'postgres') -> Promise<{ ids, lineIds }>. Writes the records through
//   generated mutations only, on types made with the backend's prefix: every create, then the updates that null S4's
//   and R4's tags and I5's lists, dims, box, lines and parts (a generated update unsets a nulled field: SQL NULL on
//   PostgreSQL, absent on MongoDB; a generated create would store an empty list), then one update each for I1 and I3
//   that resends every Line item with all of its members and its id (create inputs leave an embedded `id` out, update
//   inputs require it on every item). `execute(source, variables)` runs a GraphQL operation and returns its result;
//   any GraphQL error throws. `ids` holds every record's id by key, and `u1` and `u2`, the values of the `ids` lists
//   (`new ObjectId().toHexString()` on MongoDB, `randomUUID()` on PostgreSQL); `lineIds` holds `L1`, `L2` and `L3`,
//   generated the same way and read back with `{ key lines { id } }`. Every other line reads `id: null`.
// - listOperatorStore(models) -> store: the same records for createMemoryAdapter's `data` option
//   (tests/helpers/collection-frames.js), in stored form: `_id` and references hold keys, enum values, ISO date
//   strings, `u1`, `u2` and `L1` to `L3` as their own names, `null` where the updates null a field, and I3's `dims` as
//   its create stores it, with `codes: []`. Fields the data leaves out are absent, where the backends store some as
//   `[]` or as an empty object; no row of LIST_OPERATOR_CASES tells the two apart.
// - listOperatorArgs(value, { ids, lineIds } = the store's) -> value with every `<id:…>` and `<line:…>` placeholder
//   replaced, for seedListOperators's result or, by default, for listOperatorStore.
// - LIST_OPERATOR_CASES: the rows of the spec's parity section (#108 part 4, 9.3) that return keys, every one a list
//   query on Item: `{ name, bullet, operator, args, rows, condition?, frame?, counts?, forbidden?, guard?, dateTime?,
//   enumNames? }`. `args` are client arguments with placeholders; `condition` (`{ field, operator, value }`) is set for
//   single conditions, whose `args` are the field filter, and `frame` (`{ quantifier, path, condition }`) for explicit
//   groups, whose `args` are `{ AND: [{ [quantifier]: [{ path, conditions }] }] }`; the quantified field filter has
//   `args` only. `rows` holds the item keys by
//   scope shape ('admin', 'shopNE', 'shopEQ', 'reviewNE', 'reviewEQ', 'shopTags': the context `{ scopes: [shape] }`),
//   in key order, with the duplicates of the multiplying join through `parts.shop`, which the memory adapter returns
//   once; only the shapes the spec names are listed. `counts` holds `pagination.count` where the spec gives one;
//   `forbidden` the shapes that give FORBIDDEN_FILTER_PATH; `guard` marks the IN twin, which passes before part 4;
//   `dateTime` the DateTime rows, pinned on the real backends only; `enumNames` the rows whose values are Kind names,
//   which the compilers cast to the stored values and the memory store does not. The 403 row is here for its admin
//   keys; the other rejections of 9.3, the aggregates, the by-ID scopes, the named views and the 70,001-value rows
//   stay in the suites.
// - IIN_ITEM_CASES and IIN_FOLDING_CASES: the oracle "IIN is the union of IEQ" on the text fixture
//   (tests/helpers/query-text-operators.js). Every IEQ row of ITEM_CASES (a field filter or a one-term relation
//   filter; its AND and OR group cases are left out, since 9.3 also runs each derived row as an AND condition and an
//   OR branch) and of FOLDING_CASES becomes an IIN row with the value in a one-element array and the same keys, words,
//   `mongodb` and `difference` columns; then each path with more than one IEQ row gets one row that joins all of its
//   values, with the union of their keys or words (a path with one IEQ row already has that row). The shapes are those
//   of ITEM_CASES and FOLDING_CASES.
import { randomUUID } from 'node:crypto';
import {
  GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType,
  GraphQLScalarType, GraphQLString,
} from 'graphql';
import { createValidatedScalar } from '../../packages/core/src/index.js';
import { FOLDING_CASES, ITEM_CASES, WORDS } from './query-text-operators.js';

const embedded = { relation: { embedded: true } };
const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);
const upperFirst = (value) => value.charAt(0).toUpperCase() + value.slice(1);
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

const PREFIXES = Object.freeze({ postgres: 'Ql', mongodb: 'Qlm' });
const prefixOf = (backend) => {
  if (!Object.hasOwn(PREFIXES, backend)) throw new Error(`Unknown list operator backend ${backend}`);
  return PREFIXES[backend];
};
// Creates go in this order, so that every reference finds its target.
const TYPE_KEYS = Object.freeze(['shop', 'label', 'item', 'review', 'note']);
const SCOPE_OPERATIONS = Object.freeze(['find', 'get_by_id', 'aggregate']);
const KIND_VALUES = Object.freeze({ ONE: 'one_v', TWO: 'two_v', THREE: 'three_v' });

export const LIST_OPERATOR_SCOPES = deepFreeze({
  // Null-accepting: the shop and the review with a null name or author stay visible.
  shopNE: { type: 'shop', operation: 'find', condition: { field: 'name', operator: 'NE', value: 'beta' } },
  reviewNE: { type: 'review', operation: 'find', condition: { field: 'author', operator: 'NE', value: 'hidden' } },
  // Null-rejecting: shopEQ hides S2, S3 and S4, reviewEQ every review but R1, R4's null author included.
  shopEQ: { type: 'shop', operation: 'find', condition: { field: 'name', operator: 'EQ', value: 'Alpha' } },
  reviewEQ: { type: 'review', operation: 'find', condition: { field: 'author', operator: 'EQ', value: 'Ana' } },
  shopTags: { type: 'shop', operation: 'find', condition: { field: 'tags', operator: 'CONTAINS_ALL', value: ['a'] } },
  itemTags: { type: 'item', operation: 'find', condition: { field: 'tags', operator: 'CONTAINS_ALL', value: ['A'] } },
  byIdTags: { type: 'item', operation: 'get_by_id', condition: { field: 'tags', operator: 'CONTAINS_ALL', value: ['A', 'B'] } },
  byIdName: { type: 'item', operation: 'get_by_id', condition: { field: 'name', operator: 'IIN', value: ['ONE'] } },
});

// The named scopes that a request context lists.
const activeScopes = (context) => {
  const names = context?.scopes ?? [];
  if (!Array.isArray(names)) throw new Error('context.scopes must be an array of list operator scope names');
  for (const name of names) {
    if (name !== 'admin' && !Object.hasOwn(LIST_OPERATOR_SCOPES, name)) throw new Error(`Unknown list operator scope ${name}`);
  }
  return names.filter((name) => name !== 'admin').map((name) => LIST_OPERATOR_SCOPES[name]);
};

const scopeExtensions = (typeKey, scopes) => {
  if (!scopes) return {};
  const extra = scopes === true ? {} : scopes[typeKey] ?? {};
  const operations = SCOPE_OPERATIONS.filter((operation) => Object.hasOwn(extra, operation)
    || Object.values(LIST_OPERATOR_SCOPES).some((scope) => scope.type === typeKey && scope.operation === operation));
  if (!operations.length) return {};
  const scope = Object.fromEntries(operations.map((operation) => [operation, (params) => {
    for (const named of activeScopes(params.context)) {
      if (named.type !== typeKey || named.operation !== operation) continue;
      const { value } = named.condition;
      const condition = { ...named.condition, value: Array.isArray(value) ? [...value] : value };
      params.args.AND = [...(Array.isArray(params.args.AND) ? params.args.AND : []), { conditions: [condition] }];
    }
    return extra[operation]?.(params);
  }]));
  return { extensions: { scope } };
};

const checkScopes = (scopes) => {
  if (scopes === true || !scopes) return;
  if (typeof scopes !== 'object') throw new Error('scopes must be true or an object of scope functions by type key');
  for (const [typeKey, operations] of Object.entries(scopes)) {
    if (!TYPE_KEYS.includes(typeKey)) throw new Error(`Unknown list operator type key ${typeKey}`);
    for (const [operation, scope] of Object.entries(operations ?? {})) {
      if (!SCOPE_OPERATIONS.includes(operation) || typeof scope !== 'function') throw new Error(`scopes.${typeKey}.${operation} must be a find, get_by_id or aggregate function`);
    }
  }
};

export const createListOperatorTypes = (prefix, { backend = 'postgres', scopes = false } = {}) => {
  const name = prefix ?? prefixOf(backend);
  checkScopes(scopes);
  const scoped = (typeKey) => scopeExtensions(typeKey, scopes);
  const list = (type) => ({ type: new GraphQLList(type) });
  const DateTime = new GraphQLScalarType({
    name: 'DateTime',
    serialize: (value) => new Date(value).toISOString(),
    parseValue: (value) => new Date(value),
    parseLiteral: (node) => new Date(node.value),
  });
  const Email = createValidatedScalar(`${name}Email`, 'An email address', GraphQLString, (value) => {
    if (typeof value !== 'string' || !value.includes('@')) throw new Error(`${name}Email requires an @`);
  });
  const Kind = new GraphQLEnumType({ name: `${name}Kind`, values: Object.fromEntries(Object.entries(KIND_VALUES).map(([key, value]) => [key, { value }])) });

  const SLine = new GraphQLObjectType({ name: `${name}SLine`, fields: { sku: { type: GraphQLString } } });
  const Sub = new GraphQLObjectType({ name: `${name}Sub`, fields: { code: { type: GraphQLString }, notes: list(GraphQLString) } });
  const PSub = new GraphQLObjectType({ name: `${name}PSub`, fields: { code: { type: GraphQLString } } });
  const Dims = new GraphQLObjectType({ name: `${name}Dims`, fields: { label: { type: GraphQLString }, codes: list(GraphQLString) } });
  const Line = new GraphQLObjectType({
    name: `${name}Line`,
    fields: {
      id: { type: GraphQLID }, sku: { type: GraphQLString }, qty: { type: GraphQLInt }, at: { type: DateTime }, notes: list(GraphQLString),
      subs: { type: new GraphQLList(Sub), extensions: embedded },
    },
  });
  // A reference member makes these owned tables on PostgreSQL.
  const Box = new GraphQLObjectType({
    name: `${name}Box`,
    fields: () => ({ label: { type: GraphQLString }, tags: list(GraphQLString), shop: { type: Shop, extensions: reference() } }),
  });
  const Part = new GraphQLObjectType({
    name: `${name}Part`,
    fields: () => ({
      sku: { type: GraphQLString }, at: { type: DateTime }, codes: list(GraphQLString),
      subs: { type: new GraphQLList(PSub), extensions: embedded }, shop: { type: Shop, extensions: reference() },
    }),
  });
  const Shop = new GraphQLObjectType({
    name: `${name}Shop`,
    ...scoped('shop'),
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString }, tags: list(GraphQLString),
      slines: { type: new GraphQLList(SLine), extensions: embedded },
      items: { type: new GraphQLList(Item), extensions: reference('shop') },
    }),
  });
  const Review = new GraphQLObjectType({
    name: `${name}Review`,
    ...scoped('review'),
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, author: { type: GraphQLString }, tags: list(GraphQLString),
      item: { type: Item, extensions: reference('item') },
    }),
  });
  // A plain ID, which Item.notes names as its connectionField: describeModels infers a reference to Item.
  const Note = new GraphQLObjectType({
    name: `${name}Note`,
    ...scoped('note'),
    fields: { id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, itemId: { type: GraphQLID } },
  });
  // The record identity declared as a String.
  const Label = new GraphQLObjectType({
    name: `${name}Label`,
    ...scoped('label'),
    fields: { id: { type: GraphQLString }, key: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString } },
  });
  const Item = new GraphQLObjectType({
    name: `${name}Item`,
    ...scoped('item'),
    fields: () => ({
      id: { type: GraphQLID },
      key: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      tags: list(GraphQLString),
      emails: list(Email),
      ids: list(GraphQLID),
      ranks: list(GraphQLInt),
      scores: list(GraphQLFloat),
      flags: list(GraphQLBoolean),
      kinds: list(Kind),
      ats: list(DateTime),
      dims: { type: Dims, extensions: embedded },
      box: { type: Box, extensions: embedded },
      lines: { type: new GraphQLList(Line), extensions: embedded },
      parts: { type: new GraphQLList(Part), extensions: embedded },
      shop: { type: Shop, extensions: reference('shop') },
      label: { type: Label, extensions: reference() },
      reviews: { type: new GraphQLList(Review), extensions: reference('item') },
      notes: { type: new GraphQLList(Note), extensions: reference('itemId') },
    }),
  });
  const types = { shop: Shop, label: Label, item: Item, review: Review, note: Note };
  return {
    backend,
    prefix: name,
    Kind,
    Email,
    DateTime,
    Shop,
    Review,
    Note,
    Label,
    Item,
    embedded: [SLine, Sub, PSub, Dims, Line, Box, Part],
    roots: Object.fromEntries(TYPE_KEYS.map((key) => [key, {
      key, type: types[key], single: lowerFirst(types[key].name), plural: `${lowerFirst(types[key].name)}s`,
    }])),
  };
};

export const registerListOperatorTypes = (api, types) => {
  for (const type of types.embedded) api.addNoEndpointType(type);
  for (const root of Object.values(types.roots)) api.connect(null, root.type, root.single, root.plural);
};

const d1 = '2024-01-01T00:00:00.000Z';
const d2 = '2024-06-01T12:30:00.000Z';
export const LIST_OPERATOR_DATES = Object.freeze({ d1, d2 });

export const LIST_OPERATOR_DATA = deepFreeze({
  shop: [
    { key: 'S1', name: 'Alpha', tags: ['a', 'b'], slines: [{ sku: 'A' }, { sku: 'B' }] },
    { key: 'S2', name: 'beta', tags: ['a'], slines: [{ sku: 'A' }] },
    { key: 'S3', name: 'GAMMA', tags: [], slines: [] },
    // Its tags are nulled by an update.
    { key: 'S4' },
  ],
  label: [{ key: 'LB1', name: 'lb' }],
  item: [
    {
      key: 'I1', name: 'one', tags: ['A', 'B', 'C'], emails: ['Ana@x.io', 'bob@y.io'], ids: ['<id:u1>', '<id:u2>'], ranks: [1, 2, 3],
      scores: [1.5, 2], flags: [true, false], kinds: ['ONE', 'TWO'], ats: [d1, d2],
      dims: { label: 'L', codes: ['A', 'B'] }, box: { label: 'x', tags: ['p', 'q'], shop: 'S1' },
      // The line ids are written by an update.
      lines: [
        { id: '<line:L1>', sku: 'A', qty: 1, at: d1, notes: ['n1'], subs: [{ code: 'c1', notes: ['n1'] }, { code: 'c2' }] },
        { id: '<line:L2>', sku: 'B', qty: 2, at: d2, notes: ['n2'], subs: [{ code: 'c3', notes: ['n2'] }] },
      ],
      parts: [
        { sku: 'A', at: d1, codes: ['x'], subs: [{ code: 'c1' }], shop: 'S1' },
        { sku: 'B', at: d2, codes: ['y'], subs: [{ code: 'c2' }], shop: 'S2' },
      ],
      shop: 'S1', label: 'LB1',
    },
    {
      key: 'I2', name: 'TWO', tags: ['A'], emails: ['ANA@X.IO'], ids: ['<id:u1>'], ranks: [1], flags: [false], kinds: ['ONE'], ats: [d1],
      dims: { codes: ['A'] }, box: { tags: ['p'], shop: 'S2' }, lines: [{ sku: 'A', qty: 1, at: d1, subs: [{ code: 'c1' }] }],
      parts: [{ sku: 'A', shop: 'S2' }], shop: 'S2',
    },
    {
      key: 'I3', name: 'three', tags: ['B', 'A'], emails: [], ids: ['<id:u2>', '<id:u1>'], ranks: [2, 1], scores: [2], flags: [true],
      kinds: [], ats: [d2, d1], dims: { label: 'M' }, box: { label: 'y' },
      // The line ids are written by an update.
      lines: [{ id: '<line:L1>', sku: 'A' }, { id: '<line:L3>', sku: 'B' }],
      parts: [{ sku: 'B', shop: 'S3' }, { sku: 'C', shop: 'S1' }], shop: 'S3',
    },
    { key: 'I4' },
    // Its lists, dims, box, lines and parts are nulled by an update.
    { key: 'I5', name: null, shop: 'S4' },
    {
      key: 'I6', name: 'Six', tags: ['A', 'A', '$x'], ranks: [3], kinds: ['TWO', 'THREE'], box: { tags: ['q', 'p', 'p'] },
      lines: [{ sku: 'X', subs: [{ code: 'c2', notes: ['n1', 'n2'] }, { code: 'c1' }] }],
      parts: [
        { sku: 'X', at: d1, codes: ['x', 'y'], subs: [{ code: 'c1' }, { code: 'c2' }], shop: 'S1' },
        { sku: 'Y', codes: ['z'], shop: 'S1' },
      ],
    },
    { key: 'I7', tags: [null], ids: [null], ranks: [null], emails: [null] },
    { key: 'I8', name: 'a', tags: ['a', 'b'], emails: ['ana@x.io'], lines: [{ sku: 'a' }, { sku: 'b' }] },
  ],
  review: [
    { key: 'R1', author: 'Ana', tags: ['x', 'y'], item: 'I1' },
    { key: 'R2', author: 'bob', tags: ['x'], item: 'I1' },
    { key: 'R3', author: 'ANA', tags: ['x', 'y'], item: 'I2' },
    // Its tags are nulled by an update.
    { key: 'R4', author: null, item: 'I3' },
    { key: 'R5', author: 'Zoë', tags: ['y'], item: 'I5' },
    { key: 'R6', author: 'hidden', tags: ['x', 'y', 'z'], item: 'I6' },
  ],
  note: [{ key: 'N1', itemId: 'I1' }],
});

// The generated updates that null a field, by type key and record key.
const UPDATES = deepFreeze([
  ['shop', 'S4', { tags: null }],
  ['review', 'R4', { tags: null }],
  ['item', 'I5', {
    tags: null, emails: null, ids: null, ranks: null, scores: null, flags: null, kinds: null, ats: null, dims: null, box: null, lines: null, parts: null,
  }],
]);
// The records whose lines get their ids by an update.
const LINE_ID_KEYS = Object.freeze(['I1', 'I3']);
// What a create stores where the data does not say it: I3's dims has a list member, which a create stores as `[]`.
const STORED_AS = deepFreeze({ item: { I3: { dims: { label: 'M', codes: [] } } } });

const LIST_OPERATOR_STORE_IDS = deepFreeze({
  ids: Object.fromEntries([...Object.values(LIST_OPERATOR_DATA).flat().map(({ key }) => key), 'u1', 'u2'].map((key) => [key, key])),
  lineIds: { L1: 'L1', L2: 'L2', L3: 'L3' },
});

const PLACEHOLDER = /^<(id|line):([^>]+)>$/;
export const listOperatorArgs = (value, { ids, lineIds } = LIST_OPERATOR_STORE_IDS) => {
  if (typeof value === 'string') {
    const match = PLACEHOLDER.exec(value);
    if (!match) return value;
    const found = match[1] === 'id' ? ids : lineIds;
    if (!Object.hasOwn(found ?? {}, match[2])) throw new Error(`No identifier for ${value}`);
    return found[match[2]];
  }
  if (Array.isArray(value)) return value.map((item) => listOperatorArgs(item, { ids, lineIds }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, listOperatorArgs(item, { ids, lineIds })]));
  return value;
};

const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

export const seedListOperators = async (execute, backend = 'postgres') => {
  const prefix = prefixOf(backend);
  const generate = backend === 'mongodb'
    ? await import('mongoose').then(({ default: mongoose }) => () => new mongoose.Types.ObjectId().toHexString())
    : () => randomUUID();
  const ids = { u1: generate(), u2: generate() };
  const written = { L1: generate(), L2: generate(), L3: generate() };
  const endpoint = (typeKey) => ({ type: `${prefix}${upperFirst(typeKey)}`, single: lowerFirst(`${prefix}${upperFirst(typeKey)}`) });
  const run = async (source, input) => {
    const result = await execute(source, { input });
    if (result.errors) throw new Error(`${source} ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`);
    return Object.values(result.data)[0];
  };
  const link = (key) => (key == null ? undefined : { id: ids[key] });
  // Create inputs: references as `{ id }`, Note's connection field as the id itself, and no embedded line id.
  const inputs = {
    shop: (record) => record,
    label: (record) => record,
    item: ({ shop, label, box, lines, parts, ...record }) => defined({
      ...listOperatorArgs(record, { ids, lineIds: {} }),
      shop: link(shop),
      label: link(label),
      box: box && defined({ ...box, shop: link(box.shop) }),
      lines: lines?.map((line) => Object.fromEntries(Object.entries(line).filter(([member]) => member !== 'id'))),
      parts: parts?.map((part) => defined({ ...part, shop: link(part.shop) })),
    }),
    review: ({ item, ...record }) => defined({ ...record, item: link(item) }),
    note: ({ itemId, ...record }) => ({ ...record, itemId: ids[itemId] }),
  };
  for (const typeKey of TYPE_KEYS) {
    const { type, single } = endpoint(typeKey);
    for (const record of LIST_OPERATOR_DATA[typeKey]) {
      const created = await run(`mutation($input:${type}Input!){add${single}(input:$input){id key}}`, inputs[typeKey](record));
      ids[created.key] = created.id;
    }
  }
  const update = (typeKey, key, input) => {
    const { type, single } = endpoint(typeKey);
    return run(`mutation($input:${type}InputForUpdate!){update${single}(input:$input){id}}`, { ...input, id: ids[key] });
  };
  for (const [typeKey, key, input] of UPDATES) await update(typeKey, key, input);
  // An update replaces the stored list, so it resends every item with all of its members.
  for (const key of LINE_ID_KEYS) {
    const { lines } = LIST_OPERATOR_DATA.item.find((record) => record.key === key);
    await update('item', key, { lines: listOperatorArgs(lines, { ids, lineIds: written }) });
  }
  const read = await execute(`{${endpoint('item').single}s(sort:{terms:[{field:"key",order:ASC}]}){key lines{id}}}`, {});
  if (read.errors) throw new Error(`Reading the line ids: ${JSON.stringify(read.errors)}`);
  const lines = Object.fromEntries(Object.values(read.data)[0].map((row) => [row.key, (row.lines ?? []).map((line) => line.id)]));
  const lineIds = { L1: lines.I1?.[0], L2: lines.I1?.[1], L3: lines.I3?.[1] };
  if (lines.I1?.length !== 2 || lines.I3?.length !== 2 || lines.I3[0] !== lineIds.L1
    || !Object.values(lineIds).every((id) => typeof id === 'string') || new Set(Object.values(lineIds)).size !== 3) {
    throw new Error(`The lines of I1 and I3 do not read back as [L1, L2] and [L1, L3]: ${JSON.stringify(lines)}`);
  }
  return { ids, lineIds };
};

export const listOperatorStore = (models) => {
  const item = models.entities.find((entity) => entity.name.endsWith('Item')
    && TYPE_KEYS.every((typeKey) => models.entities.some((other) => other.name === `${entity.name.slice(0, -4)}${upperFirst(typeKey)}`)));
  if (!item) throw new Error('The models hold no list operator fixture');
  const prefix = item.name.slice(0, -4);
  const store = {};
  for (const typeKey of TYPE_KEYS) {
    store[`${prefix}${upperFirst(typeKey)}`] = LIST_OPERATOR_DATA[typeKey].map((data) => {
      const record = { _id: data.key, ...listOperatorArgs(data) };
      if (record.kinds) record.kinds = record.kinds.map((kind) => KIND_VALUES[kind]);
      for (const [updated, key, input] of UPDATES) if (updated === typeKey && key === data.key) Object.assign(record, input);
      return { ...record, ...structuredClone(STORED_AS[typeKey]?.[data.key] ?? {}) };
    });
  }
  return store;
};

// The cases. Keys are written as one string per shape, in key order; a bare string is the admin shape.
const SHAPES = Object.freeze(['admin', 'shopNE', 'shopEQ', 'reviewNE', 'reviewEQ', 'shopTags']);
const ALL_ITEMS = 'I1 I2 I3 I4 I5 I6 I7 I8';
const fieldFilter = ({ field, operator, value }) => {
  const [head, ...rest] = field.split('.');
  return rest.length ? { [head]: { terms: [{ path: rest.join('.'), operator, value }] } } : { [head]: { operator, value } };
};
const conditionCase = (bullet, field, operator, value, rows, extra = {}) => {
  const condition = { field, operator, value };
  return {
    name: `${field} ${operator} ${JSON.stringify(value)}`, bullet, operator, condition, args: fieldFilter(condition), rows, ...extra,
  };
};
const frameCase = (bullet, quantifier, path, field, operator, value, rows, extra = {}) => {
  const condition = { field, operator, value };
  return {
    name: `${quantifier} ${path}: ${field} ${operator} ${JSON.stringify(value)}`,
    bullet,
    operator,
    frame: { quantifier, path, condition },
    args: { AND: [{ [quantifier]: [{ path, conditions: [{ ...condition }] }] }] },
    rows,
    ...extra,
  };
};
const containsAll = (field, value, rows, extra) => conditionCase('CONTAINS_ALL rows', field, 'CONTAINS_ALL', value, rows, extra);
const dateTime = { dateTime: true };
const enumNames = { enumNames: true };
const joined = (field, value, rows) => conditionCase('CONTAINS_ALL through a scoped single reference outside frames', field, 'CONTAINS_ALL', value, rows);
const iin = (field, value, rows, extra) => conditionCase('IIN rows', field, 'IIN', value, rows, extra);
const reviewTagsAll = { admin: 'I1 I2 I4 I6 I7 I8', reviewNE: 'I1 I2 I4 I6 I7 I8', reviewEQ: ALL_ITEMS };
const scopedAny = { admin: 'I1 I2', shopNE: 'I1', shopEQ: 'I1', shopTags: 'I1 I2' };
const scopedAnyGamma = { admin: 'I1 I2 I3', shopNE: 'I1 I3', shopEQ: 'I1', shopTags: 'I1 I2' };
const scopedAll = { admin: 'I1 I2 I4 I7 I8', shopNE: 'I1 I4 I7 I8', shopEQ: 'I1 I4 I7 I8' };
const partsShop = { rows: { admin: 'I1 I1 I2 I3 I6', shopNE: 'I1 I3 I6', shopEQ: 'I1 I3 I6' }, counts: { admin: 5, shopNE: 3, shopEQ: 3 } };

const CASES = [
  containsAll('tags', ['A'], 'I1 I2 I3 I6'),
  containsAll('tags', ['A', 'B'], 'I1 I3'),
  containsAll('tags', ['A', 'A'], 'I1 I2 I3 I6'),
  containsAll('tags', ['B', 'A'], 'I1 I3'),
  containsAll('tags', ['a'], 'I8'),
  // A `$`-leading value is inert inside MongoDB's $all.
  containsAll('tags', ['$x'], 'I6'),
  containsAll('ids', ['<id:u1>', '<id:u2>'], 'I1 I3'),
  containsAll('ids', ['<id:u1>'], 'I1 I2 I3'),
  containsAll('ranks', [1, 2], 'I1 I3'),
  containsAll('ranks', [3], 'I1 I6'),
  containsAll('scores', [2], 'I1 I3'),
  containsAll('scores', [1.5, 2], 'I1'),
  containsAll('flags', [true], 'I1 I3'),
  containsAll('flags', [true, false], 'I1'),
  containsAll('flags', [false], 'I1 I2'),
  containsAll('kinds', ['ONE', 'TWO'], 'I1', enumNames),
  containsAll('kinds', ['one_v'], 'I1 I2'),
  containsAll('kinds', ['THREE', 'TWO'], 'I6', enumNames),
  containsAll('ats', [d1, d2], 'I1 I3', dateTime),
  // Case-sensitive.
  containsAll('emails', ['Ana@x.io'], 'I1'),
  containsAll('dims.codes', ['A', 'B'], 'I1'),
  containsAll('dims.codes', ['A'], 'I1 I2'),
  containsAll('box.tags', ['p', 'q'], 'I1 I6'),
  containsAll('box.tags', ['p'], 'I1 I2 I6'),
  containsAll('lines.sku', ['A', 'B'], 'I1 I3'),
  containsAll('lines.notes', ['n1', 'n2'], 'I1'),
  containsAll('lines.qty', [1, 2], 'I1'),
  containsAll('lines.at', [d1, d2], 'I1', dateTime),
  // The owned timestamp list beside the jsonb one of lines.at.
  containsAll('parts.at', [d1, d2], 'I1', dateTime),
  containsAll('parts.at', [d1], 'I1 I6', dateTime),
  containsAll('lines.id', ['<line:L1>', '<line:L2>'], 'I1'),
  containsAll('lines.id', ['<line:L1>'], 'I1 I3'),
  containsAll('lines.id', ['<line:L3>'], 'I3'),
  containsAll('lines.subs.code', ['c1', 'c3'], 'I1'),
  containsAll('lines.subs.code', ['c1', 'c2'], 'I1 I6'),
  containsAll('lines.subs.notes', ['n1', 'n2'], 'I1 I6'),
  containsAll('parts.sku', ['A', 'B'], 'I1'),
  containsAll('parts.codes', ['x', 'y'], 'I1 I6'),
  containsAll('parts.codes', ['x', 'z'], 'I6'),
  containsAll('parts.subs.code', ['c1', 'c2'], 'I1 I6'),
  containsAll('shop.tags', ['a', 'b'], 'I1'),
  containsAll('box.shop.tags', ['a', 'b'], 'I1'),
  // The group-level joined scope of a legacy operator: no positive condition matches S4, so shopNE and shopEQ agree.
  joined('shop.tags', ['a'], { admin: 'I1 I2', shopNE: 'I1', shopEQ: 'I1' }),
  joined('shop.slines.sku', ['A', 'B'], 'I1'),
  joined('shop.slines.sku', ['A'], { admin: 'I1 I2', shopNE: 'I1', shopEQ: 'I1' }),
  joined('box.shop.tags', ['a'], { admin: 'I1 I2', shopNE: 'I1', shopEQ: 'I1' }),
  frameCase('Frames', 'ANY', 'reviews', 'tags', 'CONTAINS_ALL', ['x', 'y'], { admin: 'I1 I2 I6', reviewNE: 'I1 I2', reviewEQ: 'I1' }),
  frameCase('Frames', 'NONE', 'reviews', 'tags', 'CONTAINS_ALL', ['x', 'y'], { admin: 'I3 I4 I5 I7 I8', reviewNE: 'I3 I4 I5 I6 I7 I8', reviewEQ: 'I2 I3 I4 I5 I6 I7 I8' }),
  // R4's null list violates; reviewEQ hides R4 instead.
  frameCase('Frames', 'ALL', 'reviews', 'tags', 'CONTAINS_ALL', ['x'], reviewTagsAll),
  // S4's null list violates; shopEQ hides S4, so only admin and shopNE reach it.
  frameCase('Frames', 'ALL', 'shop', 'tags', 'CONTAINS_ALL', ['a', 'b'], { admin: 'I1 I4 I6 I7 I8', shopNE: 'I1 I2 I4 I6 I7 I8', shopEQ: ALL_ITEMS }),
  {
    name: 'reviews: ALL terms tags CONTAINS_ALL ["x"]',
    bullet: 'Frames',
    operator: 'CONTAINS_ALL',
    args: { reviews: { quantifier: 'ALL', terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] } },
    rows: reviewTagsAll,
  },
  // A hidden shop reads as missing; under ALL it violates, as S3's [] and S4's null list do, and I6 has no shop.
  frameCase('Frames through scoped references', 'ANY', 'reviews', 'item.shop.tags', 'CONTAINS_ALL', ['a'], scopedAny),
  frameCase('Frames through scoped references', 'ANY', 'reviews', 'item.shop.name', 'IIN', ['alpha', 'BETA'], scopedAny),
  frameCase('Frames through scoped references', 'ALL', 'reviews', 'item.shop.tags', 'CONTAINS_ALL', ['a'], scopedAll),
  frameCase('Frames through scoped references', 'ALL', 'reviews', 'item.shop.name', 'IIN', ['alpha', 'BETA'], scopedAll),
  // The rows above give shopTags the admin keys: the shops it hides, S3 ([]) and S4 (null), match none of their
  // predicates. gamma brings in I3 through S3, which shopTags hides inside the scoped join, so I3 drops out, and which
  // shopNE keeps and shopEQ hides, so all four shapes differ here.
  frameCase('Frames through scoped references', 'ANY', 'reviews', 'item.shop.name', 'IIN', ['alpha', 'BETA', 'gamma'], scopedAnyGamma),
  frameCase('Frames through scoped references', 'ANY', 'shop', 'slines.sku', 'CONTAINS_ALL', ['A', 'B'], 'I1'),
  frameCase('Frames through scoped references', 'ANY', 'shop', 'slines.sku', 'CONTAINS_ALL', ['A'], 'I1 I2'),
  frameCase('Empty IIN lists in frames', 'ALL', 'reviews', 'author', 'IIN', [], { admin: 'I4 I7 I8', reviewNE: 'I4 I6 I7 I8', reviewEQ: 'I2 I3 I4 I5 I6 I7 I8' }),
  frameCase('Empty IIN lists in frames', 'NONE', 'reviews', 'author', 'IIN', [], { admin: ALL_ITEMS, reviewNE: ALL_ITEMS, reviewEQ: ALL_ITEMS }),
  iin('name', ['ONE', 'two'], 'I1 I2'),
  iin('name', [], ''),
  iin('tags', ['b'], 'I1 I3 I8'),
  iin('tags', ['$X'], 'I6'),
  iin('emails', ['ana@x.io'], 'I1 I2 I8'),
  iin('dims.label', ['l'], 'I1'),
  iin('dims.codes', ['a'], 'I1 I2'),
  iin('box.tags', ['P'], 'I1 I2 I6'),
  iin('lines.sku', ['b'], 'I1 I3 I8'),
  iin('lines.subs.code', ['C3'], 'I1'),
  iin('parts.sku', ['c'], 'I3'),
  iin('shop.name', ['ALPHA', 'Beta'], { admin: 'I1 I2', shopNE: 'I1', shopEQ: 'I1' }),
  iin('shop.slines.sku', ['b'], { admin: 'I1', shopNE: 'I1', shopEQ: 'I1' }),
  // The legacy multiplying join of IN: one row per distinct matching referenced record.
  iin('parts.shop.name', ['alpha', 'BETA'], partsShop.rows, { counts: partsShop.counts }),
  conditionCase('IIN rows', 'parts.shop.name', 'IN', ['Alpha', 'beta'], partsShop.rows, { counts: partsShop.counts, guard: true }),
  // IIN's implicit ANY frame carries the target scope: reviewEQ hides R3 (ANA) while the client's IIN folds.
  iin('reviews.author', ['ana'], { admin: 'I1 I2', reviewNE: 'I1 I2', reviewEQ: 'I1' }),
  iin('reviews.author', ['HIDDEN'], { admin: 'I6', reviewNE: '', reviewEQ: '' }),
  iin('reviews.author', ['ana', 'Hidden'], { admin: 'I1 I2 I6', reviewNE: 'I1 I2', reviewEQ: 'I1' }),
  frameCase('IIN rows', 'ALL', 'reviews', 'author', 'IIN', ['ana', 'bob'], { admin: 'I1 I2 I4 I7 I8', reviewNE: 'I1 I2 I4 I6 I7 I8', reviewEQ: ALL_ITEMS }),
  // shopTags (Shop find: tags CONTAINS_ALL ["a"]) hides S3 and S4: the shop.name row loses I3. Through box.shop it
  // hides no shop, since S1 and S2 both hold a, so the box.shop.name row returns the admin keys; it pins only that the
  // scope's CONTAINS_ALL is accepted through box.shop (7f12322 rejects it as an unknown operator) and keeps S1, not
  // that the scope applies, which the shopEQ row of box.shop.tags shows.
  conditionCase('Scopes', 'shop.name', 'IIN', ['alpha', 'beta', 'gamma'], { shopTags: 'I1 I2' }),
  conditionCase('Scopes', 'box.shop.name', 'EQ', 'Alpha', { shopTags: 'I1' }),
  // fillClientScopes rejects a scoped reference inside an embedded list inside a frame.
  frameCase('The 403', 'ANY', 'reviews', 'item.parts.shop.name', 'IIN', ['alpha'], 'I1 I3 I6', { forbidden: ['shopNE', 'shopEQ'] }),
];

const KEY = /^I[1-8]$/;
const keysOf = (name, shape, keys) => {
  const list = keys ? keys.split(' ') : [];
  if (list.some((key) => !KEY.test(key)) || list.some((key, index) => index > 0 && key < list[index - 1])) {
    throw new Error(`The list operator case ${name} has keys out of key order or unknown for ${shape}: ${keys}`);
  }
  return list;
};
export const LIST_OPERATOR_CASES = deepFreeze(CASES.map((item) => {
  const rows = typeof item.rows === 'string' ? { admin: item.rows } : item.rows;
  for (const shape of [...Object.keys(rows), ...Object.keys(item.counts ?? {}), ...(item.forbidden ?? [])]) {
    if (!SHAPES.includes(shape)) throw new Error(`The list operator case ${item.name} names an unknown shape ${shape}`);
  }
  return { ...item, rows: Object.fromEntries(Object.entries(rows).map(([shape, keys]) => [shape, keysOf(item.name, shape, keys)])) };
}));
const names = LIST_OPERATOR_CASES.map((item) => item.name);
if (new Set(names).size !== names.length) throw new Error('Two list operator cases share a name');

// The oracle "IIN is the union of IEQ", on the text fixture.
const textFilter = (path, operator, value) => fieldFilter({ field: path, operator, value });
// The path, operator and value of an ITEM_CASES row written as one field filter or term; null for group cases.
const textCondition = ({ args }) => {
  const entries = Object.entries(args);
  if (entries.length !== 1 || ['AND', 'OR'].includes(entries[0][0])) return null;
  const [[head, filter]] = entries;
  if (!filter.terms) return { path: head, operator: filter.operator, value: filter.value };
  if (filter.terms.length !== 1) return null;
  const [term] = filter.terms;
  return { path: `${head}.${term.path}`, operator: term.operator, value: term.value };
};
const union = (lists) => [...new Set(lists.flat())].sort();
const iinItemCase = (path, values, keys) => ({ name: `${path} IIN ${JSON.stringify(values)}`, args: textFilter(path, 'IIN', values), keys });
const itemRows = ITEM_CASES.map((item) => ({ ...textCondition(item), keys: item.keys })).filter((row) => row.operator === 'IEQ');
const itemPaths = [...new Set(itemRows.map((row) => row.path))].map((path) => itemRows.filter((row) => row.path === path));
export const IIN_ITEM_CASES = deepFreeze([
  ...itemRows.map(({ path, value, keys }) => iinItemCase(path, [value], [...keys])),
  ...itemPaths.filter((rows) => rows.length > 1).map((rows) => iinItemCase(rows[0].path, rows.map((row) => row.value), union(rows.map((row) => row.keys)))),
]);

// k29, İ's own PostgreSQL fold, joined FOLDING_CASES with part 4; the fail-first runs load the text fixture as it was
// before, so its IIN row is derived from this copy when FOLDING_CASES lacks it.
const K29 = ['IEQ', WORDS.w13, ['w10', 'w13'], ['w13'], 'İ (U+0130)'];
const foldingRows = [...FOLDING_CASES, ...(FOLDING_CASES.some(([operator, value]) => operator === 'IEQ' && value === K29[1]) ? [] : [K29])]
  .filter(([operator]) => operator === 'IEQ');
const foldingUnion = () => {
  const words = union(foldingRows.map(([, , found]) => found));
  const mongodb = union(foldingRows.map(([, , found, mongo]) => mongo ?? found));
  const differences = [...new Set(foldingRows.filter((row) => row[3]).map((row) => row[4]))];
  const row = ['IIN', foldingRows.map(([, value]) => value), words];
  return JSON.stringify(mongodb) === JSON.stringify(words) ? row : [...row, mongodb, differences.join(', ')];
};
export const IIN_FOLDING_CASES = deepFreeze([
  ...foldingRows.map(([, value, words, ...rest]) => ['IIN', [value], [...words], ...rest.map((item) => (Array.isArray(item) ? [...item] : item))]),
  ...(foldingRows.length > 1 ? [foldingUnion()] : []),
]);

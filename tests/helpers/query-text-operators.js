// The fixture, data and cases of the literal text operators (#108, part 1), shared by the PostgreSQL test and the
// MongoDB/PostgreSQL parity test. Every case names the rows it returns, by key and in key order.
import { GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { createValidatedScalar } from '../../packages/core/src/index.js';

const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
const embedded = { relation: { embedded: true } };

/**
 * Items reach every place a text condition can name: root columns, a validated scalar, a String list, an embedded
 * object and its list (jsonb on PostgreSQL), an embedded list and an embedded object that hold references (owned
 * tables on PostgreSQL), a reference and a collection. The `find` and `get_by_id` scopes add text conditions, and
 * the shop's `find` scope becomes a joined scope for client paths through `shop`.
 */
export const createTextOperatorFixture = () => {
  const Code = createValidatedScalar('QtCode', 'A product code', GraphQLString, () => {});
  const Shop = new GraphQLObjectType({
    name: 'QtShop',
    extensions: { scope: { find: ({ args, context }) => { if (context?.openShopsOnly) args.name = { operator: 'ISTARTS_WITH', value: 'open' }; } } },
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString },
      tags: { type: new GraphQLList(GraphQLString) },
      items: { type: new GraphQLList(Item), extensions: reference('shop') },
    }),
  });
  const Dims = new GraphQLObjectType({ name: 'QtDims', fields: { label: { type: GraphQLString }, codes: { type: new GraphQLList(GraphQLString) } } });
  const Line = new GraphQLObjectType({ name: 'QtLine', fields: { sku: { type: GraphQLString }, notes: { type: new GraphQLList(GraphQLString) } } });
  const Part = new GraphQLObjectType({ name: 'QtPart', fields: () => ({ sku: { type: GraphQLString }, shop: { type: Shop, extensions: reference() } }) });
  const Box = new GraphQLObjectType({ name: 'QtBox', fields: () => ({ label: { type: GraphQLString }, shop: { type: Shop, extensions: reference() } }) });
  const Review = new GraphQLObjectType({
    name: 'QtReview',
    fields: () => ({ id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, author: { type: GraphQLString }, item: { type: Item, extensions: reference('item') } }),
  });
  const prefixed = (context) => ({ field: 'name', operator: 'ISTARTS_WITH', value: context.itemPrefix });
  const Item = new GraphQLObjectType({
    name: 'QtItem',
    extensions: {
      scope: {
        find: ({ args, context }) => { if (context?.itemPrefix != null) args.AND = [...(args.AND || []), { conditions: [prefixed(context)] }]; },
        get_by_id: ({ args, context }) => { if (context?.itemPrefix != null) args.name = { operator: 'ISTARTS_WITH', value: context.itemPrefix }; },
      },
    },
    fields: () => ({
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, name: { type: GraphQLString },
      code: { type: Code }, rank: { type: GraphQLInt }, tags: { type: new GraphQLList(GraphQLString) },
      dims: { type: Dims, extensions: embedded }, lines: { type: new GraphQLList(Line), extensions: embedded },
      parts: { type: new GraphQLList(Part), extensions: embedded }, box: { type: Box, extensions: embedded },
      shop: { type: Shop, extensions: reference('shop') },
      reviews: { type: new GraphQLList(Review), extensions: reference('item') },
    }),
  });
  const Word = new GraphQLObjectType({ name: 'QtWord', fields: { id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, word: { type: GraphQLString } } });
  return { Shop, Dims, Line, Part, Box, Review, Item, Word, embedded: [Dims, Line, Part, Box] };
};

/** Registers the fixture on a runtime: shops, items, reviews and words have list endpoints. */
export const registerTextOperatorFixture = (api, fixture) => {
  for (const type of fixture.embedded) api.addNoEndpointType(type);
  api.connect(null, fixture.Shop, 'qtShop', 'qtShops');
  api.connect(null, fixture.Item, 'qtItem', 'qtItems');
  api.connect(null, fixture.Review, 'qtReview', 'qtReviews');
  api.connect(null, fixture.Word, 'qtWord', 'qtWords');
};

const shops = [
  { key: 'S1', name: 'Open Market', tags: ['Fresh', 'local'] },
  { key: 'S2', name: 'closed DEPOT', tags: ['bulk'] },
  { key: 'S3', name: 'OPEN 24h', tags: [] },
];
const items = (shop) => [
  { key: 'A', name: 'Palermo Soho', code: 'AB-100', rank: 1, tags: ['Red', 'blue'], dims: { label: 'Large Box', codes: ['X-1', 'y-2'] },
    lines: [{ sku: 'SKU-1', notes: ['Fragile'] }, { sku: 'sku-2' }], parts: [{ sku: 'P-1', shop: shop.S1 }], box: { label: 'Top', shop: shop.S1 },
    shop: shop.S1, reviews: { added: [{ key: 'A1', author: 'Ana' }, { key: 'A2', author: 'bob' }] } },
  { key: 'B', name: 'PALERMO hollywood', code: 'ab-200', rank: 2, tags: ['RED'], dims: { label: 'small box' }, lines: [{ sku: 'SKU-3' }],
    parts: [{ sku: 'p-2', shop: shop.S2 }], box: { label: 'bottom', shop: shop.S2 }, shop: shop.S2, reviews: { added: [{ key: 'B1', author: 'ANA maria' }] } },
  { key: 'C', name: '100% off_sale', code: 'CD-1', rank: 1, tags: ['50%', 'a_b'], dims: { label: '%_' }, lines: [{ sku: '%' }], shop: shop.S3 },
  { key: 'D', name: 'a\\b.c*d^e$f(g)', rank: 2, tags: ['.*'], dims: { label: '^$' }, parts: [{ sku: '\\' }] },
  { key: 'E', name: 'Ends with a\n', tags: ['x\n'] },
  { key: 'F', name: '', tags: [''], dims: { label: '' } },
  { key: 'G' },
  { key: 'H', name: 'Éclair', tags: ['ÉTÉ'], lines: [{ sku: 'ÉCLAT' }] },
];
/** Case-folding probes: each word is searched by its other forms (see FOLDING_CASES). */
export const WORDS = {
  w01: 'éclair', w02: 'ÉCLAIR', w03: 'Éclair',
  w04: 'ΟΔΟΣ', w05: 'οδος', w06: 'οδοσ',
  w07: 'STRASSE', w08: 'Straße', w09: 'STRAẞE',
  w10: 'İstanbul', w11: 'istanbul', w12: 'ISTANBUL', w13: 'i̇stanbul',
  w14: 'Kelvin', w15: 'kelvin',
  w16: 'ǅemal', w17: 'ǆemal', w18: 'Ǆemal',
  w19: 'ſun', w20: 'sun', w21: 'SUN',
  w22: 'µm', w23: 'μm', w24: 'Μm',
  w25: 'ƛ', w26: 'Ƛ',
  w27: 'ﬁle', w28: 'file',
  // A capital sigma inside a word, before a space or a full stop, and alone as a final sigma.
  w29: 'ΚΑΣΤΡΟ', w30: 'ΟΔΟΣ ΑΒ', w31: 'ΟΔΟΣ.Α', w32: 'ΟΔΟΣΤΡΩΜΑ', w33: 'ς',
};

/**
 * Seeds the fixture through generated mutations, so that both backends store what their own mutations store.
 * `execute(source, variables)` runs a GraphQL operation and returns its result. Resolves to the IDs by key.
 */
export const seedTextOperatorFixture = async (execute) => {
  const ids = {};
  const run = async (source, input) => {
    const result = await execute(source, { input });
    if (result.errors) throw new Error(`${source}: ${JSON.stringify(result.errors)}`);
    const record = Object.values(result.data)[0];
    ids[record.key] = record.id;
  };
  for (const input of shops) await run('mutation($input:QtShopInput!){addqtShop(input:$input){id key}}', input);
  const shop = Object.fromEntries(shops.map(({ key }) => [key, { id: ids[key] }]));
  for (const input of items(shop)) await run('mutation($input:QtItemInput!){addqtItem(input:$input){id key}}', input);
  for (const [key, word] of Object.entries(WORDS)) await run('mutation($input:QtWordInput!){addqtWord(input:$input){id key}}', { key, word });
  return ids;
};

const argumentType = (name, value) => {
  if (['AND', 'OR'].includes(name)) return '[QLFilterGroup]';
  return value?.terms ? 'QLTypeFilterExpression' : 'QLFilter';
};
/** A list query that passes each filter argument as a variable, sorted by key unless `rest` says otherwise. */
export const listOperation = (endpoint, args, selection = 'key', rest = 'sort:{terms:[{field:"key",order:ASC}]}') => {
  const names = Object.keys(args);
  const declared = names.map((name) => `$${name}:${argumentType(name, args[name])}`).join(',');
  const passed = [...names.map((name) => `${name}:$${name}`), rest].filter(Boolean).join(',');
  return { source: `query${declared ? `(${declared})` : ''}{${endpoint}(${passed}){${selection}}}`, variables: args };
};

const filter = (path, operator, value) => {
  const [head, ...rest] = path.split('.');
  return rest.length ? { [head]: { terms: [{ path: rest.join('.'), operator, value }] } } : { [head]: { operator, value } };
};
const NON_NULL_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'H'];

/**
 * `[path, operator, value, keys]`: the item keys a field filter returns. Group cases name their arguments.
 * Text values are literal, null and missing values never match, and lists and embedded lists match when some
 * element does.
 */
export const ITEM_CASES = [
  ['name', 'ILIKE', 'palermo', ['A', 'B']], ['name', 'ILIKE', 'PALERMO S', ['A']], ['name', 'STARTS_WITH', 'PALERMO', ['B']],
  ['name', 'STARTS_WITH', 'Palermo', ['A']], ['name', 'ISTARTS_WITH', 'palermo', ['A', 'B']], ['name', 'ENDS_WITH', 'Soho', ['A']],
  ['name', 'ENDS_WITH', 'soho', []], ['name', 'IENDS_WITH', 'HOLLYWOOD', ['B']], ['name', 'IEQ', 'palermo soho', ['A']],
  ['name', 'IEQ', 'palermo', []], ['name', 'LIKE', 'Palermo', ['A']], ['name', 'LIKE', 'palermo', []],
  // Literal values: LIKE and regular-expression metacharacters match themselves.
  ['name', 'ILIKE', '%', ['C']], ['name', 'ILIKE', '_', ['C']], ['name', 'ILIKE', '0% O', ['C']], ['name', 'ISTARTS_WITH', '100%', ['C']],
  ['name', 'IENDS_WITH', '_SALE', ['C']], ['name', 'ENDS_WITH', '_sale', ['C']], ['name', 'ILIKE', 'p%o', []], ['name', 'ILIKE', 'p_l', []],
  ['name', 'STARTS_WITH', '_', []], ['name', 'IEQ', '%', []], ['name', 'ISTARTS_WITH', '%', []],
  ['name', 'ILIKE', '\\', ['D']], ['name', 'ILIKE', '.', ['D']], ['name', 'ILIKE', '*', ['D']], ['name', 'ILIKE', '^', ['D']],
  ['name', 'ILIKE', '$', ['D']], ['name', 'ILIKE', '(', ['D']], ['name', 'ILIKE', 'B.C*D^E$F(', ['D']], ['name', 'IEQ', 'A\\B.C*D^E$F(G)', ['D']],
  ['name', 'STARTS_WITH', 'a\\b', ['D']], ['name', 'IENDS_WITH', '(G)', ['D']], ['name', 'ILIKE', 'a.b', []], ['name', 'ISTARTS_WITH', '.', []],
  // A trailing newline is a character like any other: a suffix or a whole value must include it.
  ['name', 'ENDS_WITH', 'a', []], ['name', 'ENDS_WITH', 'a\n', ['E']], ['name', 'IENDS_WITH', 'A', []], ['name', 'IENDS_WITH', 'A\n', ['E']],
  ['name', 'IEQ', 'ends with a', []], ['name', 'IEQ', 'ENDS WITH A\n', ['E']], ['name', 'ILIKE', '\n', ['E']],
  // An empty value matches every non-null string, except for IEQ, which matches only the empty string.
  ['name', 'ILIKE', '', NON_NULL_NAMES], ['name', 'STARTS_WITH', '', NON_NULL_NAMES], ['name', 'ISTARTS_WITH', '', NON_NULL_NAMES],
  ['name', 'ENDS_WITH', '', NON_NULL_NAMES], ['name', 'IENDS_WITH', '', NON_NULL_NAMES], ['name', 'IEQ', '', ['F']],
  ['name', 'ILIKE', 'éCL', ['H']], ['name', 'IEQ', 'ÉCLAIR', ['H']],
  // A validated scalar filters by its base scalar, String.
  ['code', 'ISTARTS_WITH', 'ab-', ['A', 'B']], ['code', 'IEQ', 'cd-1', ['C']], ['code', 'STARTS_WITH', 'AB', ['A']],
  // String lists: some element matches.
  ['tags', 'IEQ', 'red', ['A', 'B']], ['tags', 'ILIKE', 'RE', ['A', 'B']], ['tags', 'STARTS_WITH', 'R', ['A', 'B']], ['tags', 'ENDS_WITH', '%', ['C']],
  ['tags', 'ILIKE', '_', ['C']], ['tags', 'IENDS_WITH', 'été', ['H']], ['tags', 'IEQ', '', ['F']], ['tags', 'ENDS_WITH', '\n', ['E']],
  ['tags', 'ILIKE', '', NON_NULL_NAMES], ['tags', 'ISTARTS_WITH', '.*', ['D']],
  // An embedded object and its String list.
  ['dims.label', 'ISTARTS_WITH', 'large', ['A']], ['dims.label', 'ILIKE', 'BOX', ['A', 'B']], ['dims.label', 'IEQ', '', ['F']],
  ['dims.label', 'ENDS_WITH', '%_', ['C']], ['dims.label', 'ILIKE', '^$', ['D']], ['dims.codes', 'ISTARTS_WITH', 'x', ['A']], ['dims.codes', 'IEQ', 'Y-2', ['A']],
  // An embedded list and the String lists of its items.
  ['lines.sku', 'ISTARTS_WITH', 'sku', ['A', 'B']], ['lines.sku', 'STARTS_WITH', 'SKU', ['A', 'B']], ['lines.sku', 'STARTS_WITH', 'sku', ['A']],
  ['lines.sku', 'IEQ', '%', ['C']], ['lines.sku', 'ILIKE', 'éclat', ['H']], ['lines.notes', 'ILIKE', 'FRAG', ['A']], ['lines.notes', 'IENDS_WITH', 'ILE', ['A']],
  // Embedded values that hold references, and the references inside them.
  ['parts.sku', 'IEQ', 'p-1', ['A']], ['parts.sku', 'ISTARTS_WITH', 'p-', ['A', 'B']], ['parts.sku', 'ENDS_WITH', '\\', ['D']],
  ['parts.shop.name', 'ILIKE', 'open', ['A']], ['parts.shop.name', 'IEQ', 'CLOSED depot', ['B']],
  ['box.label', 'IEQ', 'TOP', ['A']], ['box.label', 'ISTARTS_WITH', 'B', ['B']], ['box.shop.name', 'ISTARTS_WITH', 'OPEN', ['A']],
  // A reference and its String list.
  ['shop.name', 'ILIKE', 'open', ['A', 'C']], ['shop.name', 'ISTARTS_WITH', 'closed', ['B']], ['shop.name', 'ENDS_WITH', 'Market', ['A']],
  ['shop.tags', 'IEQ', 'FRESH', ['A']], ['shop.tags', 'ILIKE', 'UL', ['B']],
  // A collection: each matching child repeats its record, as for every other operator.
  ['reviews.author', 'ISTARTS_WITH', 'ana', ['A', 'B']], ['reviews.author', 'IEQ', 'ana', ['A']], ['reviews.author', 'ILIKE', 'O', ['A']],
  ['reviews.author', 'ILIKE', '', ['A', 'A', 'B']],
].map(([path, operator, value, keys]) => ({ name: `${path} ${operator} ${JSON.stringify(value)}`, args: filter(path, operator, value), keys }));
ITEM_CASES.push(
  { name: 'OR of IEQ and ENDS_WITH', args: { OR: [{ conditions: [{ field: 'name', operator: 'IEQ', value: 'palermo soho' }] }, { conditions: [{ field: 'tags', operator: 'ENDS_WITH', value: '%' }] }] }, keys: ['A', 'C'] },
  { name: 'AND of ISTARTS_WITH and a reference ILIKE', args: { AND: [{ conditions: [{ field: 'name', operator: 'ISTARTS_WITH', value: 'palermo' }, { field: 'shop.name', operator: 'ILIKE', value: 'depot' }] }] }, keys: ['B'] },
  { name: 'nested groups with paths through embedded and owned values', args: { AND: [{ OR: [{ conditions: [{ field: 'dims.codes', operator: 'IEQ', value: 'x-1' }] }, { conditions: [{ field: 'parts.sku', operator: 'ENDS_WITH', value: '\\' }] }] }] }, keys: ['A', 'D'] },
);

/**
 * `[operator, value, postgres, mongodb?, difference?]`: the words each backend returns. Both backends compare under
 * the Unicode simple case mappings, but PostgreSQL applies ICU lower() and MongoDB its regular expressions'
 * case-insensitive matching. A case with `mongodb` pins a documented difference. `postgres` is the default fold;
 * with `foldFinalSigma: true`, PostgreSQL returns MongoDB's words for the differences in FINAL_SIGMA_DIFFERENCES.
 */
export const FOLDING_CASES = [
  ['IEQ', 'ÉCLAIR', ['w01', 'w02', 'w03']], ['ILIKE', 'éCL', ['w01', 'w02', 'w03']],
  ['IEQ', 'straße', ['w08', 'w09']], ['IEQ', 'strasse', ['w07']], ['ILIKE', 'SS', ['w07']],
  ['IEQ', 'istanbul', ['w11', 'w12']], ['IEQ', 'KELVIN', ['w14', 'w15']], ['IEQ', 'ǆemal', ['w16', 'w17', 'w18']],
  ['IEQ', 'ǅEMAL', ['w16', 'w17', 'w18']], ['IEQ', 'file', ['w28']], ['ILIKE', 'fi', ['w28']], ['IEQ', 'ﬁle', ['w27']],
  // ICU lower() keeps these lowercase variants, which MongoDB matches with their usual forms.
  ['IEQ', 'sun', ['w20', 'w21'], ['w19', 'w20', 'w21'], 'ſ (U+017F)'],
  ['IEQ', 'ſun', ['w19'], ['w19', 'w20', 'w21'], 'ſ (U+017F)'],
  ['IEQ', 'μm', ['w23', 'w24'], ['w22', 'w23', 'w24'], 'µ (U+00B5)'],
  // ICU lower() keeps ς apart from σ, and turns a capital sigma that ends a word into ς and any other into σ;
  // MongoDB matches Σ, σ and ς with each other wherever they are, and so does PostgreSQL with foldFinalSigma.
  ['IEQ', 'οδοσ', ['w06'], ['w04', 'w05', 'w06'], 'ς (U+03C2)'],
  ['IEQ', 'ΟΔΟΣ', ['w04', 'w05'], ['w04', 'w05', 'w06'], 'ς (U+03C2)'],
  ['IEQ', 'Σ', [], ['w33'], 'ς (U+03C2)'],
  ['ILIKE', 'Σ', ['w06', 'w29', 'w31', 'w32'], ['w04', 'w05', 'w06', 'w29', 'w30', 'w31', 'w32', 'w33'], 'ς (U+03C2)'],
  // PostgreSQL lowers the value apart from the stored text, so a Σ at an end of the value can lower to the other
  // sigma than the same Σ in the stored text: by default, a case-insensitive operator then misses words that its
  // case-sensitive form returns, even in the same case (STARTS_WITH "ΚΑΣ" finds ΚΑΣΤΡΟ).
  ['ISTARTS_WITH', 'ΚΑΣ', [], ['w29'], 'Σ (U+03A3) at an end of the value'],
  ['ILIKE', 'ΚΑΣ', [], ['w29'], 'Σ (U+03A3) at an end of the value'],
  ['ISTARTS_WITH', 'ΟΔΟΣ', ['w04', 'w05', 'w30'], ['w04', 'w05', 'w06', 'w30', 'w31', 'w32'], 'Σ (U+03A3) at an end of the value'],
  ['ILIKE', 'ΔΟΣ.', [], ['w31'], 'Σ (U+03A3) at an end of the value'],
  ['IENDS_WITH', 'Σ ΑΒ', [], ['w30'], 'Σ (U+03A3) at an end of the value'],
  // A value whose sigma lowers as the stored one does matches on both backends.
  ['IENDS_WITH', 'ος αβ', ['w30']], ['ISTARTS_WITH', 'κασ', ['w29']], ['ISTARTS_WITH', 'ΚΑΣΤ', ['w29']],
  // ICU lowers İ to i followed by U+0307 COMBINING DOT ABOVE; MongoDB matches İ only with itself.
  ['IEQ', 'İSTANBUL', ['w10', 'w13'], ['w10'], 'İ (U+0130)'],
  ['ISTARTS_WITH', 'i', ['w10', 'w11', 'w12', 'w13'], ['w11', 'w12', 'w13'], 'İ (U+0130)'],
];
/**
 * The FOLDING_CASES differences that PostgreSQL's `foldFinalSigma: true` removes: it folds both sides with
 * translate(lower(x COLLATE "und-x-icu"), 'ς', 'σ'), so Σ, σ and ς match each other wherever they are, as on MongoDB.
 */
export const FINAL_SIGMA_DIFFERENCES = new Set(['ς (U+03C2)', 'Σ (U+03A3) at an end of the value']);

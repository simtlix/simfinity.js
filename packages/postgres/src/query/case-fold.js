// The case fold of the case-insensitive text operators (ILIKE, ISTARTS_WITH, IENDS_WITH and IEQ), the shared
// contract of #108 section 3.1: the Unicode simple case foldings that MongoDB's case-insensitive regular expressions
// apply. lower() under ICU's root collation applies them to every script the same way on every server, whatever the
// database's default collation (text paths are `C` columns, under which lower() folds ASCII only), except for the
// lowercase variants below, which it keeps and simple folding maps to another lowercase letter; translate() then
// maps them. lower() also turns a capital sigma that ends a word into ς and any other into σ, and the value is folded
// apart from the stored text, so mapping ς to σ also makes a value fold as it does inside the stored text: a value
// that starts or ends with Σ finds every row that its case-sensitive form finds. The fold is one inline expression,
// without a database function, so it needs no schema object and no migration, and an application index serves the
// operators only on exactly this expression, which caseFoldExpression writes.

/**
 * The one-to-one simple case foldings (CaseFolding.txt, status C) that ICU lower() does not apply and MongoDB 8.0
 * does, found by comparing both over every code point with a case mapping, on PostgreSQL 16.15 with an ICU of Unicode
 * 16 and MongoDB 8.0.32: with them, the two differ only on letters newer than MongoDB's Unicode tables. Changing the
 * list changes every statement and the expression that application indexes must repeat, so it is part of the release
 * contract.
 */
const CASE_FOLD_MAPPINGS = Object.freeze([
  ['\u00B5', '\u03BC'], // MICRO SIGN, GREEK SMALL LETTER MU
  ['\u017F', '\u0073'], // LATIN SMALL LETTER LONG S, LATIN SMALL LETTER S
  ['\u0345', '\u03B9'], // COMBINING GREEK YPOGEGRAMMENI, GREEK SMALL LETTER IOTA
  ['\u03C2', '\u03C3'], // GREEK SMALL LETTER FINAL SIGMA, GREEK SMALL LETTER SIGMA
  ['\u03D0', '\u03B2'], // GREEK BETA SYMBOL, GREEK SMALL LETTER BETA
  ['\u03D1', '\u03B8'], // GREEK THETA SYMBOL, GREEK SMALL LETTER THETA
  ['\u03D5', '\u03C6'], // GREEK PHI SYMBOL, GREEK SMALL LETTER PHI
  ['\u03D6', '\u03C0'], // GREEK PI SYMBOL, GREEK SMALL LETTER PI
  ['\u03F0', '\u03BA'], // GREEK KAPPA SYMBOL, GREEK SMALL LETTER KAPPA
  ['\u03F1', '\u03C1'], // GREEK RHO SYMBOL, GREEK SMALL LETTER RHO
  ['\u03F5', '\u03B5'], // GREEK LUNATE EPSILON SYMBOL, GREEK SMALL LETTER EPSILON
  ['\u1C80', '\u0432'], // CYRILLIC SMALL LETTER ROUNDED VE, CYRILLIC SMALL LETTER VE
  ['\u1C81', '\u0434'], // CYRILLIC SMALL LETTER LONG-LEGGED DE, CYRILLIC SMALL LETTER DE
  ['\u1C82', '\u043E'], // CYRILLIC SMALL LETTER NARROW O, CYRILLIC SMALL LETTER O
  ['\u1C83', '\u0441'], // CYRILLIC SMALL LETTER WIDE ES, CYRILLIC SMALL LETTER ES
  ['\u1C84', '\u0442'], // CYRILLIC SMALL LETTER TALL TE, CYRILLIC SMALL LETTER TE
  ['\u1C85', '\u0442'], // CYRILLIC SMALL LETTER THREE-LEGGED TE, CYRILLIC SMALL LETTER TE
  ['\u1C86', '\u044A'], // CYRILLIC SMALL LETTER TALL HARD SIGN, CYRILLIC SMALL LETTER HARD SIGN
  ['\u1C87', '\u0463'], // CYRILLIC SMALL LETTER TALL YAT, CYRILLIC SMALL LETTER YAT
  ['\u1C88', '\uA64B'], // CYRILLIC SMALL LETTER UNBLENDED UK, CYRILLIC SMALL LETTER MONOGRAPH UK
  ['\u1E9B', '\u1E61'], // LATIN SMALL LETTER LONG S WITH DOT ABOVE, LATIN SMALL LETTER S WITH DOT ABOVE
  ['\u1FBE', '\u03B9'], // GREEK PROSGEGRAMMENI, GREEK SMALL LETTER IOTA
]);

const COLLATION = '"pg_catalog"."und-x-icu"';
// No character of either list is a quote or a backslash, so both are plain string literals.
const FROM = `'${CASE_FOLD_MAPPINGS.map(([from]) => from).join('')}'`;
const TO = `'${CASE_FOLD_MAPPINGS.map(([, to]) => to).join('')}'`;

/**
 * The SQL text that folds `sqlExpression` for the case-insensitive text operators, exactly as the compiler writes it on
 * both sides of each comparison: `translate(lower((<expression>) COLLATE "pg_catalog"."und-x-icu"), '<22 characters>',
 * '<their simple case foldings>')`. Applications build their expression indexes with it, such as
 * `CREATE INDEX ... (${caseFoldExpression('"name"')} text_pattern_ops)`. The expression is trusted SQL, inserted as
 * given: quote identifiers yourself and never pass request input. It goes in parentheses, because COLLATE binds more
 * tightly than `->>` and every other binary operator: without them, `"details" ->> 'label'` would collate only
 * 'label', and an index on that expression would never serve the operators. PostgreSQL keeps no trace of parentheses
 * in the parse tree, so an expression gives the same index expression with or without parentheses of its own.
 */
export const caseFoldExpression = (sqlExpression) => {
  if (typeof sqlExpression !== 'string' || !sqlExpression.trim()) throw new TypeError('caseFoldExpression expects a non-empty SQL expression string');
  return `translate(lower((${sqlExpression}) COLLATE ${COLLATION}), ${FROM}, ${TO})`;
};

// Each statement that folds case contains the list of characters, which a GraphQL name, a generated identifier or a
// compiled literal never contains, since values are bound parameters.
const foldsCase = (statement) => typeof statement?.text === 'string' && statement.text.includes(FROM);
// The errors of statements that fold case, which normalizeDatabaseError reports as unsupported when the database
// cannot evaluate the fold.
const failures = new WeakSet();

/**
 * Records that `error`, which the driver raised for `statement`, comes from a statement that folds case, and returns
 * it unchanged, so that retries and normalization see the driver's own error.
 */
export const markCaseFoldFailure = (statement, error) => {
  if (error !== null && typeof error === 'object' && foldsCase(statement)) failures.add(error);
  return error;
};

/**
 * Whether the database cannot evaluate the fold of a statement that failed: one whose server encoding lacks the
 * characters of the fold (22P05, untranslatable character, such as LATIN1, which fails the statement's text before
 * any row is read, whatever the value), or a server without the ICU collation und-x-icu, built without ICU or with a
 * database encoding that ICU does not support, such as SQL_ASCII (42704, undefined object). Compiled statements
 * cannot raise either code otherwise in a UTF8 database with ICU: the collation is their only object that can be
 * missing, and the database stores no text that UTF8 cannot convert.
 */
export const isCaseFoldUnsupported = (error) => failures.has(error) && ['22P05', '42704'].includes(error.code);

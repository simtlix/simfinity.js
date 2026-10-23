import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackageQuality } from './package-quality.js';
import { packRelease, readReleaseManifest } from './release-packages.js';

// Usage: node scripts/test-packages.js [<release manifest.json>]
// With a manifest, test exactly the archives it names (the release build passes the packing
// job's). Without one, pack the working tree the way a release does.
const [manifestArgument, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length) throw new Error('Usage: node scripts/test-packages.js [<release manifest.json>]');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'simfinity-packages-'));
const run = (command, args, cwd) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
};
// Archives are verified against the manifest hashes before any npm call. The digest the packing
// job recorded, and its commit, only apply to a given manifest: a fresh pack is the working tree.
const releaseArchives = () => {
  let manifestPath;
  let manifest;
  if (manifestArgument) {
    manifestPath = resolve(manifestArgument);
    manifest = readReleaseManifest(manifestPath, { sha256: process.env.SIMFINITY_RELEASE_MANIFEST_SHA256 });
    const commit = process.env.SIMFINITY_RELEASE_COMMIT || run('git', ['rev-parse', 'HEAD'], root).trim();
    if (manifest.commit !== commit) throw new Error(`Release archives were packed from ${manifest.commit}, not the tested source ${commit}`);
  } else {
    manifestPath = join(temporary, 'release', 'manifest.json');
    manifest = packRelease(root, dirname(manifestPath));
  }
  return new Map(manifest.packages.map((item) => [item.name, join(dirname(manifestPath), item.filename)]));
};
const check = (archives, name) => {
  const archive = archives.get(name);
  const files = run('tar', ['-tzf', archive], root).split('\n').filter(Boolean).map((path) => path.replace(/^package\//, ''));
  for (const required of ['types/index.d.ts', 'README.md', 'LICENSE']) {
    assert(files.includes(required), `${name} is missing ${required}`);
  }
  assert(!files.some((path) => path.includes('.superpowers') || path.startsWith('node_modules/')));
  const extracted = mkdtempSync(join(temporary, 'quality-'));
  run('tar', ['-xzf', archive, '-C', extracted], root);
  checkPackageQuality(join(extracted, 'package'));
  console.log(`${name}: package quality 100/100`);
  return archive;
};

// Every QLOperator value, in declaration order: the ten of 3.7.0, then the literal text operators (#108, part 1),
// then the emptiness operators (#108, part 2a). The bundled adapters list the same names in an order of their own,
// so their checks sort both lists.
const LEGACY_OPERATORS = ['EQ', 'LT', 'GT', 'LTE', 'GTE', 'BTW', 'NE', 'IN', 'NIN', 'LIKE'];
const EMPTINESS_OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const QUERY_OPERATORS = [...LEGACY_OPERATORS, 'ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ', ...EMPTINESS_OPERATORS];
const SORTED_OPERATORS = [...QUERY_OPERATORS].sort();

const adapterSource = `const adapter = {
  bind() {},
  prepare() {},
  createModel(type) { return { name: type.name }; },
  castId(value) { return value; },
  async withTransaction(session, callback) { return callback(session || {}); },
  newRecord(model, data) { return { ...data, _id: '1' }; },
  async saveRecord(model, record) { return record; },
  toObject(record) { return record; },
  async getById() { return null; },
  prepareUpdate(set) { return set; },
  async update() { return null; },
  async delete() { return null; },
  async find() { return []; },
  async count() { return 0; },
  async aggregate() { return []; },
  async findChildren() { return []; },
};`;

// The public core subpaths: their value exports, the root namespace whose members they mirror, the
// root types they re-export, and what their default export is. The packed runtime check and the
// TypeScript fixture both read this list, so a declaration that drifts from its module fails one
// of them. A new subpath export needs its declaration and an entry here.
const coreSubpaths = {
  auth: {
    namespace: 'auth',
    values: [
      'ForbiddenError', 'UnauthenticatedError', 'allow', 'anyRule', 'composeRules', 'createAuthError',
      'createAuthMiddleware', 'createAuthPlugin', 'createFieldMiddleware', 'createRule',
      'createRuleFromExpression', 'default', 'deny', 'evaluateExpression', 'isOwner',
      'isPolicyExpression', 'requireAuth', 'requirePermission', 'requireRole', 'resolvePath',
    ],
    types: [
      'AuthPluginOptions', 'AuthRule', 'AuthRuleFunction', 'AuthSchemaPlugin', 'EnvelopSchemaPlugin',
      'PermissionSchema', 'PolicyExpression', 'TypePermissions',
    ],
    errorClasses: ['ForbiddenError', 'UnauthenticatedError'],
    defaultExport: 'namespace',
  },
  'auth/errors': {
    namespace: 'auth',
    values: ['ForbiddenError', 'UnauthenticatedError', 'createAuthError', 'default'],
    types: [],
    errorClasses: ['ForbiddenError', 'UnauthenticatedError'],
    defaultExport: 'pick',
  },
  'auth/expressions': {
    namespace: 'auth',
    values: ['createRuleFromExpression', 'default', 'evaluateExpression', 'isPolicyExpression'],
    types: ['PolicyExpression'],
    defaultExport: 'pick',
    // Low-level helpers that only the runtime default object carries.
    defaultExtras: '{ resolveRef(refPath: string, context: any): unknown; resolveValue(value: unknown, context: any): unknown }',
  },
  'auth/rules': {
    namespace: 'auth',
    values: [
      'allow', 'anyRule', 'composeRules', 'createRule', 'default', 'deny', 'isOwner', 'requireAuth',
      'requirePermission', 'requireRole', 'resolvePath',
    ],
    types: ['AuthRuleFunction'],
    defaultExport: 'pick',
  },
  plugins: {
    namespace: 'plugins',
    values: ['apolloCountPlugin', 'createAuthPlugin', 'default', 'envelopCountPlugin'],
    types: ['AuthPluginOptions', 'AuthSchemaPlugin', 'EnvelopSchemaPlugin', 'PermissionSchema'],
    defaultExport: 'namespace',
  },
  scalars: {
    namespace: 'scalars',
    values: [
      'EmailScalar', 'PositiveFloatScalar', 'PositiveIntScalar', 'URLScalar', 'createBoundedFloatScalar',
      'createBoundedIntScalar', 'createBoundedStringScalar', 'createPatternStringScalar', 'default',
    ],
    types: [],
    defaultExport: 'namespace',
  },
  validators: {
    namespace: 'validators',
    values: [
      'arrayLength', 'dateFormat', 'default', 'email', 'futureDate', 'maxLength', 'numberRange',
      'pattern', 'positive', 'stringLength', 'url',
    ],
    types: ['FieldValidations', 'FieldValidator', 'ItemValidators'],
    defaultExport: 'namespace',
  },
};
const subpathBinding = (subpath) => `${subpath.replace(/\/(\w)/g, (match, letter) => letter.toUpperCase())}Subpath`;
const quotedUnion = (names) => names.map((name) => `'${name}'`).join(' | ');

// The value exports of the core root, pinned both ways: the packed runtime check compares them with
// the module's keys, and the TypeScript fixture with the declared exports. A new root export needs an
// explicit `export` in types/index.d.ts and an entry here.
const coreRootValues = [
  'ForbiddenError', 'InternalServerError', 'QLOperator', 'QLQuantifier', 'QLSort', 'QLValue', 'SimfinityError',
  'UnauthenticatedError', 'auth', 'buildErrorFormatter', 'configureMutationLimits', 'configureQueryLimits',
  'createQueryPlan', 'createRuntime', 'createValidatedScalar', 'describeModels', 'isVirtualField',
  'paginationStages', 'plugins', 'resolveModelPath', 'scalars', 'validators', 'virtualFieldOptions',
];
// MongoDB's legacy deep imports of the core subpaths, which re-export them unchanged, as do their
// sibling declarations.
const mongoLegacySubpaths = {
  'src/auth/index.js': 'auth',
  'src/auth/errors.js': 'auth/errors',
  'src/auth/expressions.js': 'auth/expressions',
  'src/auth/rules.js': 'auth/rules',
  'src/plugins.js': 'plugins',
  'src/scalars.js': 'scalars',
  'src/validators.js': 'validators',
};
const legacyBinding = (path) => `legacy${path.slice(4, -3).replace(/(^|\/)(\w)/g, (match, slash, letter) => letter.toUpperCase())}`;

const coreSource = `import assert from 'node:assert/strict';
  import {
    ForbiddenError,
    InternalServerError,
    QLOperator,
    QLQuantifier,
    QLSort,
    QLValue,
    SimfinityError,
    UnauthenticatedError,
    buildErrorFormatter,
    auth,
    configureMutationLimits,
    configureQueryLimits,
    createQueryPlan,
    createRuntime,
    createValidatedScalar,
    describeModels,
    isVirtualField,
    plugins,
    scalars,
    validators,
    virtualFieldOptions,
  } from '@simtlix/simfinity-core';
  import {
    GraphQLError,
    GraphQLID,
    GraphQLInt,
    GraphQLObjectType,
    GraphQLString,
    graphql,
    graphqlSync,
  } from 'graphql';
  ${adapterSource}
  const type = new GraphQLObjectType({
    name: 'CoreBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const runtime = createRuntime(adapter);
  runtime.connect(null, type, 'coreBook', 'coreBooks');
  assert.equal(runtime.registerQuery, undefined);
  runtime.registerCustomQuery('coreRead', '', null, GraphQLString, (...args) => {
    assert.equal(args.length, 2);
    return args[1].marker;
  });
  runtime.registerView('smokeView', { type, description: 'Core view', where: () => [{ conditions: [{ field: 'title', value: 'a' }] }] });
  const schema = runtime.createSchema(null, null, null, { includedCustomQueries: ['coreRead'] });
  const custom = await graphql({ schema, source: '{ coreRead }', contextValue: { marker: 'core' } });
  assert.equal(custom.errors, undefined);
  assert.equal(custom.data.coreRead, 'core');
  const view = await graphql({ schema, source: '{ smokeView { id } }' });
  assert.equal(view.errors, undefined);
  assert.deepEqual(view.data.smokeView, []);
  const introspection = graphqlSync({
    schema,
    source: '{ __type(name: "__Field") { fields { name } } }',
  });
  assert.equal(introspection.errors, undefined);
  assert(introspection.data.__type.fields.some((field) => field.name === 'extensions'));
  assert.equal(describeModels([]).entities.length, 0);
  assert.equal(isVirtualField({ extensions: { virtual: true } }), true);
  assert.equal(isVirtualField(type.getFields().title), false);
  assert.deepEqual(virtualFieldOptions({ extensions: { virtual: { mcp: 'select' } } }), { mcp: 'select' });
  assert.equal(createValidatedScalar('Count', '', GraphQLInt, () => {}).parseValue(3), 3);
  assert.equal(QLOperator.name, 'QLOperator');
  assert.equal(QLQuantifier.name, 'QLQuantifier');
  assert.deepEqual(QLQuantifier.getValues().map(({ value }) => value), ['ANY', 'ALL', 'NONE']);
  assert.equal(QLSort.name, 'QLSort');
  assert.equal(QLValue.name, 'QLValue');
  const known = new SimfinityError('known', 'KNOWN', 400);
  const formattedKnown = buildErrorFormatter()(known);
  assert(formattedKnown instanceof GraphQLError);
  assert.equal(formattedKnown.originalError, known);
  assert.equal(formattedKnown.toJSON().extensions.code, 'KNOWN');
  const unknown = buildErrorFormatter()(new Error('unknown'));
  assert(unknown.originalError instanceof InternalServerError);
  assert.equal(unknown.originalError.getCause().message, 'unknown');
  assert.equal(unknown.originalError.getStatus(), 500);
  assert.equal(unknown.toJSON().extensions.status, 500);
  assert.equal(JSON.stringify(unknown).includes('cause'), false);
  const invalidQuery = graphqlSync({ schema, source: '{ missing }' });
  assert.equal(buildErrorFormatter()(invalidQuery.errors[0]).toJSON().extensions.code, 'BAD_REQUEST');
  assert.equal(runtime.configureMutationLimits, configureMutationLimits);
  configureMutationLimits({ maxNestedOperations: 10 });
  assert.throws(() => configureMutationLimits({ maxNestedOperations: -1 }), (error) => error.getCode() === 'INVALID_MUTATION_LIMITS');
  assert.throws(() => configureMutationLimits({ maxNestedOperation: 10 }), (error) => error.getCode() === 'INVALID_MUTATION_LIMITS');
  configureMutationLimits();
  const masking = buildErrorFormatter((error) => (error instanceof InternalServerError ? new InternalServerError('Unexpected error') : undefined));
  assert.equal(masking(new Error('secret')).message, 'Unexpected error');
  assert.equal(masking(known).message, 'known');
  assert.equal(typeof auth.createAuthPlugin, 'function');
  assert.equal(typeof validators.email, 'function');
  assert.equal(scalars.EmailScalar.name, 'Email_String');
  assert.equal(typeof plugins.envelopCountPlugin, 'function');
  const subpaths = ${JSON.stringify(Object.fromEntries(Object.entries(coreSubpaths).map(([subpath, { values }]) => [subpath, values])))};
  for (const [subpath, names] of Object.entries(subpaths)) {
    const namespace = await import(\`@simtlix/simfinity-core/\${subpath}\`);
    assert.deepEqual(Object.keys(namespace).sort(), [...names].sort(), subpath);
  }
  for (const [name, namespace] of Object.entries({ auth, plugins, scalars, validators })) {
    assert.equal((await import(\`@simtlix/simfinity-core/\${name}\`)).default, namespace, name);
  }
  // The root error classes are the auth classes, as the declarations say.
  const authErrors = await import('@simtlix/simfinity-core/auth/errors');
  for (const [ErrorClass, name, status] of [[ForbiddenError, 'ForbiddenError', 403], [UnauthenticatedError, 'UnauthenticatedError', 401]]) {
    assert.equal(ErrorClass, auth[name], name);
    assert.equal(authErrors[name], ErrorClass, name);
    assert(new ErrorClass() instanceof SimfinityError, name);
    assert.equal(new ErrorClass().getStatus(), status, name);
  }
  assert.deepEqual(Object.keys(await import('@simtlix/simfinity-core')).sort(), ${JSON.stringify([...coreRootValues].sort())});
  // The text operators: QLOperator lists them, the archive ships the internal module the backends import, and an
  // adapter without queryFeatures gets only the operators of 3.7.0.
  assert.deepEqual(QLOperator.getValues().map((value) => value.name), ${JSON.stringify(QUERY_OPERATORS)});
  const queryOperators = await import('@simtlix/simfinity-core/internal/query-operators');
  assert.deepEqual(queryOperators.QUERY_OPERATORS, ${JSON.stringify(QUERY_OPERATORS)});
  assert.deepEqual([...queryOperators.LEGACY_QUERY_OPERATORS].sort(), ${JSON.stringify([...LEGACY_OPERATORS].sort())});
  assert.equal(queryOperators.validateTextFilterValue('ILIKE', '', 'String'), '');
  assert.throws(() => queryOperators.validateTextFilterValue('ILIKE', 5, 'String'), (error) => error.getCode() === 'INVALID_FILTER_VALUE');
  const unsupported = await graphql({ schema, source: '{ coreBooks(title: { operator: ILIKE, value: "a" }) { id } }' });
  assert.equal(unsupported.errors[0].extensions.code, 'UNSUPPORTED_QUERY');
  assert.equal((await graphql({ schema, source: '{ coreBooks(title: { operator: LIKE, value: "a" }) { id } }' })).errors, undefined);
  assert.throws(() => createRuntime({ ...adapter, queryFeatures: { operators: 'ILIKE' } }), (error) => error.getCode() === 'INVALID_QUERY_FEATURES');
  const textRuntime = createRuntime({ ...adapter, queryFeatures: { operators: QLOperator.getValues().map((value) => value.name) } });
  textRuntime.connect(null, new GraphQLObjectType({ name: 'CoreTextBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } }), 'coreTextBook', 'coreTextBooks');
  const textSchema = textRuntime.createSchema();
  const textResult = await graphql({ schema: textSchema, source: '{ coreTextBooks(title: { operator: ILIKE, value: "a" }) { id } }' });
  assert.equal(textResult.errors, undefined);
  // The emptiness operators: the archive ships their shared rules, an adapter without queryFeatures rejects them
  // before it runs, as one that declares other operators does, and one that declares them gets them without a value.
  assert.deepEqual(queryOperators.EMPTINESS_QUERY_OPERATORS, ${JSON.stringify(EMPTINESS_OPERATORS)});
  assert.equal(queryOperators.isEmptinessOperator('IS_NOT_EMPTY'), true);
  assert.equal(queryOperators.isEmptinessOperator('EQ'), false);
  assert.throws(() => queryOperators.validateEmptinessValue('IS_EMPTY', '', 'title'), (error) => error.getCode() === 'INVALID_FILTER_VALUE');
  for (const operator of ${JSON.stringify(EMPTINESS_OPERATORS)}) {
    const rejected = await graphql({ schema, source: \`{ coreBooks(title: { operator: \${operator} }) { id } }\` });
    assert.equal(rejected.errors[0].extensions.code, 'UNSUPPORTED_QUERY', operator);
    assert.equal(rejected.errors[0].message, \`The database adapter does not support the \${operator} filter operator, used on CoreBook.title\`);
    const accepted = await graphql({ schema: textSchema, source: \`{ coreTextBooks(title: { operator: \${operator} }) { id } }\` });
    assert.equal(accepted.errors, undefined, operator);
    const valued = await graphql({ schema: textSchema, source: \`{ coreTextBooks(title: { operator: \${operator}, value: "" }) { id } }\` });
    assert.equal(valued.errors[0].extensions.code, 'INVALID_FILTER_VALUE', operator);
  }
  const ilikeOnly = createRuntime({ ...adapter, queryFeatures: { operators: ['EQ', 'ILIKE'] } });
  ilikeOnly.connect(null, new GraphQLObjectType({ name: 'CoreIlikeBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } }), 'coreIlikeBook', 'coreIlikeBooks');
  const ilikeResult = await graphql({ schema: ilikeOnly.createSchema(), source: '{ coreIlikeBooks(title: { operator: IS_EMPTY }) { id } }' });
  assert.equal(ilikeResult.errors[0].extensions.code, 'UNSUPPORTED_QUERY');
  // Reference and collection emptiness: the archive ships the shapes and scope paths the backends import; an adapter
  // declares it with queryFeatures.referenceEmptiness, a boolean, and then receives the client's construct with its
  // filled scope marker; one that declares the operators without it keeps UNSUPPORTED_QUERY; and maxReferenceFrames
  // limits the scoped joins and frames of one query field.
  const allOperators = QLOperator.getValues().map((value) => value.name);
  const referenceTypes = (prefix) => {
    const shop = new GraphQLObjectType({ name: \`\${prefix}Shop\`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const book = new GraphQLObjectType({
      name: \`\${prefix}Book\`,
      fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, shop: { type: shop, extensions: { relation: { embedded: false } } } },
    });
    return { shop, book };
  };
  const shapeTypes = referenceTypes('CoreShape');
  const throughShop = queryOperators.describeEmptiness(shapeTypes.book, ['shop', 'name'], { operator: 'IS_EMPTY' });
  assert.deepEqual(throughShop, { rule: 'string', crossings: [{ path: 'shop', target: 'CoreShapeShop' }] });
  assert.deepEqual(queryOperators.emptinessScopePaths(throughShop, 'shop.name'), { joins: ['shop'], frames: [] });
  assert.deepEqual(queryOperators.emptinessScopeTargets(throughShop, 'shop.name'), { shop: 'CoreShapeShop' });
  const atShop = queryOperators.describeEmptiness(shapeTypes.book, ['shop'], { operator: 'IS_EMPTY' });
  assert.deepEqual(atShop, { rule: 'reference', target: 'CoreShapeShop' });
  assert.deepEqual(queryOperators.emptinessScopePaths(atShop, 'shop'), { joins: [], frames: ['shop'] });
  assert.throws(() => queryOperators.describeEmptiness(shapeTypes.book, ['shop'], { operator: 'IS_EMPTY', referenceEmptiness: false }), (error) => error.getCode() === 'UNSUPPORTED_QUERY');
  assert.equal(queryOperators.resolveQueryFeatures(undefined).referenceEmptiness, false);
  assert.equal(queryOperators.resolveQueryFeatures({ operators: [], referenceEmptiness: true }).referenceEmptiness, true);
  // Null and undefined mean false, as the declaration's type allows.
  for (const referenceEmptiness of [null, undefined]) {
    assert.equal(queryOperators.resolveQueryFeatures({ operators: [], referenceEmptiness }).referenceEmptiness, false);
    createRuntime({ ...adapter, queryFeatures: { operators: allOperators, referenceEmptiness } });
  }
  assert.throws(() => createRuntime({ ...adapter, queryFeatures: { operators: allOperators, referenceEmptiness: 'yes' } }), (error) => error.getCode() === 'INVALID_QUERY_FEATURES');
  const reads = [];
  const declared = createRuntime({ ...adapter, queryFeatures: { operators: allOperators, referenceEmptiness: true }, async find(model, type, args) { reads.push(args); return []; } });
  const declaredTypes = referenceTypes('CoreDeclared');
  declared.connect(null, declaredTypes.shop, 'coreDeclaredShop', 'coreDeclaredShops');
  declared.connect(null, declaredTypes.book, 'coreDeclaredBook', 'coreDeclaredBooks');
  const declaredSchema = declared.createSchema();
  const declaredResult = await graphql({ schema: declaredSchema, source: '{ coreDeclaredBooks(shop: { terms: [{ operator: IS_EMPTY }] }) { id } }' });
  assert.equal(declaredResult.errors, undefined);
  // The Shop type has no find scope, so no provenance marker is needed. Inline input keeps its null prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(reads.at(-1).shop)), { terms: [{ operator: 'IS_EMPTY' }] });
  assert.equal(Object.getPrototypeOf(reads.at(-1).shop.terms[0]), null);
  const undeclared = createRuntime({ ...adapter, queryFeatures: { operators: allOperators } });
  const undeclaredTypes = referenceTypes('CoreUndeclared');
  undeclared.connect(null, undeclaredTypes.shop, 'coreUndeclaredShop', 'coreUndeclaredShops');
  undeclared.connect(null, undeclaredTypes.book, 'coreUndeclaredBook', 'coreUndeclaredBooks');
  const undeclaredResult = await graphql({ schema: undeclared.createSchema(), source: '{ coreUndeclaredBooks(shop: { terms: [{ operator: IS_EMPTY }] }) { id } }' });
  assert.equal(undeclaredResult.errors[0].extensions.code, 'UNSUPPORTED_QUERY');
  assert.equal(undeclaredResult.errors[0].message, 'IS_EMPTY on shop ends at the reference shop: the database adapter does not support emptiness through references and collections');
  // A frame on shop and a scoped join through it are two pairs.
  const twoPairs = '{ coreDeclaredBooks(shop: { terms: [{ operator: IS_EMPTY }, { path: "name", operator: IS_EMPTY }] }) { id } }';
  configureQueryLimits({ maxReferenceFrames: 1 });
  assert.equal((await graphql({ schema: declaredSchema, source: twoPairs })).errors[0].extensions.code, 'FILTER_DEPTH_EXCEEDED');
  assert.throws(() => configureQueryLimits({ maxReferenceFrames: 0 }), (error) => error.getCode() === 'INVALID_QUERY_LIMITS');
  configureQueryLimits();
  assert.equal((await graphql({ schema: declaredSchema, source: twoPairs })).errors, undefined);
  // createQueryPlan reads emptiness through references with stored semantics by default, lifts a filled marker into
  // the predicate's scopes, and rejects them with UNSUPPORTED_QUERY when given operators without referenceEmptiness.
  const referenceModels = describeModels([{ gqltype: shapeTypes.shop }, { gqltype: shapeTypes.book }]);
  assert.deepEqual(createQueryPlan(referenceModels, 'CoreShapeBook', { shop: { terms: [{ operator: 'IS_EMPTY' }] } }).where, { kind: 'predicate', path: ['shop'], operator: 'IS_EMPTY', value: null });
  assert.deepEqual(createQueryPlan(referenceModels, 'CoreShapeBook', { shop: { terms: [{ operator: 'IS_EMPTY', __scope: { id: 0, scopes: { shop: { name: { operator: 'EQ', value: 'a' } } } } }] } }).where, {
    kind: 'predicate', path: ['shop'], operator: 'IS_EMPTY', value: null, scopes: { shop: { kind: 'predicate', path: ['name'], operator: 'EQ', value: 'a' } },
  });
  assert.throws(() => createQueryPlan(referenceModels, 'CoreShapeBook', { shop: { terms: [{ operator: 'IS_EMPTY' }] } }, { operators: allOperators }), (error) => error.getCode() === 'UNSUPPORTED_QUERY');
  // Recursive quantified inputs, frame plans and capability/limit validation survive packing.
  assert.equal(queryOperators.resolveQueryFeatures(undefined).quantifiers, false);
  for (const quantifiers of [null, undefined]) assert.equal(queryOperators.resolveQueryFeatures({ operators: [], quantifiers }).quantifiers, false);
  assert.throws(() => createRuntime({ ...adapter, queryFeatures: { operators: allOperators, quantifiers: true } }), (error) => error.getCode() === 'INVALID_QUERY_FEATURES');
  assert.throws(() => createRuntime({ ...adapter, queryFeatures: { operators: allOperators, referenceEmptiness: true, quantifiers: 'yes' } }), (error) => error.getCode() === 'INVALID_QUERY_FEATURES');
  const quantifiedRuntime = createRuntime({ ...adapter, queryFeatures: { operators: allOperators, referenceEmptiness: true, quantifiers: true } });
  const quantifiedTypes = referenceTypes('PackedFrame');
  quantifiedRuntime.connect(null, quantifiedTypes.shop, 'packedFrameShop', 'packedFrameShops');
  quantifiedRuntime.connect(null, quantifiedTypes.book, 'packedFrameBook', 'packedFrameBooks');
  const quantifiedSchema = quantifiedRuntime.createSchema();
  const quantified = await graphql({ schema: quantifiedSchema, source: '{ packedFrameBooks(AND:[{ALL:[{path:"shop",OR:[{conditions:[{field:"name",value:"a"}]},{AND:[{conditions:[{field:"name",value:"b"}]}]}]}]}]){id} }' });
  assert.equal(quantified.errors, undefined);
  const quantifiedFilter = await graphql({ schema: quantifiedSchema, source: '{ packedFrameBooks(shop:{quantifier:ALL,terms:[{path:"name",value:"a"}]}){id} }' });
  assert.equal(quantifiedFilter.errors, undefined);
  assert.deepEqual(createQueryPlan(referenceModels, 'CoreShapeBook', { AND: [{ ALL: [{ path: 'shop', conditions: [{ field: 'name', value: 'a' }] }] }] }).where, {
    kind: 'quantified', quantifier: 'ALL', path: ['shop'], where: { kind: 'predicate', path: ['name'], operator: 'EQ', value: 'a' }, scope: null,
  });
  assert.throws(() => configureQueryLimits({ maxFrameNesting: 0 }), (error) => error.getCode() === 'INVALID_QUERY_LIMITS');
  configureQueryLimits({ maxFrameNesting: 2 }); configureQueryLimits();`;

const sqlSource = `import assert from 'node:assert/strict';
  import { createRequire } from 'node:module';
  import { createSQL, planRelationalSchema } from '@simtlix/simfinity-sql';
  import { describeModels } from '@simtlix/simfinity-core';
  import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
  const require = createRequire(import.meta.url);
  for (const dependency of ['pg', 'mongoose', 'mongodb', '@simtlix/simfinity-postgres', '@simtlix/simfinity-mcp', '@modelcontextprotocol/sdk']) {
    assert.throws(() => require.resolve(dependency), { code: 'MODULE_NOT_FOUND' });
  }
  const book = new GraphQLObjectType({ name: 'SQLBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
  const plan = planRelationalSchema(describeModels([{ gqltype: book }]), { schema: 'recording' });
  assert.deepEqual(plan.requirements, ['transactions']);
  const calls = [];
  const plugin = {
    apiVersion: 1, name: 'recording', displayName: 'Recording', defaultSchema: 'recording', options: {}, capabilities: ['transactions'],
    naming: { validateIdentifier() {}, generatedName: (...parts) => parts.join('__') },
    describeSchema: (logical) => logical,
    compileSchema: () => [],
    async initialize() { return { mode: 'validate', created: [] }; },
    compileQuery(models, description, query) { return { text: query.mode, values: [] }; },
    compileRecord(description, operation) { return { text: operation.kind, values: [] }; },
    values: { createId: () => 'recording-id', castId: String, encodeScalar: (field, value) => value, decodeScalar: (field, value) => value, encodeEmbedded: JSON.stringify },
    driver: {
      assertConfiguration() {}, acquire: async () => ({}), begin() {}, commit() {}, rollback() {}, release() {},
      isRetryable: () => false, normalizeError: (error) => error,
      async query(configuration, statement) { calls.push(statement.text); return { rows: [] }; },
    },
  };
  const api = createSQL({ plugin });
  api.connect(null, book, 'sqlBook', 'sqlBooks');
  assert.equal(api.registerQuery, undefined);
  api.registerCustomQuery('sqlRead', '', undefined, GraphQLString, (...args) => {
    assert.equal(args.length, 2);
    return 'sql';
  });
  api.registerView('smokeView', { type: book, description: 'SQL view', where: () => [{ conditions: [{ field: 'title', value: 'a' }] }] });
  const schema = api.createSchema(null, null, null, { includedCustomQueries: ['sqlRead'] });
  await api.initializeDatabase();
  const result = await graphql({ schema, source: '{ sqlBooks { id title } sqlRead }' });
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data.sqlBooks, []);
  assert.equal(result.data.sqlRead, 'sql');
  assert.deepEqual(calls, ['find']);
  const view = await graphql({ schema, source: '{ smokeView { id } }' });
  assert.equal(view.errors, undefined);
  assert.deepEqual(view.data.smokeView, []);
  assert.deepEqual(calls, ['find', 'find']);
  // A plugin without queryFeatures compiles the operators of 3.7.0; plans reject the others before compileQuery,
  // also in reads that do not go through the runtime.
  const unsupported = await graphql({ schema, source: '{ sqlBooks(title: { operator: ILIKE, value: "a" }) { id } }' });
  assert.equal(unsupported.errors[0].extensions.code, 'UNSUPPORTED_QUERY');
  await assert.rejects(() => api.getModel(book).find({ title: { operator: 'IEQ', value: 'a' } }), (error) => error.getCode() === 'UNSUPPORTED_QUERY');
  for (const operator of ${JSON.stringify(EMPTINESS_OPERATORS)}) {
    const rejected = await graphql({ schema, source: \`{ sqlBooks(title: { operator: \${operator} }) { id } }\` });
    assert.equal(rejected.errors[0].extensions.code, 'UNSUPPORTED_QUERY', operator);
    await assert.rejects(() => api.getModel(book).find({ title: { operator } }), (error) => error.getCode() === 'UNSUPPORTED_QUERY');
  }
  assert.deepEqual(calls, ['find', 'find']);
  assert.throws(() => createSQL({ plugin: { ...plugin, queryFeatures: { operators: [1] } } }), (error) => error.getCode() === 'INVALID_SQL_PLUGIN');
  const textApi = createSQL({ plugin: { ...plugin, queryFeatures: { operators: ${JSON.stringify(QUERY_OPERATORS)} } } });
  const textBook = new GraphQLObjectType({ name: 'SQLTextBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
  textApi.connect(null, textBook, 'sqlTextBook', 'sqlTextBooks');
  const textSchema = textApi.createSchema();
  await textApi.initializeDatabase();
  assert.equal((await graphql({ schema: textSchema, source: '{ sqlTextBooks(title: { operator: ILIKE, value: "a" }) { id } }' })).errors, undefined);
  assert.deepEqual(calls, ['find', 'find', 'find']);
  assert.equal((await graphql({ schema: textSchema, source: '{ sqlTextBooks(title: { operator: IS_EMPTY }) { id } }' })).errors, undefined);
  assert.deepEqual(calls, ['find', 'find', 'find', 'find']);
  // Reference and collection emptiness: a plugin that declares referenceEmptiness receives the client's scopes in its
  // plans; one that declares only the operators keeps UNSUPPORTED_QUERY, also in reads outside the runtime; and the
  // declaration must be a boolean.
  assert.throws(() => createSQL({ plugin: { ...plugin, queryFeatures: { operators: ${JSON.stringify(QUERY_OPERATORS)}, referenceEmptiness: 'yes' } } }), (error) => error.getCode() === 'INVALID_SQL_PLUGIN');
  // Null and undefined mean false, as core's.
  for (const referenceEmptiness of [null, undefined]) createSQL({ plugin: { ...plugin, queryFeatures: { operators: ${JSON.stringify(QUERY_OPERATORS)}, referenceEmptiness } } });
  const plans = [];
  const referenceApi = (prefix, endpoint, referenceEmptiness) => {
    const shop = new GraphQLObjectType({ name: \`\${prefix}Shop\`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const book = new GraphQLObjectType({
      name: \`\${prefix}Book\`,
      fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, shop: { type: shop, extensions: { relation: { embedded: false } } } },
    });
    const instance = createSQL({
      plugin: {
        ...plugin,
        // A reference needs foreign keys.
        capabilities: [...plugin.capabilities, 'foreignKeys', 'deferredForeignKeys'],
        compileQuery(models, description, query) { plans.push(query); return { text: query.mode, values: [] }; },
        queryFeatures: { operators: ${JSON.stringify(QUERY_OPERATORS)}, ...(referenceEmptiness ? { referenceEmptiness } : {}) },
      },
    });
    instance.connect(null, shop, \`\${endpoint}Shop\`, \`\${endpoint}Shops\`);
    instance.connect(null, book, \`\${endpoint}Book\`, \`\${endpoint}Books\`);
    return { instance, book, schema: instance.createSchema() };
  };
  const declared = referenceApi('SQLDeclared', 'sqlDeclared', true);
  await declared.instance.initializeDatabase();
  const declaredResult = await graphql({ schema: declared.schema, source: '{ sqlDeclaredBooks(shop: { terms: [{ operator: IS_EMPTY }] }) { id } }' });
  assert.equal(declaredResult.errors, undefined);
  assert.deepEqual(plans.at(-1).where, { kind: 'predicate', path: ['shop'], operator: 'IS_EMPTY', value: null });
  const undeclared = referenceApi('SQLUndeclared', 'sqlUndeclared', false);
  await undeclared.instance.initializeDatabase();
  const undeclaredResult = await graphql({ schema: undeclared.schema, source: '{ sqlUndeclaredBooks(shop: { terms: [{ operator: IS_EMPTY }] }) { id } }' });
  assert.equal(undeclaredResult.errors[0].extensions.code, 'UNSUPPORTED_QUERY');
  assert.equal(undeclaredResult.errors[0].message, 'IS_EMPTY on shop ends at the reference shop: the database adapter does not support emptiness through references and collections');
  await assert.rejects(() => undeclared.instance.getModel(undeclared.book).find({ shop: { terms: [{ operator: 'IS_EMPTY' }] } }), (error) => error.getCode() === 'UNSUPPORTED_QUERY');
  assert.equal(plans.length, 1);`;

const postgresSource = `import assert from 'node:assert/strict';
  import {
    InternalServerError,
    SimfinityError,
    auth,
    buildErrorFormatter,
    caseFoldExpression,
    compileDatabaseSchema,
    configure,
    connect,
    createPostgres,
    createSchema,
    describeDatabase,
    initializeDatabase,
    postgresPlugin,
    registerCustomQuery,
    registerView,
    plugins,
    scalars,
    validators,
    configureMutationLimits,
  } from '@simtlix/simfinity-postgres';
  import { configureMutationLimits as coreConfigureMutationLimits, createRuntime } from '@simtlix/simfinity-core';
  import { createSQL } from '@simtlix/simfinity-sql';
  import {
    GraphQLID,
    GraphQLObjectType,
    GraphQLString,
    graphql,
    graphqlSync,
  } from 'graphql';
  const result = () => ({ rows: [], rowCount: 0 });
  const pool = {
    async query() { return result(); },
    async connect() {
      return { async query() { return result(); }, release() {} };
    },
  };
  const bookType = new GraphQLObjectType({
    name: 'PostgresBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const api = createPostgres({ pool, schema: 'app' });
  assert.equal(api.auth, auth);
  assert.equal(api.plugins, plugins);
  assert.equal(api.scalars, scalars);
  assert.equal(api.validators, validators);
  assert.equal(api.configureMutationLimits, configureMutationLimits);
  assert.equal(configureMutationLimits, coreConfigureMutationLimits);
  api.connect(null, bookType, 'postgresBook', 'postgresBooks');
  const schema = api.createSchema();
  const beforeReady = await graphql({ schema, source: '{ postgresBooks { id } }' });
  assert.equal(beforeReady.errors[0].extensions.code, 'DATABASE_NOT_INITIALIZED');
  const description = api.describeDatabase();
  const sql = createSQL({ plugin: postgresPlugin({ pool, schema: 'app' }) });
  sql.connect(null, bookType, 'sqlBook', 'sqlBooks');
  sql.createSchema();
  assert.deepEqual(sql.describeDatabase(), description);
  assert.deepEqual([...postgresPlugin().queryFeatures.operators].sort(), ${JSON.stringify(SORTED_OPERATORS)});
  // The declaration names the compileQuery it describes, so a copy that replaces compileQuery compiles the operators
  // of 3.7.0 until it declares its own.
  assert.equal(postgresPlugin().queryFeatures.compileQuery, postgresPlugin().compileQuery);
  const copySql = createSQL({ plugin: { ...postgresPlugin({ pool, schema: 'app' }), compileQuery: (...args) => postgresPlugin().compileQuery(...args) } });
  const copyBook = new GraphQLObjectType({ name: 'CopyPostgresBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
  copySql.connect(null, copyBook, 'copyBook', 'copyBooks');
  const copySchema = copySql.createSchema();
  const copied = await graphql({ schema: copySchema, source: '{ copyBooks(title: { operator: ILIKE, value: "a" }) { id } }' });
  assert.equal(copied.errors[0].extensions.code, 'UNSUPPORTED_QUERY');
  // The plugin declares reference emptiness for its own compileQuery: its plans take emptiness through references, and
  // only reach the uninitialized database; a copy that declares the operators alone, or replaces compileQuery, keeps
  // UNSUPPORTED_QUERY for them before any statement runs.
  assert.equal(postgresPlugin().queryFeatures.referenceEmptiness, true);
  assert.equal(postgresPlugin().queryFeatures.quantifiers, true);
  for (const [prefix, endpoint, plugin, code] of [
    ['PgDeclared', 'pgDeclared', postgresPlugin({ pool, schema: 'app' }), 'DATABASE_NOT_INITIALIZED'],
    ['PgOperators', 'pgOperators', { ...postgresPlugin({ pool, schema: 'app' }), queryFeatures: { operators: postgresPlugin().queryFeatures.operators } }, 'UNSUPPORTED_QUERY'],
    ['PgCopy', 'pgCopy', { ...postgresPlugin({ pool, schema: 'app' }), compileQuery: (...args) => postgresPlugin().compileQuery(...args) }, 'UNSUPPORTED_QUERY'],
  ]) {
    const shop = new GraphQLObjectType({ name: \`\${prefix}Shop\`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const book = new GraphQLObjectType({
      name: \`\${prefix}Book\`,
      fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, shop: { type: shop, extensions: { relation: { embedded: false } } } },
    });
    const sqlApi = createSQL({ plugin });
    sqlApi.connect(null, shop, \`\${endpoint}Shop\`, \`\${endpoint}Shops\`);
    sqlApi.connect(null, book, \`\${endpoint}Book\`, \`\${endpoint}Books\`);
    const reference = await graphql({ schema: sqlApi.createSchema(), source: \`{ \${endpoint}Books(shop: { terms: [{ operator: IS_EMPTY }] }) { id } }\` });
    assert.equal(reference.errors[0].extensions.code, code, prefix);
  }
  // The case fold of ILIKE, ISTARTS_WITH, IENDS_WITH and IEQ, for application indexes.
  const fold = (sql) => \`translate(lower((\${sql}) COLLATE "pg_catalog"."und-x-icu"), '\\u00B5\\u017F\\u0345\\u03C2\\u03D0\\u03D1\\u03D5\\u03D6\\u03F0\\u03F1\\u03F5\\u1C80\\u1C81\\u1C82\\u1C83\\u1C84\\u1C85\\u1C86\\u1C87\\u1C88\\u1E9B\\u1FBE', '\\u03BC\\u0073\\u03B9\\u03C3\\u03B2\\u03B8\\u03C6\\u03C0\\u03BA\\u03C1\\u03B5\\u0432\\u0434\\u043E\\u0441\\u0442\\u0442\\u044A\\u0463\\uA64B\\u1E61\\u03B9')\`;
  assert.equal(caseFoldExpression('"name"'), fold('"name"'));
  assert.equal(caseFoldExpression('"details" ->> \\'label\\''), fold('"details" ->> \\'label\\''));
  assert.throws(() => caseFoldExpression(''), TypeError);
  // A statement that folds case on a database that cannot evaluate the fold, such as LATIN1 (22P05) or one without
  // the ICU collation (42704), fails with UNSUPPORTED_QUERY; the same codes keep their mapping elsewhere.
  const { driver } = postgresPlugin();
  const failing = (code) => ({ async query() { throw Object.assign(new Error('driver'), { code, severity: 'ERROR' }); }, async connect() { throw new Error('offline'); } });
  for (const code of ['22P05', '42704']) {
    const folding = await driver.query({ pool: failing(code) }, { text: \`SELECT \${caseFoldExpression("'a'")}\`, values: [] }).catch((error) => error);
    assert.equal(driver.normalizeError(folding).extensions.code, 'UNSUPPORTED_QUERY');
    const plain = await driver.query({ pool: failing(code) }, { text: 'SELECT 1', values: [] }).catch((error) => error);
    assert.equal(driver.normalizeError(plain).extensions.code, code === '22P05' ? 'INVALID_VALUE' : 'DATABASE_ERROR');
  }
  assert(compileDatabaseSchema(description).some((sql) => sql.startsWith('CREATE TABLE')));
  assert.equal(describeDatabase([{ gqltype: bookType }]).tables.length, 1);
  assert.equal(typeof initializeDatabase, 'function');

  const unprepared = createPostgres({ pool, schema: 'unprepared' });
  await assert.rejects(
    () => unprepared.initializeDatabase(),
    (error) => error.extensions.code === 'SCHEMA_NOT_CREATED',
  );

  const defaultType = new GraphQLObjectType({
    name: 'DefaultPostgresBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  configure({ pool, schema: 'default_app' });
  connect(null, defaultType, 'defaultPostgresBook', 'defaultPostgresBooks');
  assert.equal((await import('@simtlix/simfinity-postgres')).registerQuery, undefined);
  registerCustomQuery('postgresRead', '', null, GraphQLString, (...args) => {
    assert.equal(args.length, 2);
    return 'postgres';
  });
  registerView('smokeView', { type: defaultType, description: 'PostgreSQL view', where: () => [{ conditions: [{ field: 'title', value: 'a' }] }] });
  const defaultSchema = createSchema(null, null, null, { includedCustomQueries: ['postgresRead'] });
  const custom = await graphql({ schema: defaultSchema, source: '{ postgresRead }' });
  assert.equal(custom.errors, undefined);
  assert.equal(custom.data.postgresRead, 'postgres');
  const defaultBeforeReady = await graphql({
    schema: defaultSchema,
    source: '{ defaultPostgresBooks { id } }',
  });
  assert.equal(defaultBeforeReady.errors[0].extensions.code, 'DATABASE_NOT_INITIALIZED');
  const view = await graphql({ schema: defaultSchema, source: '{ smokeView { id } }' });
  assert.equal(view.errors[0].extensions.code, 'DATABASE_NOT_INITIALIZED');

  ${adapterSource}
  const coreType = new GraphQLObjectType({
    name: 'TogetherCoreBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const coreRuntime = createRuntime(adapter);
  coreRuntime.connect(null, coreType, 'togetherCoreBook', 'togetherCoreBooks');
  const coreSchema = coreRuntime.createSchema();
  for (const candidate of [schema, defaultSchema, coreSchema]) {
    const introspection = graphqlSync({
      schema: candidate,
      source: '{ __type(name: "__Field") { fields { name } } }',
    });
    assert.equal(introspection.errors, undefined);
    assert(introspection.data.__type.fields.some((field) => field.name === 'extensions'));
  }
  const formatted = buildErrorFormatter()(new Error('postgres'));
  assert(formatted.originalError instanceof InternalServerError);
  assert(formatted.originalError instanceof SimfinityError);`;

const mongoSource = `import assert from 'node:assert/strict';
  import * as legacyEntry from '@simtlix/simfinity-js/src/index.js';
  import legacyAuth from '@simtlix/simfinity-js/src/auth/index.js';
  import { isOwner as legacyIsOwner } from '@simtlix/simfinity-js/src/auth/rules.js';
  import LegacyError from '@simtlix/simfinity-js/src/errors/simfinity.error.js';
  import legacyMcp from '@simtlix/simfinity-js/src/mcp.js';
  import * as simfinity from '@simtlix/simfinity-js';
  import {
    SimfinityError,
    auth,
    plugins,
    scalars,
    validators,
  } from '@simtlix/simfinity-core';
  import { GraphQLID, GraphQLObjectType, GraphQLString, graphql, graphqlSync } from 'graphql';
  ${adapterSource}
  assert.equal(legacyEntry.connect, simfinity.connect);
  assert.equal(legacyEntry.registerCustomQuery, simfinity.registerCustomQuery);
  assert.equal(legacyEntry.registerView, simfinity.registerView);
  assert.equal(simfinity.registerQuery, undefined);
  assert.equal(legacyAuth, auth);
  assert.equal(legacyIsOwner, auth.isOwner);
  assert.equal(LegacyError, SimfinityError);
  assert.equal(legacyMcp.generateMCPTools, simfinity.generateMCPTools);
  if (simfinity.SimfinityError !== SimfinityError) throw new Error('shared error export failed');
  if (typeof simfinity.connect !== 'function') throw new Error('Mongo exports failed');
  if (typeof simfinity.createMongoAdapter !== 'function') throw new Error('Mongo adapter export failed');
  const { queryFeatures } = simfinity.createMongoAdapter();
  assert.deepEqual([...queryFeatures.operators].sort(), ${JSON.stringify(SORTED_OPERATORS)});
  assert(Object.isFrozen(queryFeatures) && Object.isFrozen(queryFeatures.operators));
  // The adapter declares reference emptiness, and a spread copy keeps the declaration.
  assert.equal(queryFeatures.referenceEmptiness, true);
  assert.equal(queryFeatures.quantifiers, true);
  assert.equal({ ...simfinity.createMongoAdapter() }.queryFeatures.quantifiers, true);
  assert.equal({ ...simfinity.createMongoAdapter() }.queryFeatures.referenceEmptiness, true);
  assert.equal(simfinity.auth, auth);
  assert.equal(simfinity.plugins, plugins);
  assert.equal(simfinity.scalars, scalars);
  assert.equal(simfinity.validators, validators);
  assert.equal(typeof simfinity.generateMCPTools, 'function');
  assert.equal(simfinity.mcp.generateMCPTools, simfinity.generateMCPTools);
  simfinity.registerCustomQuery('mongoRead', '', undefined, GraphQLString, (...args) => {
    assert.equal(args.length, 2);
    return 'mongo';
  });
  // The default runtime connects no type here, so an invalid declaration checks its registerView.
  assert.throws(() => simfinity.registerView('smokeView', {}), (error) => error.getCode() === 'INVALID_VIEW');
  const defaultSchema = simfinity.createSchema([], [], [], { includedCustomQueries: ['mongoRead'] });
  const custom = await graphql({ schema: defaultSchema, source: '{ mongoRead }' });
  assert.equal(custom.errors, undefined);
  assert.equal(custom.data.mongoRead, 'mongo');
  const runtime = simfinity.createRuntime(adapter);
  const type = new GraphQLObjectType({
    name: 'RootRuntimeBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  runtime.connect(null, type, 'rootRuntimeBook', 'rootRuntimeBooks');
  runtime.registerView('smokeView', { type, description: 'MongoDB view', where: () => [{ conditions: [{ field: 'title', value: 'a' }] }] });
  const schema = runtime.createSchema();
  const view = await graphql({ schema, source: '{ smokeView { id } }' });
  assert.equal(view.errors, undefined);
  assert.deepEqual(view.data.smokeView, []);
  const introspection = graphqlSync({
    schema,
    source: '{ __type(name: "__Field") { fields { name } } }',
  });
  assert.equal(introspection.errors, undefined);
  assert(introspection.data.__type.fields.some((field) => field.name === 'extensions'));
  assert(simfinity.buildErrorFormatter()(new Error('root')).originalError instanceof simfinity.InternalServerError);
  assert.equal(simfinity.configureMutationLimits, runtime.configureMutationLimits);
  // The legacy deep imports of the core subpaths re-export them unchanged, as their declarations do.
  const legacySubpaths = ${JSON.stringify(Object.fromEntries(Object.entries(mongoLegacySubpaths).map(([path, subpath]) => [path, [subpath, coreSubpaths[subpath].values]])))};
  for (const [path, [subpath, names]] of Object.entries(legacySubpaths)) {
    const legacy = await import(\`@simtlix/simfinity-js/\${path}\`);
    assert.deepEqual(Object.keys(legacy).sort(), [...names].sort(), path);
    assert.equal(legacy.default, (await import(\`@simtlix/simfinity-core/\${subpath}\`)).default, path);
  }`;

const mcpSource = `import assert from 'node:assert/strict';
  import {
    createMCPServer,
    generateMCPTools,
  } from '@simtlix/simfinity-mcp';
  import {
    GraphQLObjectType,
    GraphQLSchema,
    GraphQLString,
  } from 'graphql';
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { greeting: { type: GraphQLString, resolve: () => 'hello' } },
    }),
  });
  const generated = generateMCPTools(schema);
  assert.deepEqual(generated.tools.map((tool) => tool.name), ['greeting']);
  const result = await generated.callTool('greeting');
  assert.equal(result.structuredContent.greeting, 'hello');
  assert.deepEqual(Object.keys(result.structuredContent), ['greeting']);
  assert.throws(
    () => generateMCPTools(schema, { schemaPlugins: [{ onSchemaChanged() {} }] }),
    (error) => error.getCode() === 'MCP_INVALID_SCHEMA_PLUGIN',
  );
  assert.throws(
    () => generateMCPTools(schema, { toolMiddleware: new Array(1) }),
    (error) => error.getCode() === 'MCP_INVALID_MIDDLEWARE',
  );
  const compact = await generateMCPTools(schema, { textFormat: 'compact', nestedCollections: 'none' }).callTool('greeting');
  assert.equal(compact.content[0].text, '{"greeting":"hello"}');
  for (const options of [{ textFormat: 'json' }, { nestedCollections: 'bounded' }, { toolOverrides: { greeting: { nestedCollections: 'some' } } }]) {
    assert.throws(
      () => generateMCPTools(schema, options),
      (error) => error.getCode() === 'MCP_INVALID_OPTIONS',
    );
  }
  await assert.rejects(
    () => createMCPServer(schema),
    (error) => error.getCode() === 'MCP_SDK_NOT_INSTALLED',
  );`;

const mcpSdkSource = `import assert from 'node:assert/strict';
  import { createMCPServer } from '@simtlix/simfinity-mcp';
  import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { greeting: { type: GraphQLString, resolve: () => 'hello' } },
    }),
  });
  const server = await createMCPServer(schema);
  assert.equal(typeof server.connect, 'function');
  await server.close();`;

const coreTypes = `import {
  InternalServerError,
  QLOperator,
  QLQuantifier,
  QLSort,
  QLValue,
  SimfinityError,
  auth,
  buildErrorFormatter,
  configureMutationLimits,
  configureQueryLimits,
  createQueryPlan,
  createRuntime,
  describeModels,
  isVirtualField,
  plugins,
  scalars,
  validators,
  virtualFieldOptions,
  type AuthRuleFunction,
  type DatabaseAdapter,
  type FieldValidations,
  type MutationLimitsOptions,
  type QLFilterCondition,
  type QLFilterGroup,
  type QLQuantifiedGroup,
  type QLTypeFilterExpression,
  type QueryFeatures,
  type QueryJoins,
  type QueryQuantifier,
  type QueryLimitsOptions,
  type QueryOperator,
  type QueryPredicate,
  type TypeScopes,
  type VirtualFieldDeclaration,
  type VirtualFieldOptions,
} from '@simtlix/simfinity-core';
import {
  GraphQLEnumType,
  GraphQLError,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFormattedError,
} from 'graphql';
type Model = { name: string };
type Session = { active: boolean };
const adapter: DatabaseAdapter<Model, Session> = {
  createModel(type) { return { name: type.name }; },
  castId(value) { return value; },
  async withTransaction(session, callback) { return callback(session ?? { active: true }); },
  newRecord(model, data) { return data; },
  saveRecord(model, record) { return record; },
  toObject(record) { return record; },
  getById() { return null; },
  prepareUpdate(set) { return set; },
  update() { return null; },
  delete() { return null; },
  find() { return []; },
  count() { return 0; },
  aggregate() { return []; },
  findChildren() { return []; },
};
// readByIdIsInert is optional: the literal above compiles without it.
const inertAdapter: DatabaseAdapter<Model, Session> = { ...adapter, readByIdIsInert: (handle: Model) => handle.name !== 'Guarded' };
const inert: boolean | undefined = inertAdapter.readByIdIsInert?.({ name: 'TypedCoreBook' });
// @ts-expect-error readByIdIsInert returns a boolean.
const looseInert: DatabaseAdapter<Model, Session> = { ...adapter, readByIdIsInert: () => 'yes' };
void [inert, looseInert];
// The batched collection members are optional too: the literal above compiles without them.
const batching: DatabaseAdapter<Model, Session> = {
  ...adapter,
  async findChildrenBatch(model, type, connectionField, parentIds, args, options) {
    void [model.name, type.name, connectionField.length, args, options?.context];
    return parentIds.map(() => []);
  },
  batchesChildren(model, type, connectionField) {
    return this.findChildren === adapter.findChildren && model.name.length > 0 && type.name.length > 0 && connectionField.length > 0;
  },
};
const syncBatching: DatabaseAdapter<Model, Session> = { ...adapter, findChildrenBatch: (model, type, field, ids) => ids.map(() => [{ id: 1 }]) };
const lists = batching.findChildrenBatch?.({ name: 'A' }, null as any, 'author', ['a1'], {});
const eligible: boolean | undefined = batching.batchesChildren?.({ name: 'A' }, null as any, 'author');
// @ts-expect-error findChildrenBatch returns arrays.
const loose: DatabaseAdapter<Model, Session> = { ...adapter, findChildrenBatch: () => 'rows' };
// @ts-expect-error findChildrenBatch returns one list per parent ID, not one flat list of records.
const flatLists: DatabaseAdapter<Model, Session> = { ...adapter, findChildrenBatch: () => [{ id: 1 }] };
// @ts-expect-error findChildrenBatch resolves to one list per parent ID, not one flat list of records.
const flatPromise: DatabaseAdapter<Model, Session> = { ...adapter, findChildrenBatch: async () => [{ id: 1 }] };
// @ts-expect-error parentIds is an array.
const wrongIds = batching.findChildrenBatch?.({ name: 'A' }, null as any, 'author', 'a1', {});
// @ts-expect-error batchesChildren is synchronous and returns a boolean.
const asyncPredicate: DatabaseAdapter<Model, Session> = { ...adapter, batchesChildren: async () => true };
void [lists, eligible, loose, flatLists, flatPromise, wrongIds, asyncPredicate, syncBatching, createRuntime(batching)];
// The exact member types, so a declaration that widens to \`any\` or to one flat list fails.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type BatchRead = NonNullable<DatabaseAdapter<Model, Session>['findChildrenBatch']>;
type BatchPredicate = NonNullable<DatabaseAdapter<Model, Session>['batchesChildren']>;
const batchMembers: {
  readParameters: Equals<Parameters<BatchRead>, [model: Model, type: GraphQLObjectType, connectionField: string, parentIds: any[], args: any, options?: { context?: any }]>;
  readResult: Equals<ReturnType<BatchRead>, any[][] | PromiseLike<any[][]>>;
  optionalRead: Equals<typeof lists, any[][] | PromiseLike<any[][]> | undefined>;
  predicateParameters: Equals<Parameters<BatchPredicate>, [model: Model, type: GraphQLObjectType, connectionField: string]>;
  predicateResult: Equals<ReturnType<BatchPredicate>, boolean>;
} = { readParameters: true, readResult: true, optionalRead: true, predicateParameters: true, predicateResult: true };
void batchMembers;
const runtime = createRuntime(adapter);
const type = new GraphQLObjectType({ name: 'TypedCoreBook', fields: { title: { type: GraphQLString } } });
runtime.connect(null, type, 'typedCoreBook', 'typedCoreBooks');
const model: Model | null | undefined = runtime.getModel(type);
const formatted: Error = buildErrorFormatter()(new Error('typed'));
const graphQLError: GraphQLError = buildErrorFormatter((error) => { void error.getCode(); })('any value');
const shape: GraphQLFormattedError = graphQLError.toJSON();
const limits: MutationLimitsOptions = { maxNestedOperations: 100 };
configureMutationLimits(limits);
runtime.configureMutationLimits({ maxNestedOperations: null });
runtime.configureMutationLimits();
// @ts-expect-error The limit is a number or null.
configureMutationLimits({ maxNestedOperations: '100' });
// @ts-expect-error The only option is maxNestedOperations.
configureMutationLimits({ maxNestedOperation: 100 });
const formatError = buildErrorFormatter((error) => {
  if (error instanceof InternalServerError) {
    console.error(error.getCause() ?? error);
    return new InternalServerError('Unexpected error');
  }
  return undefined;
});
const maskedError: GraphQLError = formatError(new Error('typed'));
const tenantScope = ({ args }: { args: Record<string, any> }) => { args.tenantId = { operator: 'EQ', value: 'tenant' }; };
const conditionalScopes: TypeScopes = { find: tenantScope };
if (maskedError.message === 'tenant') conditionalScopes.get_by_id = tenantScope;
const scopes: TypeScopes = { find: ({ args, operation, context }) => { args.tenantId = { operator: 'EQ', value: context?.tenantId ?? operation }; } };
// @ts-expect-error Scope keys are find, get_by_id and aggregate.
const misspelledScopes: TypeScopes = { getById: () => undefined };
const owner: AuthRuleFunction = auth.isOwner((post: { authorId: string }) => post.authorId, (user: { id: string }) => user.id, { userPath: (ctx: { user?: unknown }) => ctx.user });
const roleRule: AuthRuleFunction = auth.requireRole('admin', { rolePath: (user: { profile: { role: string } }) => user.profile.role });
// Readonly role and permission arrays are accepted, as the runtime copies them.
const roles = ['admin', 'editor'] as const;
const readonlyRoles: AuthRuleFunction = auth.requireRole(roles);
const frozenPermissions: AuthRuleFunction = auth.requirePermission(Object.freeze(['series:read']));
const known: SimfinityError = new InternalServerError('known');
const operator: GraphQLEnumType = QLOperator;
const sort: GraphQLInputObjectType = QLSort;
const valueName: string = QLValue.name;
const rule: AuthRuleFunction = auth.requireAuth();
const validations: FieldValidations = validators.email();
const scalarName: string = scalars.EmailScalar.name;
const countPlugin = plugins.envelopCountPlugin();
void [model, formatted, graphQLError, shape, scopes, misspelledScopes, owner, roleRule, known, operator, sort, valueName, rule, validations, scalarName, countPlugin, conditionalScopes];
void [readonlyRoles, frozenPermissions];
// extensions.virtual is true or an options object whose only option is mcp.
const virtualField: VirtualFieldDeclaration = true;
const virtualOptions: VirtualFieldOptions[] = [{}, { mcp: 'tool' }, { mcp: 'select' }, { mcp: false }];
const virtualDeclarations: VirtualFieldDeclaration[] = [virtualField, ...virtualOptions];
// @ts-expect-error extensions.virtual is true or an options object, never false.
const notVirtual: VirtualFieldDeclaration = false;
// @ts-expect-error mcp is 'tool', 'select' or false.
const badMcp: VirtualFieldOptions = { mcp: 'list' };
// @ts-expect-error mcp is the only option.
const unknownOption: VirtualFieldOptions = { batch: () => [] };
void [virtualDeclarations, notVirtual, badMcp, unknownOption];
// Custom adapters skip virtual fields of the GraphQL types they receive.
const storedFieldNames = (type: GraphQLObjectType): string[] => Object.entries(type.getFields())
  .filter(([, field]) => !isVirtualField(field)).map(([name]) => name);
const virtualMode: 'tool' | 'select' | false | undefined = virtualFieldOptions({ extensions: { virtual: true } })?.mcp;
// @ts-expect-error the helpers read a field, not its name.
isVirtualField('busyRanges');
void [storedFieldNames, virtualMode];
// queryFeatures is optional: the 3.7-shaped adapter above compiles without it, and null or undefined mean the same.
const textOperators: readonly QueryOperator[] = ['LIKE', 'ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
const textAdapter: DatabaseAdapter<Model, Session> = { ...adapter, queryFeatures: { operators: ['EQ', ...textOperators] } };
const legacyAdapters: DatabaseAdapter<Model, Session>[] = [{ ...adapter, queryFeatures: null }, { ...adapter, queryFeatures: undefined }];
// Names that this version does not know, such as those of later releases, still compile.
const laterFeatures: QueryFeatures = { operators: Object.freeze(['EQ', 'CONTAINS_ALL']) };
// @ts-expect-error operators is a list of operator names.
const oneOperator: QueryFeatures = { operators: 'ILIKE' };
// @ts-expect-error a declaration is an object with operators, not the list itself.
const bareList: DatabaseAdapter<Model, Session> = { ...adapter, queryFeatures: ['ILIKE'] };
// @ts-expect-error QueryOperator names the QLOperator values only.
const unknownOperator: QueryOperator = 'CONTAINS';
const featureMembers: {
  adapter: Equals<DatabaseAdapter['queryFeatures'], QueryFeatures | null | undefined>;
  operator: Equals<QueryOperator, 'EQ' | 'NE' | 'LT' | 'LTE' | 'GT' | 'GTE' | 'BTW' | 'IN' | 'NIN' | 'LIKE' | 'ILIKE' | 'STARTS_WITH' | 'ISTARTS_WITH' | 'ENDS_WITH' | 'IENDS_WITH' | 'IEQ' | 'IS_EMPTY' | 'IS_NOT_EMPTY'>;
} = { adapter: true, operator: true };
const textPlan = createQueryPlan(describeModels([{ gqltype: type }]), 'TypedCoreBook', { title: { operator: 'ISTARTS_WITH', value: 'a' } }, { mode: 'count', operators: new Set<QueryOperator>(['EQ', 'ISTARTS_WITH']) });
const planOperators = createQueryPlan(describeModels([{ gqltype: type }]), 'TypedCoreBook', {}, { operators: textOperators });
// @ts-expect-error operators is an iterable of operator names.
createQueryPlan(describeModels([{ gqltype: type }]), 'TypedCoreBook', {}, { operators: 5 });
void [textAdapter, legacyAdapters, laterFeatures, oneOperator, bareList, unknownOperator, featureMembers, textPlan.mode, planOperators, createRuntime(textAdapter)];
// Reference and collection emptiness: the declaration, the scopes of a client's emptiness predicate, the plan option and
// the reference frame limit.
const referenceAdapter: DatabaseAdapter<Model, Session> = { ...adapter, queryFeatures: { operators: ['EQ', 'IS_EMPTY', 'IS_NOT_EMPTY'], referenceEmptiness: true } };
const plainFeatures: QueryFeatures = { operators: ['IS_EMPTY'], referenceEmptiness: false };
// Null and undefined mean false.
const nullReference: DatabaseAdapter<Model, Session> = { ...adapter, queryFeatures: { operators: ['IS_EMPTY'], referenceEmptiness: null } };
const undefinedReference: QueryFeatures = { operators: ['IS_EMPTY'], referenceEmptiness: undefined };
// @ts-expect-error referenceEmptiness is a boolean, null or undefined.
const textReference: QueryFeatures = { operators: [], referenceEmptiness: 'yes' };
const scopedPredicate: QueryPredicate = {
  kind: 'predicate', path: ['shop', 'name'], operator: 'IS_EMPTY', value: null,
  scopes: { shop: { kind: 'and', terms: [{ kind: 'predicate', path: ['state'], operator: 'EQ', value: 'OPEN' }] }, 'shop.owner': null },
};
// @ts-expect-error a scope is a predicate or null.
const textScope: QueryPredicate = { kind: 'predicate', path: ['shop'], operator: 'IS_EMPTY', value: null, scopes: { shop: 'state' } };
const scopeCount = (predicate: QueryPredicate | null): number => (predicate?.kind === 'predicate' ? Object.keys(predicate.scopes ?? {}).length : 0);
const referencePlan = createQueryPlan(describeModels([{ gqltype: type }]), 'TypedCoreBook', {}, { operators: textOperators, referenceEmptiness: true });
// @ts-expect-error referenceEmptiness is a boolean.
createQueryPlan(describeModels([{ gqltype: type }]), 'TypedCoreBook', {}, { referenceEmptiness: 'yes' });
const queryLimits: QueryLimitsOptions = { maxPageSize: 100, maxReferenceFrames: 4 };
configureQueryLimits(queryLimits);
runtime.configureQueryLimits({ maxReferenceFrames: 12 });
configureQueryLimits();
// @ts-expect-error maxReferenceFrames is a number.
configureQueryLimits({ maxReferenceFrames: '10' });
// @ts-expect-error The option name is maxReferenceFrames, not maxReferenceFrame.
runtime.configureQueryLimits({ maxReferenceFrame: 10 });
const referenceMembers: {
  feature: Equals<QueryFeatures['referenceEmptiness'], boolean | null | undefined>;
  scopes: Equals<Extract<QueryPredicate, { kind: 'predicate' }>['scopes'], Record<string, QueryPredicate | null> | undefined>;
  limits: Equals<QueryLimitsOptions, { maxPageSize?: number; maxReferenceFrames?: number; maxFrameNesting?: number }>;
  rootLimits: Equals<Parameters<typeof configureQueryLimits>[0], QueryLimitsOptions | undefined>;
  runtimeLimits: Equals<Parameters<typeof runtime.configureQueryLimits>[0], QueryLimitsOptions | undefined>;
} = { feature: true, scopes: true, limits: true, rootLimits: true, runtimeLimits: true };
const quantifierEnum: GraphQLEnumType = QLQuantifier;
const quantifier: QueryQuantifier = 'ALL';
const frameCondition: QLFilterCondition = { field: 'rating', operator: 'GTE', value: 4 };
const quantifiedGroup: QLQuantifiedGroup = {
  path: 'reviews', conditions: [frameCondition],
  ALL: [{ path: 'author', conditions: [{ field: 'name', operator: 'IEQ', value: 'Ada' }] }],
};
const quantifiedFilter: QLFilterGroup = { ANY: [quantifiedGroup], OR: [{ NONE: [{ path: 'reviews' }] }] };
const quantifiedExpression: QLTypeFilterExpression = { quantifier, terms: [{ path: 'rating', operator: 'GTE', value: 4 }] };
const quantifiedFeatures: QueryFeatures = { operators: ['EQ'], referenceEmptiness: true, quantifiers: true };
const nullQuantifiers: QueryFeatures = { operators: [], quantifiers: null };
const undefinedQuantifiers: QueryFeatures = { operators: [], quantifiers: undefined };
const frameJoins: QueryJoins = { author: scopedPredicate, 'author.shop': null };
const quantifiedPredicate: QueryPredicate = {
  kind: 'quantified', quantifier: 'ANY', path: ['reviews'], where: scopedPredicate, scope: null, joins: frameJoins,
};
const anchoredPredicate: QueryPredicate = {
  kind: 'quantified', quantifier: 'NONE', path: ['reviews'], where: null, scope: null, anchor: ['reviews', 'product'],
};
const joinedPredicate: QueryPredicate = { kind: 'predicate', path: ['author', 'name'], operator: 'EQ', value: 'Ada', joins: frameJoins };
createQueryPlan(describeModels([{ gqltype: type }]), 'TypedCoreBook', {}, { quantifiers: true });
configureQueryLimits({ maxFrameNesting: 4 });
runtime.configureQueryLimits({ maxFrameNesting: 2 });
// @ts-expect-error quantified groups require a path.
const missingFramePath: QLQuantifiedGroup = { conditions: [] };
// @ts-expect-error a quantifier is ANY, ALL or NONE.
const invalidQuantifier: QueryQuantifier = 'SOME';
// @ts-expect-error a frame's where is a predicate or null.
const invalidWhere: QueryPredicate = { kind: 'quantified', quantifier: 'ANY', path: ['reviews'], where: 'x', scope: null };
// @ts-expect-error a join scope is a predicate or null.
const invalidJoins: QueryJoins = { author: 'x' };
// @ts-expect-error quantifiers is a boolean, null or undefined.
const invalidQuantifiers: QueryFeatures = { operators: [], quantifiers: 'true' };
// @ts-expect-error the plan option is a boolean.
createQueryPlan(describeModels([{ gqltype: type }]), 'TypedCoreBook', {}, { quantifiers: 'true' });
// @ts-expect-error the nesting limit is a number.
configureQueryLimits({ maxFrameNesting: '3' });
const quantifiedMembers: {
  feature: Equals<QueryFeatures['quantifiers'], boolean | null | undefined>;
  joins: Equals<Extract<QueryPredicate, { kind: 'predicate' }>['joins'], QueryJoins | undefined>;
  frameJoins: Equals<Extract<QueryPredicate, { kind: 'quantified' }>['joins'], QueryJoins | undefined>;
  quantifier: Equals<Extract<QueryPredicate, { kind: 'quantified' }>['quantifier'], QueryQuantifier>;
  where: Equals<Extract<QueryPredicate, { kind: 'quantified' }>['where'], QueryPredicate | null>;
  scope: Equals<Extract<QueryPredicate, { kind: 'quantified' }>['scope'], QueryPredicate | null>;
} = { feature: true, joins: true, frameJoins: true, quantifier: true, where: true, scope: true };
void [quantifierEnum, quantifiedFilter, quantifiedExpression, quantifiedFeatures, nullQuantifiers, undefinedQuantifiers, quantifiedPredicate, anchoredPredicate, joinedPredicate, missingFramePath, invalidQuantifier, invalidWhere, invalidJoins, invalidQuantifiers, quantifiedMembers];
void [referenceAdapter, plainFeatures, nullReference, undefinedReference, textReference, scopedPredicate, textScope, scopeCount(referencePlan.where), queryLimits, referenceMembers, createRuntime(referenceAdapter), createRuntime(nullReference)];`;

// The expected type of a subpath's default export.
const subpathDefaultType = ({ namespace, values, defaultExport, defaultExtras }) => {
  if (defaultExport === 'namespace') return `typeof ${namespace}`;
  const picked = `Pick<typeof ${namespace}, ${quotedUnion(values.filter((name) => name !== 'default'))}>`;
  return defaultExtras ? `${picked} & ${defaultExtras}` : picked;
};

// Every public core subpath, in the import forms the guides use: namespace, named, default and type
// imports. Each value and type export must have exactly the type of the root member it mirrors, so a
// declaration that drifts or degrades to \`any\` fails, and the key records fail on a missing or an
// extra declared export.
const coreSubpathTypes = `${Object.keys(coreSubpaths).map((subpath) => (
  `import * as ${subpathBinding(subpath)} from '@simtlix/simfinity-core/${subpath}';`
)).join('\n')}
import type * as Core from '@simtlix/simfinity-core';
import { SimfinityError, auth, plugins, scalars, validators } from '@simtlix/simfinity-core';
import authDefault, {
  ForbiddenError,
  UnauthenticatedError,
  allow,
  createAuthPlugin,
  requireAuth,
  requirePermission,
  requireRole,
  type AuthRuleFunction,
  type PermissionSchema,
} from '@simtlix/simfinity-core/auth';
import errors, { createAuthError } from '@simtlix/simfinity-core/auth/errors';
import expressions, { createRuleFromExpression, type PolicyExpression } from '@simtlix/simfinity-core/auth/expressions';
import rules, { isOwner } from '@simtlix/simfinity-core/auth/rules';
import pluginsDefault, { envelopCountPlugin, type EnvelopSchemaPlugin } from '@simtlix/simfinity-core/plugins';
import scalarsDefault, { EmailScalar, createBoundedIntScalar } from '@simtlix/simfinity-core/scalars';
import validatorsDefault, {
  arrayLength,
  email,
  maxLength,
  numberRange,
  type FieldValidations,
  type ItemValidators,
} from '@simtlix/simfinity-core/validators';
import type { GraphQLScalarType } from 'graphql';
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
${Object.entries(coreSubpaths).map(([subpath, config]) => {
    const binding = subpathBinding(subpath);
    const { namespace, values, types, errorClasses = [] } = config;
    const members = values.filter((name) => name !== 'default');
    return [
      `const ${binding}Keys: Record<keyof typeof ${binding}, true> = { ${values.map((name) => `${name}: true`).join(', ')} };`,
      `const ${binding}Values: {`,
      ...members.map((name) => `  ${name}: Equals<typeof ${binding}.${name}, typeof ${namespace}.${name}>;`),
      `  default: Equals<typeof ${binding}.default, ${subpathDefaultType(config)}>;`,
      `} = { ${[...members, 'default'].map((name) => `${name}: true`).join(', ')} };`,
      `const ${binding}Types: {`,
      ...types.map((name) => `  ${name}: Equals<${binding}.${name}, Core.${name}>;`),
      ...errorClasses.map((name) => `  ${name}: Equals<${binding}.${name}, InstanceType<typeof auth.${name}>>;`),
      `} = { ${[...types, ...errorClasses].map((name) => `${name}: true`).join(', ')} };`,
    ].join('\n');
  }).join('\n')}
const sameAuth: typeof auth = authDefault;
const samePlugins: typeof plugins = pluginsDefault;
const sameScalars: typeof scalars = scalarsDefault;
const sameValidators: typeof validators = validatorsDefault;
const errorFactory: typeof auth.createAuthError = errors.createAuthError;
const roleFactory: typeof auth.requireRole = rules.requireRole;
const referenced: unknown = expressions.resolveRef('ctx.user.id', { ctx: {} });
const permissions: PermissionSchema = { RootQueryType: { serie: requireAuth(), series: authSubpath.requireRole('editor') }, Serie: { '*': allow() } };
const authPlugin: EnvelopSchemaPlugin = createAuthPlugin(permissions, { defaultPolicy: 'DENY' });
const roles = ['admin', 'editor'] as const;
const readonlyRoles: AuthRuleFunction = requireRole(roles);
const frozenPermissions: AuthRuleFunction = requirePermission(Object.freeze(['series:read']));
const ownerRule: AuthRuleFunction = isOwner('authorId');
const policyRule: AuthRuleFunction = createRuleFromExpression({ eq: [{ ref: 'ctx.user.role' }, 'admin'] } satisfies PolicyExpression);
const forbidden: ForbiddenError = new ForbiddenError('denied');
const unauthenticated: SimfinityError = new UnauthenticatedError();
class TenantForbidden extends ForbiddenError {}
const caught: unknown = new TenantForbidden();
const isForbidden: boolean = caught instanceof ForbiddenError && caught.getStatus() === 403;
const authError: SimfinityError = createAuthError('nope', 'UNAUTHENTICATED');
const rating: GraphQLScalarType = createBoundedIntScalar('Rating', null, 5);
const emailName: string = EmailScalar.name;
const validations: FieldValidations = email();
const tagRules: ItemValidators = [maxLength('Tag', 20), null];
const tags: FieldValidations = arrayLength('Tags', 10, tagRules);
const range: FieldValidations = numberRange('Rating', null, 5);
const countPlugin = envelopCountPlugin();
// @ts-expect-error A role is a string or an array of strings.
requireRole(42);
// @ts-expect-error The default policy is ALLOW or DENY.
createAuthPlugin({}, { defaultPolicy: 'MAYBE' });
// @ts-expect-error stringLength needs a field name.
validatorsSubpath.stringLength();
// @ts-expect-error A bounded scalar needs a name.
scalarsSubpath.createBoundedStringScalar();
// @ts-expect-error A count plugin takes no options.
pluginsSubpath.apolloCountPlugin({});
// @ts-expect-error An owner field is a path or an extractor.
authRulesSubpath.isOwner(42);
// @ts-expect-error resolveRef is only a member of the default object.
void authExpressionsSubpath.resolveRef;
void [${Object.keys(coreSubpaths).flatMap((subpath) => ['Keys', 'Values', 'Types'].map((suffix) => `${subpathBinding(subpath)}${suffix}`)).join(', ')}];
void [sameAuth, samePlugins, sameScalars, sameValidators, errorFactory, roleFactory, referenced, authPlugin, readonlyRoles, frozenPermissions];
void [ownerRule, policyRule, forbidden, unauthenticated, isForbidden, authError, rating, emailName, validations, tags, range, countPlugin];`;

// The core root: the declared value exports match the pinned list both ways, and the root error
// classes are the auth classes, so the root, /auth and /auth/errors can be re-exported together.
const coreRootTypes = `import * as CoreRoot from '@simtlix/simfinity-core';
import { ForbiddenError, SimfinityError, UnauthenticatedError, auth } from '@simtlix/simfinity-core';
import * as authErrors from '@simtlix/simfinity-core/auth/errors';
export * from '@simtlix/simfinity-core';
export * from '@simtlix/simfinity-core/auth';
export * from '@simtlix/simfinity-core/auth/errors';
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const coreRootKeys: Record<keyof typeof CoreRoot, true> = { ${coreRootValues.map((name) => `${name}: true`).join(', ')} };
const rootErrorClasses: {
${['ForbiddenError', 'UnauthenticatedError'].map((name) => [
    `  ${name}: Equals<typeof ${name}, typeof auth.${name}>;`,
    `  ${name}Instance: Equals<${name}, InstanceType<typeof auth.${name}>>;`,
    `  ${name}Subpath: Equals<typeof authErrors.${name}, typeof ${name}>;`,
  ].join('\n')).join('\n')}
} = { ${['ForbiddenError', 'UnauthenticatedError'].flatMap((name) => [name, `${name}Instance`, `${name}Subpath`]).map((name) => `${name}: true`).join(', ')} };
class TenantForbidden extends ForbiddenError {}
const denied: SimfinityError = new TenantForbidden('denied');
const anonymous: UnauthenticatedError = new UnauthenticatedError();
const caught: unknown = denied;
const isForbidden: boolean = caught instanceof ForbiddenError && caught.getStatus() === 403;
// @ts-expect-error The message is a string.
new ForbiddenError(403);
void [coreRootKeys, rootErrorClasses, anonymous, isForbidden];`;

// /auth and /plugins export the same createAuthPlugin binding, which both declarations share, so the
// two subpaths can be re-exported together.
const coreAuthPluginsTypes = `import { auth, plugins } from '@simtlix/simfinity-core';
import * as authSubpath from '@simtlix/simfinity-core/auth';
import * as pluginsSubpath from '@simtlix/simfinity-core/plugins';
export * from '@simtlix/simfinity-core/auth';
export * from '@simtlix/simfinity-core/plugins';
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const sharedAuthPlugin: {
  auth: Equals<typeof authSubpath.createAuthPlugin, typeof auth.createAuthPlugin>;
  plugins: Equals<typeof pluginsSubpath.createAuthPlugin, typeof plugins.createAuthPlugin>;
  same: Equals<typeof pluginsSubpath.createAuthPlugin, typeof authSubpath.createAuthPlugin>;
} = { auth: true, plugins: true, same: true };
void sharedAuthPlugin;`;

// EnvelopSchemaPlugin has one declaration, core's, which every package exports. Its hook may return a
// promise, which MCP awaits; createAuthPlugin returns AuthSchemaPlugin, an EnvelopSchemaPlugin whose
// hook returns nothing. Needs Core (the root types), auth, plugins and GraphQLSchema in scope.
const envelopSchemaPluginShape = `type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type SchemaHook = NonNullable<Core.EnvelopSchemaPlugin['onSchemaChange']>;
type AuthSchemaHook = NonNullable<Core.AuthSchemaPlugin['onSchemaChange']>;
const schemaPluginShape: {
  payload: Equals<Parameters<SchemaHook>, [{ schema: GraphQLSchema; replaceSchema: (schema: GraphQLSchema) => void }]>;
  result: Equals<ReturnType<SchemaHook>, void | Promise<void>>;
  authPayload: Equals<Parameters<AuthSchemaHook>, Parameters<SchemaHook>>;
  authResult: Equals<ReturnType<AuthSchemaHook>, void>;
  authPlugin: Equals<ReturnType<typeof auth.createAuthPlugin>, Core.AuthSchemaPlugin>;
  pluginsAuthPlugin: Equals<ReturnType<typeof plugins.createAuthPlugin>, Core.AuthSchemaPlugin>;
} = { payload: true, result: true, authPayload: true, authResult: true, authPlugin: true, pluginsAuthPlugin: true };
declare const schemaPayload: Parameters<SchemaHook>[0];
// The auth plugin is an EnvelopSchemaPlugin, and calling its hook yields no promise.
const authAsEnvelop: Core.EnvelopSchemaPlugin = auth.createAuthPlugin({});
const installed: void | undefined = plugins.createAuthPlugin({}).onSchemaChange?.(schemaPayload);
const asyncPlugin: Core.EnvelopSchemaPlugin = { async onSchemaChange({ schema }) { void schema; } };
// @ts-expect-error onSchemaChange returns nothing or a promise; a returned schema would be discarded.
const discarded: Core.EnvelopSchemaPlugin = { onSchemaChange: ({ schema }) => schema };
// The upgrade notes' call-site and class breaks: a core-typed hook's result is not void, so call it as a
// statement or await it, and a class that implements the interface cannot return a value from it.
declare const corePlugin: Core.EnvelopSchemaPlugin;
// @ts-expect-error The hook may return a promise, so its result does not fit a void sink.
const voidResult: void = corePlugin.onSchemaChange?.(schemaPayload);
const installAll = async (list: Core.EnvelopSchemaPlugin[]) => { for (const each of list) await each.onSchemaChange?.(schemaPayload); };
class Tracker implements Core.EnvelopSchemaPlugin {
  [key: string]: unknown;
  readonly seen = new Set<GraphQLSchema>();
  // @ts-expect-error A class that implements EnvelopSchemaPlugin cannot return a value from its hook.
  onSchemaChange = ({ schema }: Parameters<SchemaHook>[0]) => this.seen.add(schema);
}
void [schemaPluginShape, authAsEnvelop, installed, asyncPlugin, discarded, voidResult, installAll, Tracker];`;

// Core's own consumer: the shape under every module resolution.
const coreSchemaPluginTypes = `import type * as Core from '@simtlix/simfinity-core';
import { auth, plugins } from '@simtlix/simfinity-core';
import type { GraphQLSchema } from 'graphql';
${envelopSchemaPluginShape}`;

// MCP re-exports core's EnvelopSchemaPlugin declaration, so \`export *\` of the MCP package together
// with the core root, /auth and /plugins exports one EnvelopSchemaPlugin instead of reporting TS2308.
const mcpBarrelTypes = `import type * as Core from '@simtlix/simfinity-core';
import type * as Mcp from '@simtlix/simfinity-mcp';
import { auth, plugins } from '@simtlix/simfinity-core';
import type { GraphQLSchema } from 'graphql';
export * from '@simtlix/simfinity-mcp';
export * from '@simtlix/simfinity-core';
export * from '@simtlix/simfinity-core/auth';
export * from '@simtlix/simfinity-core/plugins';
${envelopSchemaPluginShape}
const oneEnvelopSchemaPlugin: Equals<Mcp.EnvelopSchemaPlugin, Core.EnvelopSchemaPlugin> = true;
void oneEnvelopSchemaPlugin;`;

// The database package roots re-export core's declarations, so they can be re-exported together with
// core's /auth and /plugins.
const databaseBarrelTypes = (name) => `import type * as Core from '@simtlix/simfinity-core';
import type * as Database from '${name}';
export * from '${name}';
export * from '@simtlix/simfinity-core/auth';
export * from '@simtlix/simfinity-core/plugins';
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const sameSchemaPlugins: {
  envelop: Equals<Database.EnvelopSchemaPlugin, Core.EnvelopSchemaPlugin>;
  auth: Equals<Database.AuthSchemaPlugin, Core.AuthSchemaPlugin>;
  createAuthPlugin: Equals<ReturnType<typeof Database.auth.createAuthPlugin>, Core.AuthSchemaPlugin>;
} = { envelop: true, auth: true, createAuthPlugin: true };
void sameSchemaPlugins;`;

const sqlTypes = `import {
  createSQL,
  planRelationalSchema,
  type SQLCapability,
  type SQLChildrenQueryCompiler,
  type SQLChildrenStatement,
  type SQLCompiledQuery,
  type SQLConfiguration,
  type SQLDatabaseDescription,
  type SQLFieldDescription,
  type SQLInsertManyOperation,
  type SQLModelDescription,
  type SQLPlugin,
  type SQLQueryFeatures,
  type SQLRecordOperation,
  type SQLStatement,
  type MutationLimitsOptions,
  type TypeScopes,
  type ItemValidators,
  type VirtualFieldDeclaration,
  type VirtualFieldOptions,
  validators,
} from '@simtlix/simfinity-sql';
import {
  describeModels,
  type ItemValidators as CoreItemValidators,
  type QueryFeatures as CoreQueryFeatures,
  type QueryPlan,
  type VirtualFieldDeclaration as CoreVirtualFieldDeclaration,
  type VirtualFieldOptions as CoreVirtualFieldOptions,
} from '@simtlix/simfinity-core';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
type Configuration = { schema: string; token: string };
type Client = { active: boolean };
type Description = SQLDatabaseDescription & { dialect: 'recording' };
const book = new GraphQLObjectType({ name: 'TypedSQLBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
const plan = planRelationalSchema(describeModels([{ gqltype: book }]));
const capability: SQLCapability = plan.requirements[0];
const scalar: string = plan.tables[0].columns[0].scalar;
const logical = plan.tables[0];
// @ts-expect-error Physical column types do not belong to the relational plan.
logical.columns[0].type;
const plugin: SQLPlugin<Configuration, Client, Description> = {
  apiVersion: 1, name: 'recording', displayName: 'Recording', defaultSchema: 'recording',
  options: { schema: 'recording', token: 'test' }, capabilities: ['transactions'],
  naming: { validateIdentifier(value) { if (!value) throw new Error('empty'); }, generatedName: (...parts) => parts.join('__') },
  describeSchema(logicalPlan) {
    return { schema: logicalPlan.schema, dialect: 'recording', tables: logicalPlan.tables.map((table) => ({ ...table, columns: table.columns.map((column) => ({ name: column.name, presenceColumn: column.presenceColumn })) })) };
  },
  compileSchema(description) { return [description.dialect]; },
  async initialize(configuration, description, options) { return { mode: options?.mode ?? 'validate', created: [configuration.schema, description.dialect] }; },
  compileQuery(models, description, query, extra) {
    const metadata: SQLModelDescription = models;
    const field: SQLFieldDescription = metadata.entities[0].fields[0];
    const stateNames: string[] | undefined = field.stateNames?.map((state) => state.value + ':' + state.name);
    // @ts-expect-error State storage values have already been converted to strings.
    const numericState: number | undefined = field.stateNames?.[0].value;
    void numericState;
    const nestedStateNames: string[] | undefined = field.fields?.[0].stateNames?.map((state) => state.name);
    return { text: query.mode, values: [stateNames, nestedStateNames, description.dialect, extra?.id], aggregateFields: [field] };
  },
  compileRecord(description, operation): SQLStatement {
    const tableName: string = operation.table.name;
    switch (operation.kind) {
      case 'selectById': return { text: tableName, values: [operation.id, operation.lock] };
      case 'selectOwned': return { text: tableName, values: [operation.ids, operation.ordered] };
      case 'insert': return { text: tableName, values: Object.values(operation.data) };
      case 'update': return { text: tableName, values: [operation.id, ...Object.values(operation.data)] };
      case 'deleteById': return { text: tableName, values: [operation.id] };
      case 'deleteOwned': return { text: tableName, values: [operation.ownerId] };
      default: { const exhaustive: never = operation; return exhaustive; }
    }
  },
  values: {
    createId: () => 'opaque-id', castId: String,
    encodeScalar(field, value) { return field.stateNames?.find((state) => state.name === value)?.value ?? value; },
    decodeScalar(field, value, gqlField) { return field.stateNames?.find((state) => state.value === value)?.name ?? (gqlField?.name ? value : field.scalar); },
    encodeEmbedded: JSON.stringify,
  },
  driver: {
    assertConfiguration(configuration) { if (!configuration?.token) throw new Error('token'); },
    async acquire(configuration) { return { active: Boolean(configuration.token) }; },
    begin(client) { client.active = true; }, commit(client) { client.active = false; }, rollback(client) { client.active = false; }, release() {},
    isRetryable(error) { return error instanceof Error && error.message === 'aborted'; }, normalizeError: (error) => error,
    async query(configuration, statement, client) { return { rows: [{ token: configuration.token, text: statement.text, active: client?.active }] }; },
  },
};
// Optional members of later releases; the 3.5.9-shaped plugin above keeps compiling without them.
const batchPlugin: SQLPlugin<Configuration, Client, Description> = {
  ...plugin,
  describeSchema(logicalPlan, configuration) {
    const schemaName: string | undefined = configuration?.schema;
    return { ...plugin.describeSchema(logicalPlan), schema: schemaName ?? logicalPlan.schema };
  },
  compileQuery(models, description, query, extra, configuration) {
    const token: string | undefined = configuration?.token;
    return { text: query.mode, values: [token, description.dialect, extra?.id] };
  },
  compileRecordBatch(description, operation: SQLInsertManyOperation<Description['tables'][number]>): SQLStatement {
    const kind: 'insertMany' = operation.kind;
    return { text: kind + ':' + operation.table.name, values: operation.rows.flatMap((row) => Object.values(row)) };
  },
  maxRecordBatchValues: 1000,
};
// A batched children compiler names the compileQuery it reproduces; a 3.6.0-shaped plugin compiles without it.
function compileChildren(models: SQLModelDescription, description: Description, query: QueryPlan, extra: { column: string; ids: string[] }, configuration?: Configuration | null): SQLChildrenStatement {
  return { text: query.mode + ':' + extra.column, values: [configuration?.token, description.dialect, models.entities.length, extra.ids], parentColumn: 'parent' };
}
compileChildren.compileQuery = batchPlugin.compileQuery;
const childrenPlugin: SQLPlugin<Configuration, Client, Description> = { ...batchPlugin, compileChildrenQuery: compileChildren };
const childrenCompiler: SQLChildrenQueryCompiler<Configuration, Description> | undefined = childrenPlugin.compileChildrenQuery;
const pairedQuery = childrenCompiler?.compileQuery;
// The pairing member has exactly the type of the plugin's compileQuery, so retyping it to \`any\` fails.
const pairing: {
  compileQuery: Equals<NonNullable<SQLChildrenQueryCompiler<Configuration, Description>['compileQuery']>, SQLPlugin<Configuration, Client, Description>['compileQuery']>;
  optional: Equals<typeof pairedQuery, SQLPlugin<Configuration, Client, Description>['compileQuery'] | undefined>;
  statement: Equals<ReturnType<SQLChildrenQueryCompiler<Configuration, Description>>, SQLChildrenStatement>;
} = { compileQuery: true, optional: true, statement: true };
// @ts-expect-error compileQuery is a function.
const wrongPair: number | undefined = childrenCompiler?.compileQuery;
void [pairing, wrongPair];
const collections: SQLConfiguration = { schema: 'x', batchedCollections: false };
// @ts-expect-error A batched children statement names its parent column.
const noParentColumn: SQLPlugin<Configuration, Client, Description> = { ...batchPlugin, compileChildrenQuery: () => ({ text: 'children' }) };
// @ts-expect-error compileChildrenQuery is a function.
const notAFunction: SQLPlugin<Configuration, Client, Description> = { ...batchPlugin, compileChildrenQuery: 'SELECT' };
// @ts-expect-error batchedCollections is a boolean.
const badCollections: SQLConfiguration = { batchedCollections: 'no' };
void [childrenPlugin, pairedQuery, collections, noParentColumn, notAFunction, badCollections];
// Optional statements to run before a children statement, in its transaction; a readonly list is accepted.
const setupList: readonly SQLStatement[] = Object.freeze([{ text: 'SET LOCAL jit = off' }, { text: 'SET LOCAL x = 1', values: [] }]);
const withSetup: SQLChildrenStatement = { text: 'children', parentColumn: 'parent', setup: setupList };
const setupType: Equals<SQLChildrenStatement['setup'], readonly SQLStatement[] | null | undefined> = true;
const nullSetup: SQLChildrenStatement = { text: 'children', parentColumn: 'parent', setup: null };
// @ts-expect-error Setup holds statements, not SQL text.
const textSetup: SQLChildrenStatement = { text: 'children', parentColumn: 'parent', setup: ['SET LOCAL jit = off'] };
void [withSetup, setupType, nullSetup, textSetup];
const singleStatement: SQLCapability = 'singleStatementReads';
const sqlConfiguration: SQLConfiguration = { schema: 'x', multiRowInserts: false };
// @ts-expect-error The batch value limit is a number.
const badLimit: Pick<SQLPlugin, 'maxRecordBatchValues'> = { maxRecordBatchValues: '100' };
// @ts-expect-error multiRowInserts is a boolean.
const badInserts: SQLConfiguration = { multiRowInserts: 'no' };
void [batchPlugin, singleStatement, sqlConfiguration, badLimit, badInserts];
declare const compiled: SQLCompiledQuery;
const aggregateStateNames: string[] | undefined = compiled.aggregateFields?.[0].stateNames?.map((state) => state.name);
void aggregateStateNames;
const api = createSQL({ plugin });
const description: Description = api.describeDatabase();
api.configure({ schema: 'recording', token: 'later' });
// @ts-expect-error Runtime configuration preserves the plugin's required fields.
api.configure({ schema: 'missing-token' });
void api.withTransaction(null, async (session) => {
  const active: boolean = session.client.active;
  const result = await session.query('query', [active]);
  const value: unknown = result.rows[0].token;
  return value;
});
const model = api.getModel(book);
void model?.find({ title: { value: 'book' } });
// @ts-expect-error Record operations receive physical table metadata, not a name.
const badOperation: SQLRecordOperation = { kind: 'deleteById', table: 'book', id: 'id' };
// @ts-expect-error Only version 1 is currently supported.
const badPlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, apiVersion: 2 };
const limits: MutationLimitsOptions = { maxNestedOperations: 0 };
api.configureMutationLimits(limits);
const scopes: TypeScopes = { aggregate: async ({ args }) => { args.AND = []; } };
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const itemRules: ItemValidators = [validators.maxLength('Tag', 20), null];
const tagRules = validators.arrayLength('Tags', 10, itemRules);
const sameItemValidators: Equals<ItemValidators, CoreItemValidators> = true;
const sameVirtualTypes: {
  declaration: Equals<VirtualFieldDeclaration, CoreVirtualFieldDeclaration>;
  options: Equals<VirtualFieldOptions, CoreVirtualFieldOptions>;
} = { declaration: true, options: true };
void [capability, scalar, description, badOperation, badPlugin, scopes, itemRules, tagRules, sameItemValidators, sameVirtualTypes];
// queryFeatures is optional: the 3.5.9-shaped plugin above compiles without it, and null or undefined mean the same.
const textPlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: ['EQ', 'LIKE', 'ILIKE', 'IEQ'] } };
const legacyPlugins: SQLPlugin<Configuration, Client, Description>[] = [{ ...plugin, queryFeatures: null }, { ...plugin, queryFeatures: undefined }];
// @ts-expect-error operators lists operator names.
const numericOperators: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: [1] } };
// A declaration may name the compileQuery it describes, as a compileChildrenQuery does.
const tiedPlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: ['EQ', 'ILIKE'], compileQuery: plugin.compileQuery } };
// @ts-expect-error queryFeatures.compileQuery is a compiler.
const badTie: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: ['EQ'], compileQuery: 'compileQuery' } };
const sqlFeatures: Equals<SQLPlugin['queryFeatures'], SQLQueryFeatures | null | undefined> = true;
const sqlCoreFeatures: SQLQueryFeatures extends CoreQueryFeatures ? true : false = true;
void [textPlugin, legacyPlugins, numericOperators, tiedPlugin, badTie, sqlFeatures, sqlCoreFeatures, createSQL({ plugin: textPlugin })];
// Reference and collection emptiness: a plugin declares it next to its operators, and its compileQuery reads the
// scopes of a client's emptiness predicate.
const referencePlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: ['EQ', 'IS_EMPTY'], referenceEmptiness: true, compileQuery: plugin.compileQuery } };
// Null and undefined mean false, as core's.
const nullReferencePlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: ['EQ'], referenceEmptiness: null } };
const undefinedReferencePlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: ['EQ'], referenceEmptiness: undefined } };
// @ts-expect-error referenceEmptiness is a boolean, null or undefined.
const textReferencePlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: [], referenceEmptiness: 'yes' } };
const sqlReference: Equals<SQLQueryFeatures['referenceEmptiness'], boolean | null | undefined> = true;
const sqlQuantifiers: Equals<SQLQueryFeatures['quantifiers'], boolean | null | undefined> = true;
const quantifiedPlugin: SQLPlugin<Configuration, Client, Description> = { ...plugin, queryFeatures: { operators: ['EQ'], referenceEmptiness: true, quantifiers: true, compileQuery: plugin.compileQuery } };
// @ts-expect-error quantifiers is boolean, null or undefined.
const badQuantifiedPlugin: SQLPlugin = { ...plugin, queryFeatures: { operators: [], quantifiers: 'true' } };
void [sqlQuantifiers, quantifiedPlugin, badQuantifiedPlugin];
const scopedPaths = (query: QueryPlan): string[] => (query.where?.kind === 'predicate' ? Object.keys(query.where.scopes ?? {}) : []);
void [referencePlugin, nullReferencePlugin, undefinedReferencePlugin, textReferencePlugin, sqlReference, scopedPaths, createSQL({ plugin: referencePlugin }), createSQL({ plugin: nullReferencePlugin })];`;

const postgresTypes = `import { Pool, type PoolClient } from 'pg';
import { createSQL, type SQLChildrenQueryCompiler, type SQLQueryFeatures, type SQLStatement } from '@simtlix/simfinity-sql';
import {
  auth,
  caseFoldExpression,
  configure,
  connect,
  createPostgres,
  createSchema,
  describeDatabase,
  initializeDatabase,
  postgresPlugin,
  plugins,
  scalars,
  validators,
  configureMutationLimits,
  configureQueryLimits,
  type AuthRuleFunction,
  type DatabaseDescription,
  type DatabaseTrigger,
  type PostgresConfiguration,
  type TypeScopes,
  type InitializationResult,
  type PostgresModel,
  type PostgresRuntime,
  type PostgresSession,
  type DatabaseQueryable,
  type ItemValidators,
  type VirtualFieldDeclaration,
  type VirtualFieldOptions,
} from '@simtlix/simfinity-postgres';
import type {
  ItemValidators as CoreItemValidators,
  QueryFeatures as CoreQueryFeatures,
  VirtualFieldDeclaration as CoreVirtualFieldDeclaration,
  VirtualFieldOptions as CoreVirtualFieldOptions,
} from '@simtlix/simfinity-core';
import { GraphQLObjectType, GraphQLString } from 'graphql';
declare const pool: Pool;
const type = new GraphQLObjectType({ name: 'TypedPostgresBook', fields: { title: { type: GraphQLString } } });
const api: PostgresRuntime = createPostgres({ pool, schema: 'app' });
const sqlApi: PostgresRuntime = createSQL({ plugin: postgresPlugin({ pool, schema: 'app' }) });
const deferred = createSQL({ plugin: postgresPlugin() });
deferred.configure({ pool });
declare const nativeClient: PoolClient;
const queryable: DatabaseQueryable = nativeClient;
const session: PostgresSession = { client: nativeClient, query: nativeClient.query.bind(nativeClient), inTransaction: () => true };
void sqlApi.withTransaction(session, async (transaction) => {
  await transaction.client.query('SELECT $1', [1]);
  return transaction.inTransaction();
});
void sqlApi.getModel(type)?.find({ title: { operator: 'EQ', value: 'typed' }, sort: { terms: [{ field: 'title', order: 'ASC' }] } }, { session });
void api.getModel(type)?.findById('opaque-id', { session });
void queryable;
const rule: AuthRuleFunction = auth.requireAuth();
const email = validators.email();
const scalarName: string = scalars.EmailScalar.name;
const countPlugin = plugins.envelopCountPlugin();
api.connect(null, type, 'typedPostgresBook', 'typedPostgresBooks');
const schema = api.createSchema();
const model: PostgresModel | null | undefined = api.getModel(type);
const ready: Promise<InitializationResult> = api.initializeDatabase({ mode: 'validate' });
const description: DatabaseDescription = api.describeDatabase();
const lowLevel: Promise<InitializationResult> = initializeDatabase(pool, description, { mode: 'validate' });
configure({ pool });
connect(null, type, 'defaultTypedPostgresBook', 'defaultTypedPostgresBooks');
const defaultSchema = createSchema();
const defaultReady: Promise<InitializationResult> = initializeDatabase({ mode: 'validate' });
configureMutationLimits({ maxNestedOperations: 100 });
api.configureMutationLimits();
const scopes: TypeScopes = { get_by_id: ({ args }) => { args.id = { operator: 'EQ', value: args.id?.value }; } };
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const itemRules: ItemValidators = [validators.maxLength('Tag', 20), null];
const tagRules = validators.arrayLength('Tags', 10, itemRules);
const sameItemValidators: Equals<ItemValidators, CoreItemValidators> = true;
const sameVirtualTypes: {
  declaration: Equals<VirtualFieldDeclaration, CoreVirtualFieldDeclaration>;
  options: Equals<VirtualFieldOptions, CoreVirtualFieldOptions>;
} = { declaration: true, options: true };
void sameVirtualTypes;
const pgOptions: PostgresConfiguration = { pool, schema: 'app', multiRowInserts: false, explicitNullsOrder: true };
createPostgres(pgOptions);
createPostgres().configure({ pool, explicitNullsOrder: false, multiRowInserts: true });
const pgPlugin = postgresPlugin(pgOptions);
const batchLimit: number | undefined = pgPlugin.maxRecordBatchValues;
const batchCompiler = pgPlugin.compileRecordBatch;
const collectionOptions: PostgresConfiguration = { pool, schema: 'app', batchedCollections: false };
createPostgres(collectionOptions);
createPostgres().configure({ pool, batchedCollections: true });
const childrenCompiler = postgresPlugin(collectionOptions).compileChildrenQuery;
const pairedCompileQuery = childrenCompiler?.compileQuery;
// The plugin's children compiler and its pairing member have exact types, so retyping either to \`any\` fails.
const pgPairing: {
  compiler: Equals<typeof childrenCompiler, SQLChildrenQueryCompiler<PostgresConfiguration, DatabaseDescription> | undefined>;
  compileQuery: Equals<typeof pairedCompileQuery, ReturnType<typeof postgresPlugin>['compileQuery'] | undefined>;
} = { compiler: true, compileQuery: true };
// @ts-expect-error compileQuery is a function.
const wrongPairPg: number | undefined = pairedCompileQuery;
// @ts-expect-error batchedCollections is a boolean.
const badCollectionsPg: PostgresConfiguration = { pool, batchedCollections: 'no' };
// The PostgreSQL children statement carries the setup that turns JIT off for its transaction.
const pgSetup: Equals<ReturnType<NonNullable<typeof childrenCompiler>>['setup'], readonly SQLStatement[] | null | undefined> = true;
void [childrenCompiler, pairedCompileQuery, badCollectionsPg, pgPairing, wrongPairPg, pgSetup];
const layoutOptions: PostgresConfiguration = { pool, schema: 'app', refreshTriggers: 'perRoot', ownerIndexes: 'minimal' };
createPostgres(layoutOptions);
createPostgres().configure({ pool, refreshTriggers: 'perRow', ownerIndexes: 'all' });
const layoutDescription: DatabaseDescription = describeDatabase([], { schema: 'app', refreshTriggers: 'perRoot', ownerIndexes: 'minimal' });
const guardTrigger: DatabaseTrigger = layoutDescription.triggers[0];
const triggerEvents: Array<'INSERT' | 'UPDATE' | 'DELETE'> | undefined = guardTrigger.events;
const triggerWhen: string | undefined = guardTrigger.when;
// @ts-expect-error explicitNullsOrder is a boolean.
const badNulls: PostgresConfiguration = { pool, explicitNullsOrder: 'yes' };
// @ts-expect-error multiRowInserts is a boolean.
const badInserts: PostgresConfiguration = { pool, multiRowInserts: 'no' };
// @ts-expect-error refreshTriggers is 'perRow' or 'perRoot'.
const badRefresh: PostgresConfiguration = { pool, refreshTriggers: 'perTransaction' };
// @ts-expect-error ownerIndexes is 'all' or 'minimal'.
const badOwnerIndexes: PostgresConfiguration = { pool, ownerIndexes: 'none' };
// @ts-expect-error describeDatabase options take the same values.
describeDatabase([], { refreshTriggers: 'yes' });
const foldedName: string = caseFoldExpression('"name"');
// @ts-expect-error caseFoldExpression takes an SQL expression string.
caseFoldExpression(5);
void foldedName;
void [schema, model, ready, lowLevel, defaultSchema, defaultReady, rule, email, scalarName, countPlugin, scopes];
void [itemRules, tagRules, sameItemValidators];
void [batchLimit, batchCompiler, triggerEvents, triggerWhen, badNulls, badInserts, badRefresh, badOwnerIndexes];
// The plugin declares its operators for its own compileQuery; a copy without the declaration, or with another
// compileQuery, compiles the operators of 3.7.0.
const pgFeatures: Equals<ReturnType<typeof postgresPlugin>['queryFeatures'], SQLQueryFeatures<PostgresConfiguration, DatabaseDescription> | null | undefined> = true;
const pgCoreFeatures: CoreQueryFeatures | null | undefined = postgresPlugin().queryFeatures;
const pgOperators: readonly string[] | undefined = postgresPlugin().queryFeatures?.operators;
const legacyPg = createSQL({ plugin: { ...postgresPlugin({ pool }), queryFeatures: undefined } });
void [pgFeatures, pgCoreFeatures, pgOperators, legacyPg];
// The plugin declares reference emptiness, and the facade's query limits take maxReferenceFrames.
const pgReference: boolean | null | undefined = postgresPlugin().queryFeatures?.referenceEmptiness;
const pgQuantifiers: boolean | null | undefined = postgresPlugin().queryFeatures?.quantifiers;
configureQueryLimits({ maxFrameNesting: 3 });
api.configureQueryLimits({ maxFrameNesting: 2 });
void pgQuantifiers;
configureQueryLimits({ maxPageSize: 100, maxReferenceFrames: 5 });
api.configureQueryLimits({ maxReferenceFrames: 5 });
// @ts-expect-error maxReferenceFrames is a number.
configureQueryLimits({ maxReferenceFrames: 'five' });
void pgReference;`;

const mongoTypes = `import {
  InternalServerError,
  buildErrorFormatter,
  configureMutationLimits,
  createMongoAdapter,
  createRuntime,
  generateMCPTools,
  getInputType,
  getRegistrations,
  auth,
  plugins,
  scalars,
  validators,
  type AuthRuleFunction,
  type AuthSchemaPlugin,
  type EnvelopSchemaPlugin,
  type GeneratedMCPTools,
  type MongoAdapter,
  type FilterGroupInput,
  type QuantifiedGroupInput,
  type QLFilterGroup,
  type QLQuantifiedGroup,
  type QLTypeFilterExpression,
  type MongoAdapterOptions,
  type MutationLimitsOptions,
  type QueryLimitsOptions,
  type TypeScopes,
  type ItemValidators,
  type VirtualFieldDeclaration,
  type VirtualFieldOptions,
  configureQueryLimits,
} from '@simtlix/simfinity-js';
import type {
  AuthSchemaPlugin as CoreAuthSchemaPlugin,
  DatabaseAdapter as CoreDatabaseAdapter,
  EnvelopSchemaPlugin as CoreEnvelopSchemaPlugin,
  ItemValidators as CoreItemValidators,
  QueryFeatures as CoreQueryFeatures,
  QueryLimitsOptions as CoreQueryLimitsOptions,
  VirtualFieldDeclaration as CoreVirtualFieldDeclaration,
  VirtualFieldOptions as CoreVirtualFieldOptions,
} from '@simtlix/simfinity-core';
import { GraphQLObjectType, GraphQLString } from 'graphql';
const runtime = createRuntime(createMongoAdapter());
const protectedAdapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
const protection: 'off' | 'transactional' = protectedAdapter.referentialIntegrity;
const ready: Promise<void> = protectedAdapter.initialize();
// @ts-expect-error startup mode is readonly
protectedAdapter.referentialIntegrity = 'off';
// @ts-expect-error misspelled mode must not compile
createMongoAdapter({ referentialIntegrity: 'strict' });
const type = new GraphQLObjectType({ name: 'TypedMongoBook', fields: { title: { type: GraphQLString } } });
runtime.connect(null, type, 'typedMongoBook', 'typedMongoBooks');
const registrations = getRegistrations();
const inputType = getInputType(type);
const formatted: Error = buildErrorFormatter()(new Error('typed'));
const internal: InternalServerError = new InternalServerError('typed');
const rule: AuthRuleFunction = auth.requireAuth();
const email = validators.email();
const scalarName: string = scalars.EmailScalar.name;
const countPlugin = plugins.envelopCountPlugin();
const generated: GeneratedMCPTools = generateMCPTools(runtime.createSchema());
const limits: MutationLimitsOptions = { maxNestedOperations: 100 };
configureMutationLimits(limits);
runtime.configureMutationLimits();
const scopes: TypeScopes = { find: async ({ args, context }) => { args.owner = { operator: 'EQ', value: context.user.id }; } };
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const itemRules: ItemValidators = [validators.maxLength('Tag', 20), null];
const tagRules = validators.arrayLength('Tags', 10, itemRules);
const sameItemValidators: Equals<ItemValidators, CoreItemValidators> = true;
const sameSchemaPlugins: {
  envelop: Equals<EnvelopSchemaPlugin, CoreEnvelopSchemaPlugin>;
  auth: Equals<AuthSchemaPlugin, CoreAuthSchemaPlugin>;
  createAuthPlugin: Equals<ReturnType<typeof auth.createAuthPlugin>, CoreAuthSchemaPlugin>;
} = { envelop: true, auth: true, createAuthPlugin: true };
const sameVirtualTypes: {
  declaration: Equals<VirtualFieldDeclaration, CoreVirtualFieldDeclaration>;
  options: Equals<VirtualFieldOptions, CoreVirtualFieldOptions>;
} = { declaration: true, options: true };
void sameVirtualTypes;
// Batched collection reads are an adapter option; the adapter declares the optional members only.
const plain: MongoAdapter = createMongoAdapter();
const integrity: MongoAdapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
const options: MongoAdapterOptions = { batchedCollections: true, collectionBatchSize: 10 };
const batching = createMongoAdapter(options);
const both = createMongoAdapter({ referentialIntegrity: 'off', batchedCollections: false });
const lists = batching.findChildrenBatch?.({}, null as any, 'author', ['a'], {}, { context: {} });
const eligible: boolean | undefined = batching.batchesChildren?.({}, null as any, 'author');
const double: MongoAdapter = { ...plain, findChildrenBatch: undefined, batchesChildren: undefined };
// @ts-expect-error batchedCollections is a boolean.
const wrongFlag = createMongoAdapter({ batchedCollections: 'yes' });
// @ts-expect-error collectionBatchSize is a number.
const wrongSize = createMongoAdapter({ batchedCollections: true, collectionBatchSize: '5' });
// @ts-expect-error findChildrenBatch is optional on MongoAdapter.
batching.findChildrenBatch({}, null as any, 'author', ['a'], {});
// MongoAdapter inherits core's optional members unchanged.
const mongoBatchMembers: {
  read: Equals<MongoAdapter['findChildrenBatch'], CoreDatabaseAdapter['findChildrenBatch']>;
  predicate: Equals<MongoAdapter['batchesChildren'], CoreDatabaseAdapter['batchesChildren']>;
  lists: Equals<typeof lists, any[][] | PromiseLike<any[][]> | undefined>;
} = { read: true, predicate: true, lists: true };
void [registrations, inputType, formatted, internal, rule, email, scalarName, countPlugin, generated, protection, ready, scopes];
void [itemRules, tagRules, sameItemValidators, sameSchemaPlugins];
void [integrity, both, lists, eligible, double, wrongFlag, wrongSize, createRuntime(batching), mongoBatchMembers];
// The adapter declares the operators it compiles; a copy without the declaration gets the operators of 3.7.0.
const mongoFeatures: Equals<MongoAdapter['queryFeatures'], CoreQueryFeatures> = true;
const mongoOperators: readonly string[] = plain.queryFeatures.operators;
// @ts-expect-error queryFeatures is readonly.
plain.queryFeatures = { operators: [] };
const legacyMongo: CoreDatabaseAdapter = { ...plain, queryFeatures: undefined };
void [mongoFeatures, mongoOperators, createRuntime(legacyMongo)];
// The adapter declares reference emptiness, and the facade's query limits take maxReferenceFrames, as core's do.
const mongoReference: boolean | null | undefined = plain.queryFeatures.referenceEmptiness;
const mongoQuantifiers: boolean | null | undefined = plain.queryFeatures.quantifiers;
const mongoFrame: QuantifiedGroupInput = { path: 'reviews', conditions: [{ field: 'rating', value: 4 }], NONE: [{ path: 'product' }] };
const mongoGroup: FilterGroupInput = { ALL: [mongoFrame] };
const canonicalFrame: QLQuantifiedGroup = { path: 'reviews', conditions: [{ field: 'rating', operator: 'GTE', value: 4 }] };
const canonicalGroup: QLFilterGroup = { ALL: [canonicalFrame] };
const canonicalExpression: QLTypeFilterExpression = { quantifier: 'NONE', terms: [] };
configureQueryLimits({ maxFrameNesting: 3 });
void [mongoQuantifiers, mongoGroup, canonicalGroup, canonicalExpression];
const mongoLimits: QueryLimitsOptions = { maxPageSize: 50, maxReferenceFrames: 3 };
configureQueryLimits(mongoLimits);
// @ts-expect-error maxReferenceFrames is a number.
configureQueryLimits({ maxReferenceFrames: '3' });
const sameMongoLimits: Equals<QueryLimitsOptions, CoreQueryLimitsOptions> = true;
void [mongoReference, sameMongoLimits];`;

// MongoDB's legacy deep imports of public API and their aliases: each value and type export has
// exactly the type of the core subpath or root member it re-exports, so a missing sibling
// declaration, or one that degrades to \`any\`, fails.
const mongoLegacyTypes = `${Object.keys(mongoLegacySubpaths).map((path) => (
  `import * as ${legacyBinding(path)} from '@simtlix/simfinity-js/${path}';`
)).join('\n')}
import * as legacyEntry from '@simtlix/simfinity-js/src/index.js';
import * as aliasEntry from '@simtlix/simfinity-js/src';
import * as facade from '@simtlix/simfinity-js';
import legacyMcp, { generateMCPTools as legacyGenerateMCPTools } from '@simtlix/simfinity-js/src/mcp.js';
import mcpDefault, { generateMCPTools } from '@simtlix/simfinity-mcp';
import LegacyQLOperator from '@simtlix/simfinity-js/src/const/QLOperator.js';
import LegacyQLSort from '@simtlix/simfinity-js/src/const/QLSort.js';
import LegacyQLValue from '@simtlix/simfinity-js/src/const/QLValue.js';
import LegacySimfinityError from '@simtlix/simfinity-js/src/errors/simfinity.error.js';
import LegacyInternalServerError from '@simtlix/simfinity-js/src/errors/internal-server.error.js';
import aliasAuth from '@simtlix/simfinity-js/src/auth';
import { isOwner as aliasIsOwner } from '@simtlix/simfinity-js/src/auth/rules';
import { ForbiddenError as LegacyForbiddenError, requireRole, type AuthRuleFunction } from '@simtlix/simfinity-js/src/auth/index.js';
import {
  InternalServerError, QLOperator, QLSort, QLValue, SimfinityError, auth, plugins, scalars, validators,
} from '@simtlix/simfinity-core';
import type * as Core from '@simtlix/simfinity-core';
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
${Object.entries(mongoLegacySubpaths).map(([path, subpath]) => {
    const binding = legacyBinding(path);
    const config = coreSubpaths[subpath];
    const { namespace, values, types, errorClasses = [] } = config;
    const members = values.filter((name) => name !== 'default');
    return [
      `const ${binding}Keys: Record<keyof typeof ${binding}, true> = { ${values.map((name) => `${name}: true`).join(', ')} };`,
      `const ${binding}Values: {`,
      ...members.map((name) => `  ${name}: Equals<typeof ${binding}.${name}, typeof ${namespace}.${name}>;`),
      `  default: Equals<typeof ${binding}.default, ${subpathDefaultType(config)}>;`,
      `} = { ${[...members, 'default'].map((name) => `${name}: true`).join(', ')} };`,
      `const ${binding}Types: {`,
      ...types.map((name) => `  ${name}: Equals<${binding}.${name}, Core.${name}>;`),
      ...errorClasses.map((name) => `  ${name}: Equals<${binding}.${name}, InstanceType<typeof auth.${name}>>;`),
      `} = { ${[...types, ...errorClasses].map((name) => `${name}: true`).join(', ')} };`,
    ].join('\n');
  }).join('\n')}
const legacyShims: {
  entry: Equals<typeof legacyEntry, typeof facade>;
  aliasEntry: Equals<typeof aliasEntry, typeof facade>;
  mcp: Equals<typeof legacyMcp, typeof mcpDefault>;
  mcpNamed: Equals<typeof legacyGenerateMCPTools, typeof generateMCPTools>;
  aliasAuth: Equals<typeof aliasAuth, typeof auth>;
  aliasIsOwner: Equals<typeof aliasIsOwner, typeof auth.isOwner>;
  QLOperator: Equals<typeof LegacyQLOperator, typeof QLOperator>;
  QLSort: Equals<typeof LegacyQLSort, typeof QLSort>;
  QLValue: Equals<typeof LegacyQLValue, typeof QLValue>;
  SimfinityError: Equals<typeof LegacySimfinityError, typeof SimfinityError>;
  SimfinityErrorInstance: Equals<LegacySimfinityError, SimfinityError>;
  InternalServerError: Equals<typeof LegacyInternalServerError, typeof InternalServerError>;
  InternalServerErrorInstance: Equals<LegacyInternalServerError, InternalServerError>;
} = {
  entry: true, aliasEntry: true, mcp: true, mcpNamed: true, aliasAuth: true, aliasIsOwner: true, QLOperator: true, QLSort: true,
  QLValue: true, SimfinityError: true, SimfinityErrorInstance: true, InternalServerError: true, InternalServerErrorInstance: true,
};
const editorRule: AuthRuleFunction = requireRole('editor');
const legacyForbidden: SimfinityError = new LegacyForbiddenError('denied');
// @ts-expect-error An owner field is a path or an extractor.
${legacyBinding('src/auth/rules.js')}.isOwner(42);
// @ts-expect-error A role is a string or an array of strings.
${legacyBinding('src/auth/index.js')}.default.requireRole(42);
// @ts-expect-error The default policy is ALLOW or DENY.
${legacyBinding('src/plugins.js')}.createAuthPlugin({}, { defaultPolicy: 'MAYBE' });
void [plugins, scalars, validators, legacyShims, editorRule, legacyForbidden];
void [${Object.keys(mongoLegacySubpaths).flatMap((path) => ['Keys', 'Values', 'Types'].map((suffix) => `${legacyBinding(path)}${suffix}`)).join(', ')}];`;

const mcpTypes = `import mcp, {
  createHTTPMCPHandler,
  createMCPServer,
  generateMCPTools,
  startStdioMCPServer,
  type GeneratedMCPTools,
  type HTTPMCPHandlerOptions,
  type MCPExecutionOptions,
  type MCPLimits,
  type MCPNestedCollections,
  type MCPRetryOptions,
  type MCPServer,
  type MCPServerOptions,
  type MCPTextFormat,
} from '@simtlix/simfinity-mcp';
import { plugins } from '@simtlix/simfinity-core';
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: { greeting: { type: GraphQLString } },
  }),
});
const generated: GeneratedMCPTools = generateMCPTools(schema);
class ClassPlugin { onSchemaChange() {} }
const sharedPlugins: GeneratedMCPTools = generateMCPTools(schema, {
  schemaPlugins: [new ClassPlugin(), plugins.envelopCountPlugin(), plugins.createAuthPlugin({})],
});
// @ts-expect-error A plugin factory must be called.
generateMCPTools(schema, { schemaPlugins: [plugins.createAuthPlugin] });
// @ts-expect-error A promise must be awaited first.
generateMCPTools(schema, { schemaPlugins: [Promise.resolve(plugins.createAuthPlugin({}))] });
class CallApplyPlugin { onSchemaChange() {} call() {} apply() {} }
interface EnvelopStylePlugin {
  onSchemaChange?: (payload: { schema: GraphQLSchema; replaceSchema: (schema: GraphQLSchema) => void }) => void;
  onExecute?: (payload: { args: unknown }) => void;
  instrumentation?: { execute?: (payload: unknown, wrapped: () => void) => void };
}
declare const envelopStylePlugins: EnvelopStylePlugin[];
const memberPlugins: GeneratedMCPTools = generateMCPTools(schema, {
  schemaPlugins: [new CallApplyPlugin(), ...envelopStylePlugins],
});
const server: Promise<MCPServer> = createMCPServer(schema);
const sameGenerator: typeof generateMCPTools = mcp.generateMCPTools;
const singleMiddleware: GeneratedMCPTools = generateMCPTools(schema, { toolMiddleware: (call, next) => next() });
const optionalPlugins: GeneratedMCPTools = generateMCPTools(schema, { schemaPlugins: [{ async onSchemaChange() {} }, false, null, undefined] });
const handler = createHTTPMCPHandler(schema, { toolMiddleware: [(call, next) => next()] });
// The factories accept wider remote headers, timeouts and limits than the option interfaces declare.
const endpoint = 'https://api.example.com/graphql';
const headerForms: GeneratedMCPTools[] = [
  generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: new Headers({ authorization: 'Bearer t' }) } }),
  generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: new Map([['authorization', 'Bearer t']]) } }),
  generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: [['authorization', 'Bearer t']] as const } }),
  generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: null, timeoutMs: false } }),
];
const fromEnvironment: GeneratedMCPTools = generateMCPTools(schema, {
  execution: { mode: 'remote', endpoint, timeoutMs: '5000' },
  limits: { maxPageSize: '100', maxResultBytes: 65536n, defaultPagination: false },
});
const stdio: Promise<MCPServer> = startStdioMCPServer(schema, { limits: { maxResultBytes: '1048576.5', maxPageSize: null } });
const fallible = createHTTPMCPHandler(schema, { limits: false, execution: { mode: 'remote', endpoint, timeoutMs: 10n } });
const unlimited = createMCPServer(schema, { limits: null, execution: null });
// @ts-expect-error A bare string is not a header map.
generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: 'Bearer t' } });
// @ts-expect-error A promise would send no credentials.
generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: Promise.resolve({ authorization: 'Bearer t' }) } });
// @ts-expect-error A generator would be used up by the first request.
generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: (function* pairs() { yield ['authorization', 'Bearer t'] as const; }()) } });
// Result shape and retry opt-ins.
const shaped: GeneratedMCPTools = generateMCPTools(schema, {
  nestedCollections: 'none',
  textFormat: 'compact',
  toolOverrides: { greeting: { nestedCollections: 'all' } },
});
const politeRetry = createHTTPMCPHandler(schema, {
  textFormat: 'pretty',
  execution: {
    mode: 'remote', endpoint, retry: { attempts: 3, backoffMs: 250, retryAfter: true, maxRetryAfterMs: 30000, jitter: true },
  },
});
// @ts-expect-error Bounded nested collections are not an option.
generateMCPTools(schema, { nestedCollections: 'bounded' });
// @ts-expect-error A tool's nested collections are 'all' or 'none'.
generateMCPTools(schema, { toolOverrides: { greeting: { nestedCollections: { pageSize: 5 } } } });
// @ts-expect-error The text format is 'pretty' or 'compact'.
generateMCPTools(schema, { textFormat: 'json' });
// @ts-expect-error retry.jitter is a boolean.
generateMCPTools(schema, { execution: { mode: 'remote', endpoint, retry: { jitter: 'yes' } } });
// Reading options back keeps the narrow 3.5.6 shapes, and they are still accepted as input.
declare const serverOptions: MCPServerOptions;
const execution: MCPExecutionOptions | null | undefined = serverOptions.execution;
if (execution && execution.mode === 'remote') {
  const authorization: string | undefined = execution.headers?.authorization;
  execution.headers!.authorization = 'Bearer rotated';
  const timeoutMs: number | undefined = execution.timeoutMs;
  const retry: MCPRetryOptions | undefined = execution.retry;
  const retryAfter: boolean | undefined = execution.retry?.retryAfter;
  const maxRetryAfterMs: number | undefined = execution.retry?.maxRetryAfterMs;
  const jitter: boolean | undefined = execution.retry?.jitter;
  void [authorization, timeoutMs, retry, retryAfter, maxRetryAfterMs, jitter];
}
const nestedCollections: MCPNestedCollections | undefined = serverOptions.nestedCollections;
const toolNestedCollections: 'all' | 'none' | undefined = serverOptions.toolOverrides?.greeting?.nestedCollections;
const textFormat: MCPTextFormat | undefined = serverOptions.textFormat;
const maxPageSize: number | undefined = serverOptions.limits?.maxPageSize;
const maxResultBytes: number | undefined = serverOptions.limits?.maxResultBytes;
const defaultSize: number | undefined = serverOptions.limits?.defaultPagination?.size;
const typedLimits: MCPLimits = { maxPageSize: 100, defaultPagination: { page: 1, size: 20 } };
declare const httpOptions: HTTPMCPHandlerOptions;
const readBack = [
  generateMCPTools(schema, serverOptions),
  createMCPServer(schema, serverOptions),
  createHTTPMCPHandler(schema, httpOptions),
  generateMCPTools(schema, { limits: typedLimits }),
];
void [generated, server, sameGenerator, singleMiddleware, optionalPlugins, handler, sharedPlugins, memberPlugins];
void [headerForms, fromEnvironment, stdio, fallible, unlimited, maxPageSize, maxResultBytes, defaultSize, readBack];
void [shaped, politeRetry, nestedCollections, toolNestedCollections, textFormat];`;

// The legacy deep imports of /auth and /plugins re-export them unchanged, so they can be
// re-exported together too.
const mongoLegacyAuthPluginsTypes = `import { auth, plugins } from '@simtlix/simfinity-core';
import * as legacyAuth from '@simtlix/simfinity-js/src/auth/index.js';
import * as legacyPlugins from '@simtlix/simfinity-js/src/plugins.js';
export * from '@simtlix/simfinity-js/src/auth/index.js';
export * from '@simtlix/simfinity-js/src/plugins.js';
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const sharedAuthPlugin: {
  auth: Equals<typeof legacyAuth.createAuthPlugin, typeof auth.createAuthPlugin>;
  plugins: Equals<typeof legacyPlugins.createAuthPlugin, typeof plugins.createAuthPlugin>;
  same: Equals<typeof legacyPlugins.createAuthPlugin, typeof legacyAuth.createAuthPlugin>;
} = { auth: true, plugins: true, same: true };
void sharedAuthPlugin;`;

// The legacy MCP deep import re-exports @simtlix/simfinity-mcp, and so core's EnvelopSchemaPlugin: it
// can be re-exported with the legacy auth and plugins deep imports, and before the package root.
const mongoLegacyMcpBarrel = (other) => `import type * as Core from '@simtlix/simfinity-core';
import type * as LegacyMcp from '@simtlix/simfinity-js/src/mcp.js';
import type * as Other from '${other}';
import { auth, plugins } from '@simtlix/simfinity-core';
import type { GraphQLSchema } from 'graphql';
export * from '@simtlix/simfinity-js/src/mcp.js';
export * from '${other}';
${envelopSchemaPluginShape}
const oneEnvelopSchemaPlugin: {
  legacyMcp: Equals<LegacyMcp.EnvelopSchemaPlugin, Core.EnvelopSchemaPlugin>;
  other: Equals<Other.EnvelopSchemaPlugin, Core.EnvelopSchemaPlugin>;
  otherAuth: Equals<Other.AuthSchemaPlugin, Core.AuthSchemaPlugin>;
} = { legacyMcp: true, other: true, otherAuth: true };
void oneEnvelopSchemaPlugin;`;

// The 3.5.9 workaround, an explicit re-export next to the conflicting \`export *\` lines, still compiles.
const mongoLegacyMcpWorkaroundTypes = `export * from '@simtlix/simfinity-js/src/mcp.js';
export * from '@simtlix/simfinity-js/src/auth/index.js';
export * from '@simtlix/simfinity-js/src/plugins.js';
export type { EnvelopSchemaPlugin } from '@simtlix/simfinity-core/plugins';`;

// The documented \`undefined\` opt-outs must also compile under exactOptionalPropertyTypes, where an optional
// member that does not include \`undefined\` in its type rejects an explicit \`undefined\` (TS2412, TS2375).
const coreExactOptionalTypes = `import type { DatabaseAdapter, QueryFeatures } from '@simtlix/simfinity-core';
declare const adapter: DatabaseAdapter;
adapter.findChildrenBatch = undefined;
adapter.batchesChildren = undefined;
adapter.queryFeatures = undefined;
const copy: DatabaseAdapter = { ...adapter, findChildrenBatch: undefined, batchesChildren: undefined, queryFeatures: undefined };
const features: QueryFeatures[] = [{ operators: [], referenceEmptiness: undefined, quantifiers: undefined }, { operators: [], referenceEmptiness: null, quantifiers: null }];
adapter.queryFeatures = { operators: ['IS_EMPTY'], referenceEmptiness: undefined };
void [copy, features];`;

const sqlExactOptionalTypes = `import type { SQLConfiguration, SQLPlugin, SQLQueryFeatures } from '@simtlix/simfinity-sql';
declare const plugin: SQLPlugin;
const copy: SQLPlugin = { ...plugin, compileChildrenQuery: undefined, compileRecordBatch: undefined, maxRecordBatchValues: undefined, queryFeatures: undefined };
const configuration: SQLConfiguration = { batchedCollections: undefined };
const features: SQLQueryFeatures[] = [{ operators: [], referenceEmptiness: undefined, quantifiers: undefined, compileQuery: undefined }, { operators: [], referenceEmptiness: null, quantifiers: null }];
const declared: SQLPlugin = { ...plugin, queryFeatures: { operators: ['EQ'], referenceEmptiness: undefined } };
void [copy, configuration, features, declared];`;

const postgresExactOptionalTypes = `import { Pool } from 'pg';
import { createPostgres, postgresPlugin } from '@simtlix/simfinity-postgres';
const pool = new Pool();
const plugin: ReturnType<typeof postgresPlugin> = {
  ...postgresPlugin({ pool }), compileChildrenQuery: undefined, compileRecordBatch: undefined, maxRecordBatchValues: undefined, queryFeatures: undefined,
};
const runtime = createPostgres({ pool, batchedCollections: undefined });
void [plugin, runtime];`;

const mongoExactOptionalTypes = `import { createMongoAdapter, createRuntime } from '@simtlix/simfinity-js';
const adapter = createMongoAdapter({ batchedCollections: true, collectionBatchSize: undefined });
adapter.findChildrenBatch = undefined;
adapter.batchesChildren = undefined;
void createMongoAdapter({ batchedCollections: undefined });
void createRuntime({ ...adapter, queryFeatures: undefined });`;

const customQueryTypes = (name, runtimeType, singleton = false) => `import type { CreateSchemaOptions } from '${name}';
import type { CreateSchemaOptions as CoreOptions } from '@simtlix/simfinity-core';
// @ts-expect-error RegisterQueryOptions is not exported: custom queries have no options.
import type { RegisterQueryOptions } from '${name}';
import { GraphQLInputObjectType, GraphQLString, type GraphQLSchema } from 'graphql';
${singleton ? `import { registerCustomQuery, createSchema } from '${name}';
// @ts-expect-error registerQuery is not exported.
import { registerQuery } from '${name}';` : ''}
declare const api: ${runtimeType};
const register = ${singleton ? 'registerCustomQuery' : 'api.registerCustomQuery'};
// @ts-expect-error registerQuery is not a runtime member.
void api.registerQuery;
const input = new GraphQLInputObjectType({ name: 'CustomQueryInput', fields: { text: { type: GraphQLString } } });
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const sameOptions: Equals<CreateSchemaOptions, CoreOptions> = true;
const exactOptions: Equals<CreateSchemaOptions, { includedCustomQueries?: string[] | null }> = true;
const exactCallback: Equals<Parameters<typeof register>[4], (input: any, context: any) => any> = true;
register('withInput', '', input, GraphQLString, (args, context) => \`\${args.text}\${context.text}\`);
register('withoutInput', '', null, GraphQLString, async () => 'value');
register('undefinedInput', '', undefined, GraphQLString, () => 'value');
// @ts-expect-error A custom query callback receives no session.
register('withSession', '', null, GraphQLString, (args, session, context) => String(context));
// @ts-expect-error A custom query has no options argument.
register('withOptions', '', null, GraphQLString, () => 'value', { transactional: true });
// @ts-expect-error A custom query input must be an input object, not a scalar.
register('scalarInput', '', GraphQLString, GraphQLString, () => 'value');
const options: CreateSchemaOptions = { includedCustomQueries: ['withInput'] };
const schema: GraphQLSchema = api.createSchema(null, null, null, options);
api.createSchema(undefined, undefined, undefined, { includedCustomQueries: [] });
api.createSchema(null, null, null, { includedCustomQueries: null });
api.createSchema(null, null, null, {});
api.createSchema(null, null, null);
// @ts-expect-error Custom queries are selected through an options object, not a positional array.
api.createSchema(null, null, null, ['withInput']);
// @ts-expect-error Custom query allowlists hold names.
api.createSchema(null, null, null, { includedCustomQueries: [1] });
// @ts-expect-error createSchema() has no other options.
api.createSchema(null, null, null, { includedCustomQuery: ['withInput'] });
${singleton ? `const defaultSchema: GraphQLSchema = createSchema([], [], [], { includedCustomQueries: ['withoutInput'] });
void [defaultSchema, registerQuery];` : ''}
void [schema, sameOptions, exactOptions, exactCallback];`;

// registerView and the option types every package re-exports from core: params are scalars, enums or lists of them,
// possibly non-null, and where returns the groups or a promise of them.
const viewTypes = (name, runtimeType, singleton = false) => `import type { FilterCondition, FilterGroup, ViewOptions, ViewParam, ViewParamType } from '${name}';
import type { ViewOptions as CoreViewOptions } from '@simtlix/simfinity-core';
import { GraphQLEnumType, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
${singleton ? `import { registerView } from '${name}';` : ''}
declare const api: ${runtimeType};
const register = ${singleton ? 'registerView' : 'api.registerView'};
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const sameOptions: Equals<ViewOptions, CoreViewOptions> = true;
const exactRegister: Equals<typeof register, (name: string, options: ViewOptions) => void> = true;
${singleton ? 'const sameMember: Equals<typeof api.registerView, typeof register> = true;' : ''}
const type = new GraphQLObjectType({ name: 'ViewItem', fields: { name: { type: GraphQLString } } });
const status = new GraphQLEnumType({ name: 'ViewStatus', values: { OPEN: {} } });
const input = new GraphQLInputObjectType({ name: 'ViewInput', fields: { text: { type: GraphQLString } } });
register('openItems', { type, description: 'd', params: { from: { type: GraphQLString, defaultValue: 'x' } }, where: () => [{ conditions: [{ field: 'name', operator: 'EQ', value: 'a' }] }] });
register('asyncItems', {
  type,
  description: 'd',
  params: { statuses: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(status))), description: 'd' }, limit: { type: GraphQLInt } },
  where: async ({ params, context }) => [{ OR: [{ conditions: [{ field: 'status', operator: 'IN', value: params.statuses }] }], AND: [{ conditions: [{ field: 'owner', path: 'id', value: context.user }] }] }],
});
const paramType: ViewParamType = new GraphQLList(new GraphQLList(GraphQLString));
const param: ViewParam = { type: paramType };
const condition: FilterCondition = { field: 'name', operator: 'IS_EMPTY' };
const group: FilterGroup = { AND: [{ conditions: [condition] }], ANY: [{ path: 'reviews', ALL: [{ path: 'author', conditions: [{ field: 'name', operator: 'NE', value: 'hidden' }] }] }], NONE: [{ path: 'reviews', conditions: [{ field: 'rating', operator: 'LT', value: 1 }] }] };
// @ts-expect-error A quantified view group requires its element path.
const invalidFrame: FilterGroup = { ANY: [{ conditions: [] }] };
void invalidFrame;
const options: ViewOptions = { type, description: 'd', params: { param }, where: () => [group] };
register('typedItems', options);
// @ts-expect-error A param is a scalar, an enum or a list of them, not an input object.
register('inputParam', { type, description: 'd', params: { filter: { type: input } }, where: () => [] });
// @ts-expect-error Not inside a list either.
register('inputListParam', { type, description: 'd', params: { filter: { type: new GraphQLList(input) } }, where: () => [] });
// @ts-expect-error A view needs a description.
register('noDescription', { type, where: () => [] });
// @ts-expect-error where returns an array of groups, not one group.
register('objectWhere', { type, description: 'd', where: () => ({ conditions: [] }) });
// @ts-expect-error A view has no other options.
register('unknownOption', { type, description: 'd', where: () => [], transactional: true });
void [sameOptions, exactRegister${singleton ? ', sameMember' : ''}];`;

const cases = [
  {
    name: 'core',
    exactOptionalTypes: { 'exact-optional.ts': coreExactOptionalTypes },
    archives: ({ core }) => [core],
    source: coreSource,
    types: coreTypes,
    extraTypes: {
      'subpaths.ts': coreSubpathTypes,
      'root.ts': coreRootTypes,
      'auth-plugins.ts': coreAuthPluginsTypes,
      'schema-plugins.ts': coreSchemaPluginTypes,
      'custom-queries.ts': customQueryTypes('@simtlix/simfinity-core', 'import(\'@simtlix/simfinity-core\').Runtime<{ name: string }, { active: boolean }>'),
      'views.ts': viewTypes('@simtlix/simfinity-core', 'import(\'@simtlix/simfinity-core\').Runtime<{ name: string }, { active: boolean }>'),
    },
    // NodeNext, Node16 and Bundler read the subpath declarations from the exports map; Node10, which
    // ignores exports, reads them from typesVersions.
    moduleResolutions: ['NodeNext', 'Node16', 'Bundler', 'Node10'],
    forbiddenPackages: ['pg', 'mongoose', 'mongodb', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'sql',
    exactOptionalTypes: { 'exact-optional.ts': sqlExactOptionalTypes },
    archives: ({ core, sql }) => [core, sql],
    source: sqlSource,
    types: sqlTypes,
    extraTypes: {
      'barrel.ts': databaseBarrelTypes('@simtlix/simfinity-sql'),
      'custom-queries.ts': customQueryTypes('@simtlix/simfinity-sql', 'import(\'@simtlix/simfinity-sql\').SQLRuntime'),
      'views.ts': viewTypes('@simtlix/simfinity-sql', 'import(\'@simtlix/simfinity-sql\').SQLRuntime'),
    },
    forbiddenPackages: ['pg', 'mongoose', 'mongodb', '@simtlix/simfinity-postgres', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'postgres',
    exactOptionalTypes: { 'exact-optional.ts': postgresExactOptionalTypes },
    archives: ({ core, sql, postgres }) => [core, sql, postgres],
    source: postgresSource,
    types: postgresTypes,
    extraTypes: {
      'barrel.ts': databaseBarrelTypes('@simtlix/simfinity-postgres'),
      'custom-queries.ts': customQueryTypes('@simtlix/simfinity-postgres', 'import(\'@simtlix/simfinity-postgres\').PostgresRuntime', true),
      'views.ts': viewTypes('@simtlix/simfinity-postgres', 'import(\'@simtlix/simfinity-postgres\').PostgresRuntime', true),
    },
    typeDependencies: ['@types/pg@8'],
    forbiddenPackages: ['mongoose', 'mongodb', '@modelcontextprotocol/sdk', '@simtlix/simfinity-mcp'],
  },
  {
    name: 'mcp',
    archives: ({ core, mcp }) => [core, mcp],
    source: mcpSource,
    types: mcpTypes,
    extraTypes: { 'barrel.ts': mcpBarrelTypes },
    // The MCP declarations import core's EnvelopSchemaPlugin: NodeNext, Node16 and Bundler resolve it
    // through core's exports map, Node10 through its types field, and the barrel's core subpaths
    // through typesVersions.
    moduleResolutions: ['NodeNext', 'Node16', 'Bundler', 'Node10'],
    forbiddenPackages: ['mongoose', 'mongodb', '@modelcontextprotocol/sdk'],
  },
  {
    name: 'mcp-sdk',
    archives: ({ core, mcp }) => [core, mcp],
    source: mcpSdkSource,
    types: mcpTypes,
    extraTypes: { 'barrel.ts': mcpBarrelTypes },
    dependencies: ['@modelcontextprotocol/sdk@1'],
    forbiddenPackages: ['mongoose', 'mongodb'],
  },
  {
    name: 'mongo',
    exactOptionalTypes: { 'exact-optional.ts': mongoExactOptionalTypes },
    archives: ({ core, mcp, mongo }) => [core, mcp, mongo],
    source: mongoSource,
    types: mongoTypes,
    extraTypes: {
      'legacy.ts': mongoLegacyTypes,
      'legacy-auth-plugins.ts': mongoLegacyAuthPluginsTypes,
      'legacy-mcp-auth.ts': mongoLegacyMcpBarrel('@simtlix/simfinity-js/src/auth/index.js'),
      'legacy-mcp-plugins.ts': mongoLegacyMcpBarrel('@simtlix/simfinity-js/src/plugins.js'),
      'legacy-mcp-root.ts': mongoLegacyMcpBarrel('@simtlix/simfinity-js'),
      'legacy-mcp-workaround.ts': mongoLegacyMcpWorkaroundTypes,
      'custom-queries.ts': customQueryTypes('@simtlix/simfinity-js', 'import(\'@simtlix/simfinity-core\').Runtime', true),
      'legacy-custom-queries.ts': customQueryTypes('@simtlix/simfinity-js/src/index.js', 'import(\'@simtlix/simfinity-core\').Runtime', true),
      'views.ts': viewTypes('@simtlix/simfinity-js', 'import(\'@simtlix/simfinity-core\').Runtime', true),
      'legacy-views.ts': viewTypes('@simtlix/simfinity-js/src/index.js', 'import(\'@simtlix/simfinity-core\').Runtime', true),
    },
    // The legacy deep-import declarations sit next to the shims: NodeNext, Node16 and Bundler find
    // them through the exports map, Node10 by path, and their core subpath imports through core's
    // typesVersions.
    moduleResolutions: ['NodeNext', 'Node16', 'Bundler', 'Node10'],
  },
];

try {
  const archives = releaseArchives();
  const core = check(archives, '@simtlix/simfinity-core');
  const sql = check(archives, '@simtlix/simfinity-sql');
  const mcp = check(archives, '@simtlix/simfinity-mcp');
  const postgres = check(archives, '@simtlix/simfinity-postgres');
  const mongo = check(archives, '@simtlix/simfinity-js');
  for (const testCase of cases) {
    const cwd = join(temporary, testCase.name);
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: `check-${testCase.name}`,
      private: true,
      type: 'module',
    }));
    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...testCase.archives({ core, sql, mcp, postgres, mongo }),
      'graphql@16',
      'typescript@5',
      ...(testCase.dependencies || []),
      ...(testCase.typeDependencies || []),
    ], cwd);
    {
      const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
      for (const packageName of ['@skypack/package-check', ...(testCase.forbiddenPackages || [])]) {
        assert(!Object.keys(lock.packages).some((path) => (
          path.endsWith(`node_modules/${packageName}`)
        )), `${testCase.name} pulled forbidden dependency ${packageName}`);
      }
    }
    run(process.execPath, ['--input-type=module', '--eval', testCase.source], cwd);
    if (testCase.name === 'mongo') {
      run(process.execPath, [join(root, 'tests/fixtures/mongodb-package-resolution.js')], cwd);
    }
    const typeFiles = { 'check.ts': testCase.types, ...testCase.extraTypes };
    for (const [file, source] of Object.entries(typeFiles)) writeFileSync(join(cwd, file), source);
    for (const moduleResolution of testCase.moduleResolutions || ['NodeNext']) {
      writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: ['NodeNext', 'Node16'].includes(moduleResolution) ? moduleResolution : 'ESNext',
          moduleResolution,
          noEmit: true,
          skipLibCheck: false,
        },
        include: Object.keys(typeFiles),
      }));
      try {
        run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], cwd);
      } catch (error) {
        error.message = `${testCase.name} (moduleResolution ${moduleResolution}): ${error.message}`;
        throw error;
      }
    }
    if (testCase.exactOptionalTypes) {
      for (const [file, source] of Object.entries(testCase.exactOptionalTypes)) writeFileSync(join(cwd, file), source);
      writeFileSync(join(cwd, 'tsconfig.exact.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
        },
        include: Object.keys(testCase.exactOptionalTypes),
      }));
      try {
        run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.exact.json'], cwd);
      } catch (error) {
        error.message = `${testCase.name} (exactOptionalPropertyTypes): ${error.message}`;
        throw error;
      }
    }
    console.log(`${testCase.name}: packed runtime and TypeScript consumption verified`);
  }
} catch (error) {
  if (error.stderr) console.error(error.stderr.toString());
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester, Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import plugin from '../src/index.js';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
const auth = "import { createAuthPlugin as protect, requireAuth as loggedIn, requireRole, anyRule } from '@simtlix/simfinity-core/auth';\n";
const query = "import { configureQueryLimits as limit } from '@simtlix/simfinity-core';\n";
const mongo = "import * as sf from '@simtlix/simfinity-js';\n";
const pg = "import { createPostgres } from '@simtlix/simfinity-postgres'; const sf = createPostgres();\n";
const gql = "import { GraphQLObjectType as ObjectType, GraphQLList as List, GraphQLNonNull as NonNull } from 'graphql';\n";
const relation = value => `new ObjectType({ name: 'Book', fields: { author: { type: Author, extensions: { relation: { connectionField: ${value} } } } } })`;
const invalid = code => ({ code, errors: [{ messageId: 'invalid' }] });

tester.run('valid-default-policy', plugin.rules['valid-default-policy'], {
  valid: [
    auth + 'protect({}, { defaultPolicy: "DENY" }); protect({}, { defaultPolicy: "ALLOW" }); protect({});',
    auth + 'protect({}, { defaultPolicy: undefined });',
    auth + 'protect({}, { defaultPolicy: process.env.POLICY });',
    auth + 'protect({}, { defaultPolicy: "allow", ...options });',
    auth + 'protect({}, { defaultPolicy: "allow", defaultPolicy: "ALLOW" });',
    auth + 'protect({}, { get defaultPolicy() { return "allow"; } });',
    auth + 'const config = { defaultPolicy: "allow" }; config.defaultPolicy = "ALLOW"; protect({}, config);',
    auth + 'function run(protect) { protect({}, { defaultPolicy: "allow" }); }',
    'import { createAuthPlugin } from "other"; createAuthPlugin({}, { defaultPolicy: "allow" });',
    'const auth = { createAuthPlugin() {} }; auth.createAuthPlugin({}, { defaultPolicy: "allow" });',
    auth + 'function run(undefined) { protect({}, { defaultPolicy: undefined }); }',
    auth + 'protect(...args, { defaultPolicy: "allow" });',
  ],
  invalid: [
    invalid(auth + 'protect({}, { defaultPolicy: "allow" });'),
    invalid(auth + 'const policy = "deny"; protect({}, { defaultPolicy: policy });'),
    invalid(auth + 'protect({}, { defaultPolicy: null });'),
    invalid(mongo + 'sf.auth.createAuthPlugin({}, { defaultPolicy: false });'),
    invalid(pg + 'sf.auth.createAuthPlugin({}, { defaultPolicy: 1 });'),
    invalid('import auth from "@simtlix/simfinity-js/src/auth/index.js"; auth.createAuthPlugin({}, { defaultPolicy: "deny" });'),
    invalid(auth + 'const alias = protect; alias({}, { defaultPolicy: "unknown" });'),
    invalid(mongo + 'const { createAuthPlugin: protect } = sf.auth; protect({}, { defaultPolicy: "deny" });'),
    invalid(mongo + 'sf.getModel(sf.getType("Book")); sf.auth.createAuthPlugin(permissions, { defaultPolicy: "allow" });'),
  ],
});

tester.run('valid-query-limits', plugin.rules['valid-query-limits'], {
  valid: [
    query + 'limit(); limit({}); limit({ maxPageSize: 1 }); limit({ maxPageSize: 9007199254740991 });',
    query + 'limit({ maxPageSize: undefined }); limit({ ignored: 0 });',
    query + 'limit({ maxPageSize: Number(process.env.CAP) });',
    query + 'let cap = 0; cap = 10; limit({ maxPageSize: cap });',
    query + 'limit({ maxPageSize: 0, ...options });',
    query + 'limit({ maxPageSize: 0, [key]: 10 });',
    query + 'function f(limit) { limit({ maxPageSize: 0 }); }',
    pg + 'sf.configureQueryLimits = custom; sf.configureQueryLimits({ maxPageSize: 0 });',
    pg + 'const alias = sf; alias.configureQueryLimits = custom; sf.configureQueryLimits({ maxPageSize: 0 });',
    pg + 'decorate(sf); sf.configureQueryLimits({ maxPageSize: 0 });',
    pg + 'const box = { sf }; box.sf.configureQueryLimits = custom; sf.configureQueryLimits({ maxPageSize: 0 });',
    pg + 'const box = [sf]; box[0].configureQueryLimits = custom; sf.configureQueryLimits({ maxPageSize: 0 });',
    pg + '({ custom: sf.configureQueryLimits } = { custom: () => {} }); sf.configureQueryLimits({ maxPageSize: 0 });',
    pg + 'for (sf.configureQueryLimits of [() => {}]) {} sf.configureQueryLimits({ maxPageSize: 0 });',
    pg + 'const other = createPostgres(); other.connect = target => { target.configureQueryLimits = () => {}; }; other.connect(sf); sf.configureQueryLimits({ maxPageSize: 0 });',
    'import * as unrelated from "other"; unrelated.configureQueryLimits({ maxPageSize: 0 });',
  ],
  invalid: [
    ...['0', '-1', '1.5', '9007199254740992', '"100"', 'null', 'false', 'NaN', 'Infinity'].map(value => invalid(query + `limit({ maxPageSize: ${value} });`)),
    invalid(query + 'const zero = 0; const cap = zero; limit({ maxPageSize: cap });'),
    invalid(mongo + 'sf.configureQueryLimits({ maxPageSize: 0 });'),
    invalid(pg + 'sf.configureQueryLimits({ maxPageSize: 0 });'),
    invalid('import { createRuntime } from "@simtlix/simfinity-core"; const rt = createRuntime(adapter); rt.configureQueryLimits({ maxPageSize: 0 });'),
    invalid('import { createSQL } from "@simtlix/simfinity-sql"; createSQL({ plugin }).configureQueryLimits({ maxPageSize: 0 });'),
  ],
});

tester.run('no-uncalled-auth-factory', plugin.rules['no-uncalled-auth-factory'], {
  valid: [
    auth + 'protect({ RootQueryType: { books: loggedIn() }, Mutation: { "*": [requireRole("admin"), customRule] } });',
    auth + 'anyRule(loggedIn(), customRule);',
    auth + 'const factory = loggedIn; const rule = factory(); protect({ RootQueryType: { "*": rule } });',
    auth + 'function f(loggedIn) { protect({ RootQueryType: { "*": loggedIn } }); }',
    auth + 'const factory = loggedIn; registerFactory(factory);',
    'import { createAuthPlugin, requireAuth } from "other"; createAuthPlugin({ RootQueryType: { "*": requireAuth } });',
    auth + 'protect({ RootQueryType: { "*": loggedIn, ...permissions } });',
  ],
  invalid: [
    invalid(auth + 'protect({ RootQueryType: { books: loggedIn } });'),
    invalid(auth + 'protect({ Mutation: { "*": [requireRole] } });'),
    invalid(auth + 'anyRule(loggedIn, customRule);'),
    invalid(auth + 'const alias = loggedIn; protect({ RootQueryType: { "*": [[alias]] } });'),
    invalid(mongo + 'sf.auth.createAuthPlugin({ RootQueryType: { "*": sf.auth.requireAuth } });'),
    invalid('import { composeRules } from "@simtlix/simfinity-core/auth/rules"; import { createRuleFromExpression } from "@simtlix/simfinity-core/auth/expressions"; composeRules(createRuleFromExpression);'),
    invalid('import auth from "@simtlix/simfinity-js/src/auth"; auth.anyRule(auth.deny);'),
  ],
});

const cloning = "import { mapSchema as clone } from '@graphql-tools/utils'; import { applyMiddleware as wrap } from 'graphql-middleware';\n";
tester.run('no-schema-cloning', plugin.rules['no-schema-cloning'], {
  valid: [
    cloning + 'clone(independentSchema, {});',
    cloning + mongo + 'const independentSchema = new GraphQLSchema({}); wrap(independentSchema, middleware);',
    mongo + 'const schema = sf.createSchema(); customWrap(schema);',
    cloning + mongo + 'const schema = sf.createSchema(); function f(schema) { clone(schema, {}); }',
    cloning + 'const sf = { createSchema() {} }; clone(sf.createSchema(), {});',
    cloning + pg + 'sf.createSchema = custom; clone(sf.createSchema(), {});',
  ],
  invalid: [
    invalid(cloning + mongo + 'clone(sf.createSchema(), {});'),
    invalid(cloning + pg + 'const schema = sf.createSchema(); const alias = schema; wrap(alias, middleware);'),
    invalid(cloning + 'import { createSchema as make } from "@simtlix/simfinity-js/src/index.js"; wrap(make(), middleware);'),
    invalid(cloning + 'import { createRuntime as runtime } from "@simtlix/simfinity-core"; const sf = runtime(adapter); const schema = sf.createSchema(); clone(schema, {});'),
  ],
});

tester.run('valid-connection-field', plugin.rules['valid-connection-field'], {
  valid: [
    ...['"authorId"', '""', 'null', 'undefined', 'config.field'].map(value => mongo + gql + `const Book = ${relation(value)}; sf.connect(model, Book, "book", "books");`),
    mongo + gql + `const Unrelated = ${relation('"author.id"')};`,
    gql + `const Book = ${relation('"author.id"')}; other.connect(model, Book);`,
    mongo + gql + `const Book = ${relation('"author.id"')}; function f(sf) { sf.connect(model, Book); }`,
    mongo + gql + 'sf.connect(model, new ObjectType({ name: "Book", fields: { address: { type: Address, extensions: { relation: { embedded: true, connectionField: "unused.path" } } } } }));',
    mongo + gql + 'sf.connect(model, new ObjectType({ name: "Book", fields: { address: { type: Address, extensions: { relation: { embedded: flag, connectionField: "unused.path" } } } } }));',
    mongo + gql + 'sf.connect(model, new ObjectType({ name: "Book", fields: { summary: { type: Summary, resolve: calculate, extensions: { virtual: true } } } }));',
    mongo + gql + 'sf.connect(model, new ObjectType({ name: "Book", fields: loadFields }));',
    mongo + gql + 'sf.connect(model, new ObjectType({ name: "Book", fields: () => { setup(); return { author: { extensions: { relation: { connectionField: "author.id" } } } }; } }));',
    mongo + gql + `const Book = ${relation('"author.id"')}; patch(Book); sf.connect(model, Book);`,
    mongo + gql + `const Book = ${relation('"author.id"')}; const box = { Book }; patch(box.Book); sf.connect(model, Book);`,
    mongo + gql + `const Book = ${relation('"author.id"')}; const Alias = Book; const box = { Alias }; box.Alias.getFields().author.extensions.relation.connectionField = "authorId"; sf.connect(model, Book);`,
    mongo + gql + `sf.connect(...args, ${relation('"author.id"')});`,
  ],
  invalid: [
    ...['"author.id"', '42', 'false', '[]', '{}'].map(value => invalid(mongo + gql + `const Book = ${relation(value)}; sf.connect(model, Book, "book", "books");`)),
    invalid(pg + gql + `const Book = ${relation('"author.id"')}; sf.connect(null, Book, "book", "books");`),
    invalid(mongo + gql + `const Book = ${relation('"author.id"')}; sf.addNoEndpointType(Book);`),
    invalid(pg + gql + `const Book = ${relation('"author.id"')}; sf.registerCustomQuery("pick", "", null, Book, () => null); sf.connect(null, Book, "book", "books");`),
    invalid(mongo + gql + 'const Address = new ObjectType({ name: "Address", fields: () => ({ country: { type: Country, extensions: { relation: { connectionField: "country.id" } } } }) }); const Book = new ObjectType({ name: "Book", fields: () => ({ address: { type: new NonNull(new List(Address)), extensions: { relation: { embedded: true } } } }) }); sf.connect(model, Book);'),
    invalid(mongo + gql + 'const Book = new ObjectType({ name: "Book", fields: () => { return { author: { type: Author, extensions: { relation: { connectionField: "author.id" } } } }; } }); sf.connect(model, Book);'),
    invalid(mongo + 'import * as graphql from "graphql"; const { GraphQLObjectType: ObjectType } = graphql;' + `const Book = ${relation('"author.id"')}; sf.connect(model, Book);`),
  ],
});

describe('flat preset and TypeScript', () => {
  it('bounds forward alias traversal even when the original binding is called', () => {
    const aliases = Array.from({ length: 3000 }, (_, index) => `const a${index + 1} = a${index};`).join('\n');
    const code = "import { configureQueryLimits as a0 } from '@simtlix/simfinity-core';\n" + aliases + '\na0({ maxPageSize: 0 });';
    assert.deepEqual(new Linter().verify(code, [plugin.configs['recommended-3.8']]), []);
  });
  it('exports exactly eight errors and the explicit 3.8 preset', () => {
    assert.equal(Object.keys(plugin.rules).length, 8);
    assert.deepEqual(Object.keys(plugin.configs), ['recommended-3.8']);
    assert.ok(Object.values(plugin.configs['recommended-3.8'].rules).every(level => level === 'error'));
    for (const rule of Object.values(plugin.rules)) {
      assert.equal(rule.meta.fixable, undefined);
      assert.equal(rule.meta.hasSuggestions, undefined);
    }
  });
  it('parses TS assertions without loading application code', () => {
    const config = { ...plugin.configs['recommended-3.8'], files: ['**/*.ts'], languageOptions: { parser } };
    const code = query + 'const cap = 0 as const; limit({ maxPageSize: cap } satisfies Options); throw new Error("must not execute");';
    const messages = new Linter().verify(code, [config], { filename: 'app.ts' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].ruleId, 'simfinity/valid-query-limits');
    assert.equal(messages[0].line, 2);
  });
});

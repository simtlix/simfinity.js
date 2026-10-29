import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import rule from '../src/rules/no-schema-cloning.js';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
const imports = `import * as api from '@simtlix/simfinity-js';
import { buildClientSchema, introspectionFromSchema, GraphQLSchema, graphqlSync, getIntrospectionQuery } from 'graphql';
import { mapSchema } from '@graphql-tools/utils';
const schema = api.createSchema();\n`;
tester.run('same-process schema reconstruction', rule, {
  valid: [
    imports + 'buildClientSchema(remoteData);',
    imports + 'buildClientSchema(introspectionFromSchema(independentSchema));',
    imports + 'new GraphQLSchema(schema.toConfig());',
    imports + 'function f(schema) { buildClientSchema(introspectionFromSchema(schema)); }',
    imports + 'function f(buildClientSchema) { buildClientSchema(introspectionFromSchema(schema)); }',
    imports + 'const data = introspectionFromSchema(schema); mutate(data); buildClientSchema(data);',
    imports + 'const data = introspectionFromSchema(schema); buildClientSchema({ ...data, __schema: external });',
    imports + 'buildClientSchema(customIntrospect(schema));',
    imports + 'const before = externalSchema; buildClientSchema(introspectionFromSchema(before));',
    imports + 'buildClientSchema(graphqlSync({ schema, source: customQuery }).data);',
    imports + 'buildClientSchema(graphqlSync({ schema: other, source: getIntrospectionQuery() }).data);',
    imports + 'buildClientSchema(graphqlSync({ ...options, schema, source: getIntrospectionQuery() }).data);',
  ],
  invalid: [
    { code: imports + 'buildClientSchema(introspectionFromSchema(schema));', errors: [{ messageId: 'introspection' }] },
    { code: imports + 'const data = introspectionFromSchema(schema); const again = data; buildClientSchema(again);', errors: [{ messageId: 'introspection' }] },
    { code: imports + 'const introspect = introspectionFromSchema; const rebuild = buildClientSchema; rebuild(introspect(schema), { assumeValid: true });', errors: [{ messageId: 'introspection' }] },
    { code: imports + 'mapSchema(new GraphQLSchema(schema.toConfig()), {});', errors: [{ messageId: 'invalid' }] },
    { code: imports + 'const copy = new GraphQLSchema(schema.toConfig()); buildClientSchema(introspectionFromSchema(copy));', errors: [{ messageId: 'introspection' }] },
    { code: imports + 'const data = graphqlSync({ schema, source: getIntrospectionQuery() }).data; buildClientSchema(data);', errors: [{ messageId: 'introspection' }] },
    { code: imports + 'buildClientSchema(graphqlSync({ schema, source: getIntrospectionQuery({ descriptions: false }) }).data);', errors: [{ messageId: 'introspection' }] },
  ],
});

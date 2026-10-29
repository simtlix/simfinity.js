import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import rule from '../src/rules/valid-connection-field.js';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
const gql = "import { GraphQLObjectType as O, GraphQLList as L, GraphQLString as S } from 'graphql';";
const sql = "import { createPostgres } from '@simtlix/simfinity-postgres'; const sf = createPostgres();";
const mongo = "import * as sf from '@simtlix/simfinity-js';";
const strict = "import { createRuntime } from '@simtlix/simfinity-core'; import { createMongoAdapter } from '@simtlix/simfinity-js'; const sf = createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }));";
const source = (runtime, extra = '', extensions = '', link = '') => `${gql}${runtime}
const Child = new O({ name: 'Child', fields: { label: { type: S } } });
const Owner = new O({ name: 'Owner', fields: { children: { type: new L(Child), extensions: { relation: { ${link} }, ${extensions} }, ${extra} } } });
sf.connect(null, Owner, 'owner', 'owners');`;

tester.run('storage missing child links', rule, {
  valid: [
    `${gql}${sql}
const Child = new O({ name: 'Child', fields: { label: { type: S, extensions: { relation: { connectionField: 'unused.path' } } } } });
const Owner = new O({ name: 'Owner', fields: { child: { type: Child, extensions: { relation: {} } } } });
sf.connect(null, Owner, 'owner', 'owners');`,
    source(mongo, 'resolve: () => []', 'readOnly: true'),
    source(mongo, '', 'readOnly: true'),
    source(mongo, 'resolve: () => []'),
    source(sql, 'resolve: () => []', 'readOnly: true', "connectionField: ' '"),
    source(sql, 'resolve: () => []', 'readOnly: true', 'connectionField: dynamic'),
    source(sql, 'resolve: () => []', 'readOnly: true', 'embedded: mode'),
    source(strict.replace("'transactional'", 'mode'), 'resolve: () => []', 'readOnly: true'),
  ],
  invalid: [
    ...[sql, strict].map(runtime => ({
      code: `${gql}${runtime}
const Child = new O({ name: 'Child', fields: () => ({ owner: { type: Owner, extensions: { relation: { connectionField: 'broken.path' } } } }) });
const Owner = new O({ name: 'Owner', fields: { child: { type: Child, extensions: { relation: {} } } } });
sf.connect(null, Owner, 'owner', 'owners');`,
      errors: [{ messageId: 'invalid' }],
    })),
    ...[sql, strict].flatMap(runtime => [
      source(runtime, '', 'readOnly: true'),
      source(runtime, 'resolve: () => []'),
      source(runtime, 'resolve: () => []', 'readOnly: true'),
    ].map(code => ({ code, errors: [{ messageId: 'storageMissingConnection' }] }))),
    { code: source(sql), errors: [{ messageId: 'missing' }] },
    { code: source(sql, '', '', "connectionField: 'owner.id'"), errors: [{ messageId: 'invalid' }] },
  ],
});

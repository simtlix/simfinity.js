import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import plugin from '../src/index.js';

const gql = `import { GraphQLObjectType as Obj, GraphQLString as Str, GraphQLList as List, GraphQLNonNull as NN, GraphQLScalarType as Scalar } from 'graphql';`;
const lint = code => new Linter().verify(gql + code, [plugin.configs['recommended-3.8']]);

test('a mutated runtime type view cannot retain stale local empty-input facts', () => {
  for (const read of ["api.getType('Empty')", "api.getRegistrations().find(reg=>reg.gqltype.name==='Empty').gqltype"]) {
    const code=`import { createRuntime } from '@simtlix/simfinity-core'; const api=createRuntime(adapter);
const Empty=new Obj({name:'Empty',fields:{stamp:{type:Str,extensions:{readOnly:true}}}});
const Owner=new Obj({name:'Owner',fields:{value:{type:new NN(Empty),extensions:{relation:{embedded:true}}}}});
api.addNoEndpointType(Empty);api.connect(null,Owner);
${read}.getFields().stamp.extensions.readOnly=false; api.createSchema();`;
    assert.deepEqual(lint(code),[]);
  }
});

test('shared runtimes and boxed getter/reflection views invalidate mutable shape proofs', () => {
  const declarations=`import { createRuntime } from '@simtlix/simfinity-core'; const api=createRuntime(adapter); const first=createRuntime(adapter);
const Empty=new Obj({name:'Empty',fields:{stamp:{type:Str,extensions:{readOnly:true}}}});
const Owner=new Obj({name:'Owner',fields:{value:{type:new NN(Empty),extensions:{relation:{embedded:true}}}}});
first.addNoEndpointType(Empty);api.addNoEndpointType(Empty);api.connect(null,Owner);`;
  for(const change of [
    "first.getType('Empty').getFields().stamp.extensions.readOnly=false;",
    "const target=api.getType('Empty');const box={target};box.target.getFields().stamp.extensions.readOnly=false;",
    "const fields=Empty.getFields();const box={fields};box.fields.stamp.extensions.readOnly=false;",
    "const fields=Empty.getFields();const box=[fields];box[0].stamp.extensions.readOnly=false;",
    "const field=Empty.getFields().stamp;const box={field};box.field.extensions.readOnly=false;",
    "const fields=Empty.toConfig().fields;const box={fields};box.fields.stamp.extensions.readOnly=false;",
  ]) assert.deepEqual(lint(declarations+change+'api.createSchema();'),[],change);
});

test('a schema getter exposes the same mutable model types across runtimes', () => {
  const code=`import { createRuntime } from '@simtlix/simfinity-core'; const first=createRuntime(adapter); const second=createRuntime(adapter);
const Empty=new Obj({name:'Empty',fields:{stamp:{type:Str,extensions:{readOnly:true}}}});
const Owner=new Obj({name:'Owner',fields:{value:{type:new NN(Empty),extensions:{relation:{embedded:true}}}}});
first.addNoEndpointType(Empty);first.connect(null,Owner);const schema=first.createSchema(undefined,[]);
schema.getType('Empty').getFields().stamp.extensions.readOnly=false;
second.addNoEndpointType(Empty);second.connect(null,Owner);second.createSchema();`;
  assert.deepEqual(lint(code),[]);
});

test('getter mutations invalidate the existing connection rule too', () => {
  const code=`import { createRuntime } from '@simtlix/simfinity-core'; const api=createRuntime(adapter);
const Child=new Obj({name:'Child',fields:{text:{type:Str}}});
const Owner=new Obj({name:'Owner',fields:{children:{type:new List(Child),extensions:{relation:{}}}}});
api.addNoEndpointType(Child);api.connect(null,Owner);
api.getType('Owner').getFields().children.extensions.relation.connectionField='owner';api.createSchema();`;
  assert.deepEqual(lint(code),[]);
});

test('all facade scalar re-exports retain validated base provenance', () => {
  for (const module of ['core','js','sql','postgres']) {
    const code=`import { createValidatedScalar as validate } from '@simtlix/simfinity-${module}';
import { createPostgres } from '@simtlix/simfinity-postgres'; const api=createPostgres();
const Base=new Scalar({name:'Unmapped',serialize:x=>x}); const factory=validate;
const Wrapped=factory('Wrapped','',Base,x=>true);
const Owner=new Obj({name:'Owner',fields:{value:{type:Wrapped}}});api.connect(null,Owner);`;
    assert.deepEqual(lint(code).map(message=>message.messageId),['fieldScalarStorage'],module);
  }
});

test('SQL runtime scalar namespaces and facade scalar namespaces retain their bases', () => {
  for(const [imported, scalar] of [
    ["import * as sf from '@simtlix/simfinity-postgres';", 'sf.scalars.PositiveIntScalar'],
    ["import { createPostgres } from '@simtlix/simfinity-postgres'; const sf=createPostgres();", 'sf.scalars.createBoundedIntScalar(\'Positive\',1,10)'],
    ["import { createSQL } from '@simtlix/simfinity-sql'; const sf=createSQL({plugin});", 'sf.scalars.PositiveIntScalar'],
  ]) assert.deepEqual(lint(`${imported} const Owner=new Obj({name:'Owner',fields:{id:{type:${scalar}}}});sf.connect(null,Owner);`).map(message=>message.messageId),['storageIdentity']);
});

test('a validated-scalar container cannot hide mutation of its base', () => {
  const code=`import { createValidatedScalar, createRuntime } from '@simtlix/simfinity-core';
import { createPostgres } from '@simtlix/simfinity-postgres'; const api=createPostgres();
const Base=new Scalar({name:'Unmapped',serialize:x=>x});const Wrapped=createValidatedScalar('Wrapped','',Base,x=>true);
Wrapped.baseScalarType.name='String';
const Owner=new Obj({name:'Owner',fields:{value:{type:Base}}});api.connect(null,Owner);`;
  assert.deepEqual(lint(code),[]);
});

test('exhausted call budgets cannot retain stale storage or connection facts', () => {
  for (const [fields, change] of [
    ['id:{type:new Scalar({name:"Int",serialize:x=>x})}', "api.getType('Owner').getFields().id.type=Str;"],
    ["children:{type:new List(Child),extensions:{relation:{}}}", "api.getType('Owner').getFields().children.extensions.relation.connectionField='owner';"],
  ]) {
    const code = `import { createPostgres } from '@simtlix/simfinity-postgres';const api=createPostgres();
const Child=new Obj({name:'Child',fields:{text:{type:Str}}});
const Owner=new Obj({name:'Owner',fields:{${fields}}});api.connect(null,Owner);
${change}const unrelated=()=>{};${'unrelated();'.repeat(2010)}api.connect(null,Owner);api.createSchema();`;
    assert.deepEqual(lint(code), []);
  }
});

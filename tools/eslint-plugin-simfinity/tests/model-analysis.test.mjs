import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import { buildModelGraph } from '../src/model-analysis.js';

const imports = `import { createRuntime } from '@simtlix/simfinity-core';
import { createMongoAdapter } from '@simtlix/simfinity-js';
import { createPostgres } from '@simtlix/simfinity-postgres';
import * as mongo from '@simtlix/simfinity-js';
import { GraphQLObjectType as Obj, GraphQLList as List, GraphQLNonNull as NN, GraphQLString as Str, GraphQLScalarType as Scalar } from 'graphql';
`;
const graphOf = code => {
  let graph;
  const linter = new Linter();
  const messages = linter.verify(imports + code, [{ plugins: { test: { rules: { graph: {
    create(context) { return { 'Program:exit'() { graph = buildModelGraph(context); } }; },
  } } } }, rules: { 'test/graph': 'error' } }]);
  assert.deepEqual(messages, []);
  return graph;
};

test('interns runtime identity, engine and static storage modes', () => {
  const graph = graphOf(`const a=createRuntime(createMongoAdapter({referentialIntegrity:'transactional'}));
const b=createPostgres(); const alias=a;
const T=new Obj({name:'T',fields:{name:{type:Str}}});
alias.connect(null,T); b.connect(null,T); mongo.connect(null,T); a.createSchema(); b.createSchema();`);
  assert.equal(graph.registrations.length, 3);
  const [a,b,m] = graph.registrations.map(reg => reg.runtime);
  assert.equal(a.engine,'mongo'); assert.equal(a.integrity,'transactional');
  assert.equal(b.engine,'postgres'); assert.equal(m.engine,'mongo');
  assert.equal(graph.metadata(a),true); assert.equal(graph.metadata(m),false);
  assert.equal(graph.builds[0].runtime,a); assert.notEqual(a,b);
  assert.equal(graph.closed(graph.builds[0]),true);
});

test('preserves wrappers, pure field thunks, metadata unknowns and named identities', () => {
  const graph = graphOf(`const rt=createRuntime(adapter);
const Child=new Obj({name:'Child',fields:{}});
const T=new Obj({name:'T',fields:()=>({children:{type:new NN(new List(new NN(Child))),extensions:{relation:{connectionField:'owner'},readOnly:flag},resolve:()=>[]}})});
rt.connect(null,T); rt.addNoEndpointType(Child);`);
  const field = graph.registrations[0].type.fields.get('children');
  const shape=graph.shape(field.type);
  assert.equal(shape.listDepth,1); assert.equal(shape.nonNull,true); assert.equal(shape.itemNonNull,true);
  assert.equal(shape.named,graph.registrations[1].type);
  assert.equal(field.readOnly.known,false); assert.equal(field.resolve.known,true);
  assert.equal(field.virtual,false); assert.equal(field.connection.value,'owner');
});

test('registers by name with ordering and rejects incomplete absence proofs', () => {
  const graph = graphOf(`const rt=createRuntime(adapter); const T=new Obj({name:'T',fields:{}});
const Alias=new Obj({name:'T',fields:{}}); rt.connect(null,T); rt.createSchema(); rt.addNoEndpointType(Alias); rt.createSchema();`);
  assert.equal(graph.registrationsFor(graph.builds[0].runtime,graph.builds[0].node).length,1);
  assert.equal(graph.registrationsFor(graph.builds[1].runtime,graph.builds[1].node)[0].type,graph.registrations[1].type);
  for (const code of [
    'const rt=createRuntime(adapter); if(flag) rt.connect(null,T); rt.createSchema();',
    'const rt=createRuntime(adapter); rt.connect(null,unknown); rt.createSchema();',
    'const rt=createRuntime(adapter); function register(){rt.connect(null,T)} register(); rt.createSchema();',
    'mongo.createSchema();',
  ]) {
    const incomplete=graphOf(`const T=new Obj({name:'T',fields:{}});${code}`);
    assert.equal(incomplete.closed(incomplete.builds[0]),false);
  }
});

test('distinguishes metadata entities from generated Mongo no-endpoint models', () => {
  const graph=graphOf(`const rt=createRuntime(createMongoAdapter());
const Value=new Obj({name:'Value',fields:{text:{type:Str}}});
const Child=new Obj({name:'Child',fields:{text:{type:Str}}});
const Root=new Obj({name:'Root',fields:{child:{type:Child,extensions:{relation:{connectionField:'childId'}}},value:{type:Value,extensions:{relation:{embedded:true}}}}});
rt.addNoEndpointType(Value); rt.addNoEndpointType(Child); rt.connect(null,Root);`);
  const regs=graph.registrations;
  assert.equal(graph.generated(regs[0],regs),false); assert.equal(graph.generated(regs[1],regs),true);
  assert.equal(graph.generated(regs[2],regs),true);
  assert.deepEqual([...graph.entities(regs[0].runtime,regs)].map(t=>t.name).sort(),['Child','Root']);
});

test('entity closure discovers references inside embedded values without promoting the value', () => {
  const graph=graphOf(`const rt=createPostgres();
const Target=new Obj({name:'Target',fields:{name:{type:Str}}});
const Value=new Obj({name:'Value',fields:{target:{type:Target,extensions:{relation:{connectionField:'target'}}}}});
const Root=new Obj({name:'Root',fields:{value:{type:Value,extensions:{relation:{embedded:true}}}}});
rt.addNoEndpointType(Target); rt.addNoEndpointType(Value); rt.connect(null,Root);`);
  assert.deepEqual([...graph.entities(graph.registrations[0].runtime)].map(t=>t.name).sort(),['Root','Target']);
});

test('scalar hints retain identities and reject unknown mutation or late hints', () => {
  const graph=graphOf(`const rt=createRuntime(createMongoAdapter());
const S=new Scalar({name:'Custom',serialize:x=>x}); S.baseScalarType=Str;
const T=new Obj({name:'T',fields:{x:{type:S}}}); rt.connect(null,T); rt.createSchema();`);
  const scalar=graph.registrations[0].type.fields.get('x').type;
  assert.equal(scalar.base.name,'String'); assert.equal(scalar.base.builtin,true);
  const changed=graphOf(`const rt=createRuntime(adapter); const T=new Obj({name:'T',fields:{}}); mutate(T); rt.connect(null,T);`);
  assert.equal(changed.registrations[0].type,null);
});

test('reflection keeps type identity without executing fields or trusting spreads', () => {
  const graph=graphOf(`const rt=createRuntime(adapter); const T=new Obj({name:'T',fields:{name:{type:Str}}});
const Copy=new Obj({...T.toConfig(),name:'Copy'}); T.getFields(); rt.connect(null,T); rt.connect(null,Copy);`);
  assert.equal(graph.registrations[0].type.name,'T');
  assert.equal(graph.registrations[1].type.kind,'object');
  assert.equal(graph.registrations[1].type.name,'Copy');
});

test('reflection and scalar hints never hide writes or unknown escapes', () => {
  for (const mutation of [
    'T.getFields().name.type=Other;',
    'const fields=T.getFields(); fields.name.type=Other;',
    'mutate(T.getFields());',
    'const fields=T.toConfig().fields; mutate(fields);',
    'const box={}; box.baseScalarType=T; mutate(box);',
    "const S=new Scalar({name:'S',serialize:x=>x}); S.baseScalarType=T; mutate(S);",
  ]) {
    const graph=graphOf(`const rt=createRuntime(adapter); const T=new Obj({name:'T',fields:{name:{type:Str}}}); ${mutation} rt.connect(null,T);`);
    assert.equal(graph.registrations[0].type === null,true,mutation);
  }
  const graph=graphOf(`const rt=createRuntime(adapter); Str.baseScalarType=Other;
const T=new Obj({name:'T',fields:{name:{type:Str}}}); rt.connect(null,T);`);
  assert.equal(graph.registrations[0].type.fields.get('name').type,null);
});

test('virtual field options use the actual 3.8 modes', () => {
  for(const mode of ["'tool'","'select'",'false','undefined']) {
    const graph=graphOf(`const rt=createRuntime(adapter); const T=new Obj({name:'T',fields:{x:{type:Str,resolve:()=>'',extensions:{virtual:{mcp:${mode}}}}}}); rt.connect(null,T);`);
    assert.equal(graph.registrations[0].type.fields.get('x').virtual,true);
  }
});

test('falsy scalar base hints explicitly terminate the storage chain', () => {
  for (const value of ['null','undefined','false','0',"''"]) {
    const graph=graphOf(`const rt=createPostgres(); const S=new Scalar({name:'Money',serialize:x=>x}); S.baseScalarType=${value};
const T=new Obj({name:'T',fields:{money:{type:S}}}); rt.connect(null,T);`);
    assert.equal(graph.registrations[0].type.fields.get('money').type.base,null,value);
  }
});

test('mutating or escaping runtime getter results invalidates local shape proofs', () => {
  for(const mutation of [
    "rt.getType('T').getFields().name.extensions.readOnly=false;",
    "const types=rt.getRegistrations(); mutate(types);",
    "const target=rt.getType('T'); target.getFields().name.extensions.readOnly=false;",
  ]) {
    const graph=graphOf(`const rt=createRuntime(adapter); const T=new Obj({name:'T',fields:{name:{type:Str,extensions:{readOnly:true}}}});
rt.connect(null,T); ${mutation} rt.createSchema();`);
    assert.equal(graph.registrations.length,0,mutation);
  }
  const named=graphOf(`import { getType, connect, createSchema } from '@simtlix/simfinity-js';
const T=new Obj({name:'T',fields:{name:{type:Str,extensions:{readOnly:true}}}}); connect(null,T);
getType('T').getFields().name.extensions.readOnly=false; createSchema();`);
  assert.equal(named.registrations.length,0);
  const read=graphOf(`const rt=createRuntime(adapter); const T=new Obj({name:'T',fields:{name:{type:Str}}});
rt.connect(null,T); rt.getModel(rt.getType('T')); rt.createSchema();`);
  assert.equal(read.registrations.length,1);
});

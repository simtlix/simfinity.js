import { GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';

const ref = (connectionField) => ({ relation: { connectionField } });
const embedded = { relation: { embedded: true } };

export const integrityFixture = ({
  prefix = 'Integrity', mode = 'transactional', controllers = {}, modelFactory, selfConnectionField = 'related_id',
} = {}) => {
  const adapter = createMongoAdapter({ referentialIntegrity: mode });
  const runtime = createRuntime(adapter);
  runtime.preventCreatingCollection(true);
  const types = {};
  types.Service = new GraphQLObjectType({
    name: `${prefix}Service`,
    fields: () => ({
      id: { type: GraphQLID }, name: { type: GraphQLString },
      related: { type: types.Service, extensions: ref(selfConnectionField) },
    }),
  });
  types.Item = new GraphQLObjectType({
    name: `${prefix}Item`,
    fields: () => ({
      title: { type: GraphQLString },
      service: { type: types.Service, extensions: ref('service_id') },
    }),
  });
  types.Detail = new GraphQLObjectType({
    name: `${prefix}Detail`,
    fields: () => ({
      title: { type: GraphQLString },
      primary: { type: types.Service, extensions: ref('primary_id') },
      items: { type: new GraphQLList(types.Item), extensions: embedded },
    }),
  });
  types.Shop = new GraphQLObjectType({
    name: `${prefix}Shop`,
    fields: () => ({
      id: { type: GraphQLID }, name: { type: GraphQLString },
      service: { type: types.Service, extensions: ref('service_id') },
      detail: { type: types.Detail, extensions: embedded },
      dotted: { type: types.Service, extensions: ref('nested.target_id') },
      details: { type: new GraphQLList(types.Detail), extensions: embedded },
      children: { type: new GraphQLList(types.Child), extensions: ref('shop') },
      notes: { type: new GraphQLList(types.Note), extensions: ref('owner_id') },
      entries: { type: new GraphQLList(types.Entry), extensions: ref('owner_id') },
      links: { type: new GraphQLList(types.Link), extensions: ref('shop_id') },
    }),
  });
  types.Child = new GraphQLObjectType({
    name: `${prefix}Child`,
    fields: () => ({
      id: { type: GraphQLID }, name: { type: GraphQLString },
      shop: { type: types.Shop, extensions: ref('shop_id') },
      service: { type: types.Service, extensions: ref('service_id') },
    }),
  });
  types.Note = new GraphQLObjectType({
    name: `${prefix}Note`,
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  types.Entry = new GraphQLObjectType({
    name: `${prefix}Entry`,
    fields: {
      id: { type: GraphQLID }, name: { type: GraphQLString }, owner_id: { type: GraphQLID },
      opaque: { type: GraphQLID },
    },
  });
  types.Link = new GraphQLObjectType({
    name: `${prefix}Link`,
    fields: () => ({
      id: { type: GraphQLID }, name: { type: GraphQLString },
      shop: { type: types.Shop, extensions: ref('shop_id') },
      service: { type: types.Service, extensions: ref('service_id') },
    }),
  });
  for (const [name, type] of Object.entries(types)) {
    if (['Item', 'Detail'].includes(name)) runtime.addNoEndpointType(type);
    else runtime.connect(modelFactory?.(type) || null, type, name.toLowerCase(), `${name.toLowerCase()}s`, controllers[name]);
  }
  const schema = runtime.createSchema();
  const models = Object.fromEntries(Object.entries(types)
    .map(([name, type]) => [name, runtime.getModel(type)]).filter(([, model]) => model));
  return { adapter, runtime, schema, models, types };
};

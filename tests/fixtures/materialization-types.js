import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString,
} from 'graphql';
import * as simfinity from '../../packages/mongodb/src/index.js';

export const buildMaterializationTypes = () => {
  const Status = new GraphQLEnumType({ name: 'MaterialStatus', values: { OPEN: {}, CLOSED: {} } });
  const Score = simfinity.createValidatedScalar('MaterialScore', 'Nonnegative score', GraphQLInt, (value) => {
    if (value < 0) throw new Error('Score must be nonnegative');
  });
  const DateTime = new GraphQLScalarType({
    name: 'DateTime',
    serialize: (value) => new Date(value).toISOString(),
    parseValue: (value) => new Date(value),
  });
  const Detail = new GraphQLObjectType({
    name: 'MaterialDetail',
    fields: { text: { type: GraphQLString } },
  });
  const Child = new GraphQLObjectType({
    name: 'MaterialChild',
    fields: () => ({
      id: { type: GraphQLID },
      text: { type: GraphQLString },
      parent: { type: Parent, extensions: { relation: { embedded: false } } },
      nullableParent: { type: Parent, extensions: { relation: { embedded: false } } },
      strictParent: { type: Parent, extensions: { relation: { embedded: false } } },
      requiredNullableParent: { type: Parent, extensions: { relation: { embedded: false } } },
    }),
  });
  const listFields = {
    tags: { type: new GraphQLNonNull(new GraphQLList(GraphQLString)), mongo: String },
    strictTags: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))), mongo: String },
    nullableTags: { type: new GraphQLList(GraphQLString), mongo: String },
    nonNullItems: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)), mongo: String },
    statuses: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Status))), mongo: String },
    scores: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Score))), mongo: Number },
    ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))), mongo: 'ObjectId' },
    dates: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DateTime))), mongo: Date },
  };
  const Parent = new GraphQLObjectType({
    name: 'MaterialParent',
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      owner: { type: Child, extensions: { relation: { embedded: false } } },
      editor: { type: Child, extensions: { relation: { embedded: false, connectionField: 'editorId' } } },
      reviewer: { type: Child, extensions: { relation: { embedded: false, connectionField: 'reviewerId' } } },
      ...Object.fromEntries(Object.entries(listFields).map(([name, field]) => [name, { type: field.type }])),
      detail: { type: new GraphQLNonNull(Detail), extensions: { relation: { embedded: true } } },
      embedded: { type: new GraphQLNonNull(new GraphQLList(Detail)), extensions: { relation: { embedded: true } } },
      strictEmbedded: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Detail))), extensions: { relation: { embedded: true } } },
      optionalEmbedded: { type: new GraphQLList(Detail), extensions: { relation: { embedded: true } } },
      optionalStrictEmbedded: { type: new GraphQLList(new GraphQLNonNull(Detail)), extensions: { relation: { embedded: true } } },
      children: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Child))), extensions: { relation: { embedded: false, connectionField: 'parent' } } },
      nullableChildren: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'nullableParent' } } },
      strictChildren: { type: new GraphQLList(new GraphQLNonNull(Child)), extensions: { relation: { embedded: false, connectionField: 'strictParent' } } },
      requiredNullableChildren: { type: new GraphQLNonNull(new GraphQLList(Child)), extensions: { relation: { embedded: false, connectionField: 'requiredNullableParent' } } },
    }),
  });
  simfinity.preventCreatingCollection(true);
  simfinity.addNoEndpointType(Detail);
  simfinity.connect(null, Child, 'materialchild', 'materialchildren');
  simfinity.connect(null, Parent, 'materialparent', 'materialparents');
  return { schema: simfinity.createSchema(), Parent, Child, Detail, listFields };
};

export const parentInput = () => ({
  title: '', tags: ['', null, 'tag'], strictTags: ['strict'], nullableTags: [null, 'nullable'],
  nonNullItems: ['item'], statuses: ['OPEN'], scores: [0, 2],
  ids: ['507f1f77bcf86cd799439011'], dates: ['2026-09-11T12:00:00.000Z'],
  detail: { text: '' }, embedded: [null, { text: '' }], strictEmbedded: [{ text: 'strict' }],
  optionalEmbedded: [null, { text: 'optional' }], optionalStrictEmbedded: [{ text: 'optional strict' }],
  children: { added: [{ text: '' }] },
  requiredNullableChildren: {},
});

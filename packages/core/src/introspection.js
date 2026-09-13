import {
  GraphQLBoolean,
  GraphQLObjectType,
  GraphQLString,
  __Field,
} from 'graphql';

// getFields() supports both lazy and already materialized introspection fields.
// Reuse the shared field on repeated module evaluation to preserve type identity.
const introspectionFields = __Field.getFields();
if (!introspectionFields.extensions) {
  const RelationType = new GraphQLObjectType({
    name: 'RelationType',
    fields: () => ({
      embedded: { type: GraphQLBoolean },
      connectionField: { type: GraphQLString },
      displayField: { type: GraphQLString },
    }),
  });

  const FieldExtensionsType = new GraphQLObjectType({
    name: 'FieldExtensionsType',
    fields: () => ({
      relation: { type: RelationType },
      stateMachine: { type: GraphQLBoolean },
      readOnly: { type: GraphQLBoolean },
    }),
  });

  introspectionFields.extensions = {
    type: FieldExtensionsType,
    name: 'extensions',
    resolve: (obj) => obj.extensions,
    args: [],
    isDeprecated: false,
  };
}

import {
  GraphQLBoolean,
  GraphQLObjectType,
  GraphQLString,
  __Field,
} from 'graphql';

const patchKey = Symbol.for('@simtlix/simfinity-core/introspection-patch');

if (!__Field[patchKey]) {
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

  const fieldTypeDefinitions = __Field._fields;
  __Field._fields = () => {
    const originalFields = fieldTypeDefinitions();
    originalFields.extensions = {
      type: FieldExtensionsType,
      name: 'extensions',
      resolve: (obj) => obj.extensions,
      args: [],
      isDeprecated: false,
    };
    return originalFields;
  };
  __Field[patchKey] = true;
}

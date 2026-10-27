import {
  GraphQLBoolean,
  GraphQLObjectType,
  GraphQLString,
  __Field,
} from 'graphql';
import { isVirtualField } from './relation-storage.js';
import { introspectionState } from './introspection-state.js';

// The object types of `__Field.extensions`: FieldExtensionsType and the RelationType of its
// `relation` field, under the given names.
const createFieldMetadataType = (extensionsName, relationName) => {
  const RelationType = new GraphQLObjectType({
    name: relationName,
    fields: () => ({
      embedded: { type: GraphQLBoolean },
      connectionField: { type: GraphQLString },
      displayField: { type: GraphQLString },
    }),
  });

  return new GraphQLObjectType({
    name: extensionsName,
    fields: () => ({
      relation: { type: RelationType },
      stateMachine: { type: GraphQLBoolean },
      readOnly: { type: GraphQLBoolean },
    }),
  });
};

// The metadata `__Field.extensions` returns: the field's own extensions, except that a virtual field
// reads `readOnly: true`, which virtual implies. The metadata types keep their fields, so schemas
// without virtual fields introspect exactly as before; client metadata about virtual fields belongs
// in a descriptor of its own (#101), not in this process-wide extension.
const fieldMetadataOf = (field) => (isVirtualField(field)
  ? { ...field.extensions, readOnly: true }
  : field.extensions);

// getFields() supports both lazy and already materialized introspection fields.
// Reuse the shared field on repeated module evaluation to preserve type identity.
const introspectionFields = __Field.getFields();
if (!introspectionState().disabled && !introspectionFields.extensions) {
  introspectionFields.extensions = {
    type: createFieldMetadataType('FieldExtensionsType', 'RelationType'),
    name: 'extensions',
    resolve: fieldMetadataOf,
    args: [],
    isDeprecated: false,
  };
}

// Set on the shared extensions field, by any evaluation of this module, once a Simfinity schema
// contains the metadata types; their names do not change after that.
const NAMES_FIXED = Symbol.for('simfinity.fieldMetadataNamesFixed');
const extensionsField = () => __Field.getFields().extensions;

/** The metadata types `__Field.extensions` returns now: [FieldExtensionsType, RelationType]. */
export const fieldMetadataTypes = () => {
  if (introspectionState().disabled) return [];
  const extensionsType = extensionsField().type;
  return [extensionsType, extensionsType.getFields().relation.type];
};

export const fieldMetadataNamesFixed = () => extensionsField()?.[NAMES_FIXED] === true;

export const fixFieldMetadataNames = () => {
  if (!introspectionState().disabled) extensionsField()[NAMES_FIXED] = true;
};

// Every schema constructed afterwards, in the whole process, contains the metadata types under the
// new names. The extensions field object keeps its identity, so other evaluations of this module and
// the auth plugin, which read its type when they need it, follow the change. Returns a function that
// puts the previous type objects back, for a schema whose construction fails.
export const renameFieldMetadataTypes = (extensionsName, relationName) => {
  const field = extensionsField();
  const previous = field.type;
  field.type = createFieldMetadataType(extensionsName, relationName);
  return () => {
    field.type = previous;
  };
};

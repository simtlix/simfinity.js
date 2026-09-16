import { GraphQLObjectType, GraphQLString, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLEnumType } from 'graphql';
import { schemaFixture } from './postgres-fixtures.js';

export const sqlSchemaFixtures = () => {
  const Category = new GraphQLEnumType({ name: 'Category', values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
  const Ref = new GraphQLObjectType({ name: 'Reference', fields: { label: { type: GraphQLString } } });
  const Inline = new GraphQLObjectType({ name: 'Inline', fields: { mode: { type: Category }, labels: { type: new GraphQLList(GraphQLString) } } });
  const Item = new GraphQLObjectType({ name: 'Entry', fields: {
    code: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
    reference: { type: Ref, extensions: { relation: {} } },
    detail: { type: Inline, extensions: { relation: { embedded: true } } },
  } });
  const Tree = new GraphQLObjectType({ name: 'Tree', fields: {
    entries: { type: new GraphQLList(Item), extensions: { relation: { embedded: true } } },
    detail: { type: Inline, extensions: { relation: { embedded: true } } },
  } });
  const Root = new GraphQLObjectType({ name: 'Root', fields: {
    records: { type: new GraphQLNonNull(new GraphQLList(Tree)), extensions: { relation: { embedded: true } } },
    codes: { type: new GraphQLList(GraphQLString), extensions: { unique: true } },
    detail: { type: Inline, extensions: { relation: { embedded: true } } },
    categories: { type: new GraphQLList(new GraphQLNonNull(Category)) },
  } });
  const Long = new GraphQLObjectType({ name: 'A'.repeat(60), fields: { ['b'.repeat(60)]: { type: GraphQLID } } });
  return [
    { name: 'relations', registrations: schemaFixture(), options: { schema: 'app' } },
    { name: 'nested-null-unique-enum', registrations: [{ gqltype: Root }], options: { schema: 'an"odd\\schema' } },
    { name: 'long-identifiers', registrations: [{ gqltype: Long }], options: { schema: 'public' } },
  ];
};

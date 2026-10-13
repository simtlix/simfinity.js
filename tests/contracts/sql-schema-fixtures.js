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

/**
 * Fixtures pinned only by postgres-opt-in-schema.json, which also holds their default ('baselines') hashes,
 * so postgres-3.2-schema.json stays unchanged. 'long-maintained-root' is a maintained root whose derived
 * names reach PostgreSQL's 63-byte limit: its __guard and root __touch names are exactly 63 bytes, while
 * the owned, keys, owned __touch, root __deferred and __guard__deferred names are shortened with a hash.
 */
export const sqlSchemaOptInFixtures = () => {
  const Code = new GraphQLObjectType({ name: 'Code', fields: { code: { type: GraphQLString, extensions: { unique: true } } } });
  const Root = new GraphQLObjectType({ name: 'L'.repeat(56), fields: {
    entries: { type: new GraphQLList(Code), extensions: { relation: { embedded: true } } },
  } });
  return [
    { name: 'long-maintained-root', registrations: [{ gqltype: Root }], options: { schema: 'public' } },
  ];
};

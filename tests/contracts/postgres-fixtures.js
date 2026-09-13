import { GraphQLObjectType, GraphQLString, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLInt, GraphQLBoolean, GraphQLEnumType } from 'graphql';

export const schemaFixture = () => {
  const Tag = new GraphQLObjectType({ name: 'Tag', fields: { id: { type: GraphQLID }, label: { type: GraphQLString, extensions: { unique: true } } } });
  const Contact = new GraphQLObjectType({ name: 'Contact', fields: {
    label: { type: new GraphQLNonNull(GraphQLString) }, tag: { type: Tag, extensions: { relation: { connectionField: 'tag_id' } } },
  } });
  const Profile = new GraphQLObjectType({ name: 'Profile', fields: { bio: { type: GraphQLString } } });
  const State = new GraphQLEnumType({ name: 'State', values: { OPEN: {}, CLOSED: {} } });
  const Parent = new GraphQLObjectType({ name: 'Parent', fields: () => ({
    id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) },
    children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parent_id' } } },
    contacts: { type: new GraphQLList(new GraphQLNonNull(Contact)), extensions: { relation: { embedded: true } } },
    profile: { type: Profile, extensions: { relation: { embedded: true } } },
    ranks: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    active: { type: GraphQLBoolean },
    state: { type: State },
    states: { type: new GraphQLList(State) },
  }) });
  const Child = new GraphQLObjectType({ name: 'Child', extensions: { indexes: [{ fields: ['parent', 'tag'], unique: true }] }, fields: () => ({
    parent: { type: new GraphQLNonNull(Parent), extensions: { relation: { connectionField: 'parent_id' } } },
    tag: { type: new GraphQLNonNull(Tag), extensions: { relation: {} } },
  }) });
  return [{ gqltype: Parent }];
};

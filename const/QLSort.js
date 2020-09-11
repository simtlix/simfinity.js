const graphql = require('graphql');

const {
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLEnumType,
  GraphQLString,
} = graphql;

const QLSortOrder = new GraphQLEnumType({
  name: 'QLSortOrder',
  values: {
    DESC: {
      value: 'DESC',
    },
    ASC: {
      value: 'ASC',
    },
  },
});

const QLSort = new GraphQLInputObjectType({
  name: 'QLSort',
  fields: () => ({
    field: { type: new GraphQLNonNull(GraphQLString) },
    order: { type: new GraphQLNonNull(QLSortOrder) },
  }),
});

module.exports = QLSort;

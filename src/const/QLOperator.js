const graphql = require('graphql');

const { GraphQLEnumType } = graphql;

const QLOperator = new GraphQLEnumType({
  name: 'QLOperator',
  values: {
    EQ: {
      value: 'EQ',
    },
    LT: {
      value: 'LT',
    },
    GT: {
      value: 'GT',
    },
    LTE: {
      value: 'LTE',
    },
    GTE: {
      value: 'GTE',
    },
    BTW: {
      value: 'BTW',
    },
    NE: {
      value: 'NE',
    },
    IN: {
      value: 'IN',
    },
    NIN: {
      value: 'NIN',
    },
    LIKE: {
      value: 'LIKE',
    },
  },
});

module.exports = QLOperator;

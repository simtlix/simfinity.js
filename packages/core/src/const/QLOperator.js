import { GraphQLEnumType } from 'graphql';

const QLOperator = new GraphQLEnumType({
  name: 'QLOperator',
  values: {
    EQ: { value: 'EQ' },
    LT: { value: 'LT' },
    GT: { value: 'GT' },
    LTE: { value: 'LTE' },
    GTE: { value: 'GTE' },
    BTW: { value: 'BTW' },
    NE: { value: 'NE' },
    IN: { value: 'IN' },
    NIN: { value: 'NIN' },
    LIKE: { value: 'LIKE' },
    ILIKE: { value: 'ILIKE' },
    STARTS_WITH: { value: 'STARTS_WITH' },
    ISTARTS_WITH: { value: 'ISTARTS_WITH' },
    ENDS_WITH: { value: 'ENDS_WITH' },
    IENDS_WITH: { value: 'IENDS_WITH' },
    IEQ: { value: 'IEQ' },
  },
});

export default QLOperator;

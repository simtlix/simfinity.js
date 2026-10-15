import { GraphQLInt, GraphQLFloat } from 'graphql';

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;
const FLOAT_MIN = -Number.MAX_VALUE;
const FLOAT_MAX = Number.MAX_VALUE;

const INTEGER_RULE = {
  range: (amount) => ({
    $type: 'number',
    $gte: Math.max(INT_MIN, INT_MIN - amount),
    $lte: Math.min(INT_MAX, INT_MAX - amount),
  }),
  result: (path) => ({ $eq: [{ $mod: ['$' + path, 1] }, 0] }),
};
const FLOAT_RULE = {
  range: () => ({ $type: 'number', $gte: FLOAT_MIN, $lte: FLOAT_MAX }),
  result: (path, amount) => ({
    $let: {
      vars: { sum: { $add: ['$' + path, amount] } },
      in: { $and: [{ $gte: ['$$sum', FLOAT_MIN] }, { $lte: ['$$sum', FLOAT_MAX] }] },
    },
  }),
};
const INCREMENT_RULES = new Map([[GraphQLInt, INTEGER_RULE], [GraphQLFloat, FLOAT_RULE]]);

// Query $mod truncates doubles; expression $mod checks integer storage exactly.
// Float guards check the actual sum because subtracting bounds can round.
export const incrementGuard = (path, amount, scalar) => {
  const rule = INCREMENT_RULES.get(scalar);
  const numeric = {
    $and: [
      { [path]: rule.range(amount) },
      { $expr: { $cond: [{ $isNumber: '$' + path }, rule.result(path, amount), false] } },
    ],
  };
  return { $or: [{ [path]: { $exists: false } }, numeric] };
};

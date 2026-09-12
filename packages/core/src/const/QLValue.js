import { GraphQLScalarType, Kind } from 'graphql';
import SimfinityError from '../errors/simfinity.error.js';

const parseQLValue = (value) => value;

const parseLiteral = (ast) => {
  switch (ast.kind) {
    case Kind.INT: return parseInt(ast.value, 10);
    case Kind.FLOAT: return parseFloat(ast.value);
    case Kind.BOOLEAN: return ast.value === true || ast.value === 'true';
    case Kind.STRING: return ast.value;
    case Kind.NULL: return null;
    case Kind.LIST:
      return ast.values.map((item) => {
        if (item.kind === Kind.LIST) {
          throw new SimfinityError('Nested filter value lists are not supported', 'INVALID_FILTER_VALUE', 400);
        }
        return parseLiteral(item);
      });
    default:
      throw new SimfinityError('Filter values must be scalars or flat scalar lists', 'INVALID_FILTER_VALUE', 400);
  }
};

const QLValue = new GraphQLScalarType({
  name: 'QLValue',
  serialize: parseQLValue,
  parseValue: parseQLValue,
  parseLiteral,
});

export default QLValue;

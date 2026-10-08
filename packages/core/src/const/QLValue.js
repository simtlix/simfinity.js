import { GraphQLScalarType, Kind } from 'graphql';
import SimfinityError from '../errors/simfinity.error.js';

const parseQLValue = (value) => value;

// graphql-js resolves a variable that is the whole value itself, but passes a list literal such as
// [$from, $to] here with the operation's variables (undefined during validation). A variable item
// the operation leaves unset reads as null, as graphql-js reads list items of other types. An enum
// literal reads as its name, like the quoted name of an enum filter value.
const parseLiteral = (ast, variables) => {
  switch (ast.kind) {
    case Kind.INT: return parseInt(ast.value, 10);
    case Kind.FLOAT: return parseFloat(ast.value);
    case Kind.BOOLEAN: return ast.value === true || ast.value === 'true';
    case Kind.STRING:
    case Kind.ENUM: return ast.value;
    case Kind.NULL: return null;
    case Kind.VARIABLE:
      // Object.hasOwn: a variable named like an Object.prototype member is not inherited.
      return variables != null && Object.hasOwn(variables, ast.name.value) ? variables[ast.name.value] : null;
    case Kind.LIST:
      return ast.values.map((item) => {
        if (item.kind === Kind.LIST) {
          throw new SimfinityError('Nested filter value lists are not supported', 'INVALID_FILTER_VALUE', 400);
        }
        return parseLiteral(item, variables);
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
